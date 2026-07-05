// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./adversarial/AdversarialBase.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

/// B4 "test nhóm 3": the guard/timelock/rollback wrapper around setStakeConfig
/// (see DYNAMIC_STAKE_CONFIG_REFACTOR.md khối 🔑 D, D1-D4). Covers:
///  - loosening -> pending -> commit/cancel
///  - cooldown gates BOTH the immediate-apply and the queue-pending path (D3)
///  - only one pending at a time (D3)
///  - rollback is exactly one-deep, including through a committed pending (D2)
///  - rollback clears any in-flight pending (D4)
///  - MAX_DELTA_BPS + the low-fill penalty floor (D1 / #2), including the
///    gradual multi-step erosion the floor exists to stop
///  - #3: a registration's refund settles off its OWN snapshot even after the
///    live config is reshaped (different bucket COUNT) underneath it.
contract StakeConfigGuardTest is AdversarialBase {
    address guardian = makeAddr("guardian");
    address paramAdmin; // this test contract; already holds PARAM_ADMIN_ROLE via _deployCore()

    function setUp() public {
        _deployCore();
        paramAdmin = address(this);
        auction.grantRole(auction.GUARDIAN_ROLE(), guardian);
    }

    // ── loosening -> pending -> commit/cancel ──

    function test_setStakeConfig_queuesPending_whenLoosening() public {
        DynamicStakeLib.StakeConfig memory c = _defaultStakeConfig();
        c.collateralRate[0] = 1800; // -10% vs default 2000: loosening, within maxDelta

        auction.setStakeConfig(c);

        // Not applied yet — still the default value — but IS queued.
        assertEq(auction.stakeConfig().collateralRate[0], 2000);
        assertEq(auction.pendingConfig().collateralRate[0], 1800);
        assertEq(auction.pendingEffective(), block.timestamp + auction.LOOSEN_DELAY());
    }

    function test_commitPending_revert_beforeDelay() public {
        DynamicStakeLib.StakeConfig memory c = _defaultStakeConfig();
        c.collateralRate[0] = 1800;
        auction.setStakeConfig(c);

        vm.expectRevert(FillAuction.StillPending.selector);
        auction.commitPending();
    }

    function test_commitPending_succeeds_afterDelay() public {
        DynamicStakeLib.StakeConfig memory c = _defaultStakeConfig();
        c.collateralRate[0] = 1800;
        auction.setStakeConfig(c);

        vm.warp(block.timestamp + auction.LOOSEN_DELAY());
        auction.commitPending();

        assertEq(auction.stakeConfig().collateralRate[0], 1800);
        // Pending is cleared after commit (sentinel: collateralRate.length == 0).
        assertEq(auction.pendingConfig().collateralRate.length, 0);
    }

    function test_setStakeConfig_revert_pendingExists() public {
        DynamicStakeLib.StakeConfig memory c = _defaultStakeConfig();
        c.collateralRate[0] = 1800; // queues a pending
        auction.setStakeConfig(c);

        vm.warp(block.timestamp + auction.CHANGE_COOLDOWN()); // clear cooldown so PendingExists is the ONLY blocker left
        DynamicStakeLib.StakeConfig memory c2 = _defaultStakeConfig();
        c2.collateralRate[1] = 5500; // an unrelated, otherwise-valid tighten
        vm.expectRevert(FillAuction.PendingExists.selector);
        auction.setStakeConfig(c2);
    }

    function test_cancelPendingConfig_revert_notGuardian() public {
        DynamicStakeLib.StakeConfig memory c = _defaultStakeConfig();
        c.collateralRate[0] = 1800;
        auction.setStakeConfig(c);

        bytes32 role = auction.GUARDIAN_ROLE();
        vm.prank(paramAdmin); // PARAM_ADMIN is not GUARDIAN
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, paramAdmin, role
        ));
        auction.cancelPendingConfig();
    }

    function test_cancelPendingConfig_clearsPending() public {
        DynamicStakeLib.StakeConfig memory c = _defaultStakeConfig();
        c.collateralRate[0] = 1800;
        auction.setStakeConfig(c);

        vm.prank(guardian);
        auction.cancelPendingConfig();

        assertEq(auction.pendingConfig().collateralRate.length, 0);
        assertEq(auction.stakeConfig().collateralRate[0], 2000); // untouched

        // Cancelling frees up the single pending slot for a new change.
        vm.warp(block.timestamp + auction.CHANGE_COOLDOWN());
        DynamicStakeLib.StakeConfig memory c2 = _defaultStakeConfig();
        c2.collateralRate[0] = 2100; // tighten, applies immediately
        auction.setStakeConfig(c2);
        assertEq(auction.stakeConfig().collateralRate[0], 2100);
    }

    // ── cooldown gates BOTH paths (D3) ──

    function test_setStakeConfig_revert_cooldown_afterImmediateApply() public {
        DynamicStakeLib.StakeConfig memory c = _defaultStakeConfig();
        c.collateralRate[0] = 2100; // tighten, applies immediately, sets lastChange
        auction.setStakeConfig(c);

        DynamicStakeLib.StakeConfig memory c2 = _defaultStakeConfig();
        c2.collateralRate[1] = 5500;
        vm.expectRevert(FillAuction.Cooldown.selector);
        auction.setStakeConfig(c2); // no warp: still inside CHANGE_COOLDOWN
    }

    function test_setStakeConfig_revert_cooldown_afterQueueingPending() public {
        DynamicStakeLib.StakeConfig memory c = _defaultStakeConfig();
        c.collateralRate[0] = 1800; // loosening, queues pending, ALSO sets lastChange (D3 fix)
        auction.setStakeConfig(c);

        // Cancel so the failure below is unambiguously "cooldown", not "pending exists".
        vm.prank(guardian);
        auction.cancelPendingConfig();

        DynamicStakeLib.StakeConfig memory c2 = _defaultStakeConfig();
        c2.collateralRate[1] = 5500;
        vm.expectRevert(FillAuction.Cooldown.selector);
        auction.setStakeConfig(c2); // no warp: queuing a pending must ALSO have started the cooldown
    }

    // ── MAX_DELTA_BPS ──

    function test_setStakeConfig_revert_collateralDeltaTooLarge() public {
        DynamicStakeLib.StakeConfig memory c = _defaultStakeConfig();
        c.collateralRate[0] = 3000; // +50% vs default 2000, exceeds MAX_DELTA_BPS (20%)
        vm.expectRevert("collateral delta too large");
        auction.setStakeConfig(c);
    }

    // ── one-deep rollback, INCLUDING through a committed pending (D2) ──

    function test_rollback_revert_noPreviousConfig() public {
        vm.prank(guardian);
        vm.expectRevert(FillAuction.NoPreviousConfig.selector);
        auction.rollback();
    }

    function test_rollback_restoresOneStepBack_notFurther() public {
        // D0 (constructor default): collateralRate[0] == 2000.
        assertEq(auction.stakeConfig().collateralRate[0], 2000);

        // D1: tighten +10%, applies immediately. _previousConfig <- D0.
        DynamicStakeLib.StakeConfig memory c1 = _defaultStakeConfig();
        c1.collateralRate[0] = 2200;
        auction.setStakeConfig(c1);
        assertEq(auction.stakeConfig().collateralRate[0], 2200);

        // D2: loosen from D1 (2200 -> 1800, within 20% of 2200), queued as pending.
        vm.warp(block.timestamp + auction.CHANGE_COOLDOWN());
        DynamicStakeLib.StakeConfig memory c2 = _defaultStakeConfig();
        c2.collateralRate[0] = 1800;
        auction.setStakeConfig(c2);

        // Commit D2. _apply() must snapshot _previousConfig <- D1 (2200) here,
        // NOT leave it at D0 — this is exactly the D2 bugfix.
        vm.warp(block.timestamp + auction.LOOSEN_DELAY());
        auction.commitPending();
        assertEq(auction.stakeConfig().collateralRate[0], 1800);

        // rollback() must restore D1 (2200) — the config right before the LAST
        // _apply — never D0 (2000), which would mean guardian can reach further
        // back than one step.
        vm.prank(guardian);
        auction.rollback();
        assertEq(auction.stakeConfig().collateralRate[0], 2200);
    }

    function test_rollback_secondCallIsNoOp() public {
        DynamicStakeLib.StakeConfig memory c1 = _defaultStakeConfig();
        c1.collateralRate[0] = 2200;
        auction.setStakeConfig(c1); // _previousConfig <- D0 (2000)

        vm.startPrank(guardian);
        auction.rollback();
        assertEq(auction.stakeConfig().collateralRate[0], 2000);

        // _previousConfig itself is untouched by rollback(), so a second call
        // just re-applies the same value — never walks further into history.
        auction.rollback();
        assertEq(auction.stakeConfig().collateralRate[0], 2000);
        vm.stopPrank();
    }

    function test_rollback_clearsPending() public {
        DynamicStakeLib.StakeConfig memory c1 = _defaultStakeConfig();
        c1.collateralRate[0] = 2200;
        auction.setStakeConfig(c1); // establishes a _previousConfig to roll back to

        vm.warp(block.timestamp + auction.CHANGE_COOLDOWN());
        DynamicStakeLib.StakeConfig memory c2 = _defaultStakeConfig();
        c2.collateralRate[0] = 1800; // loosening vs current (2200) -> queued
        auction.setStakeConfig(c2);

        vm.prank(guardian);
        auction.rollback();

        assertEq(auction.pendingConfig().collateralRate.length, 0, "rollback must clear an in-flight pending");
    }

    // ── #2 / D1: penalty floor defends against GRADUAL multi-step erosion ──
    // (each individual step stays within MAX_DELTA_BPS, but the floor still
    // eventually blocks driving the low-fill "sniping fee" toward zero).
    function test_setStakeConfig_revert_penaltyFloorBreached_afterGradualLoosening() public {
        bool reverted;
        bytes memory revertData;

        for (uint256 i = 0; i < 30 && !reverted; i++) {
            DynamicStakeLib.StakeConfig memory c = auction.stakeConfig();
            // Grow bucket-0's whole row toward the MAX_DELTA_BPS boundary each
            // step (same contraction applied to every cell keeps the row
            // monotonic); cell 4 (100% fill) is left at its fixed 10000.
            for (uint256 r = 0; r < 4; r++) {
                uint256 v = uint256(c.refundTable[r]) * 8 / 10 + 2000;
                if (v > 10000) v = 10000;
                c.refundTable[r] = uint32(v);
            }

            vm.warp(block.timestamp + auction.CHANGE_COOLDOWN());
            try auction.setStakeConfig(c) {
                DynamicStakeLib.StakeConfig memory pending = auction.pendingConfig();
                if (pending.collateralRate.length != 0) {
                    vm.warp(block.timestamp + auction.LOOSEN_DELAY());
                    auction.commitPending();
                }
            } catch (bytes memory reason) {
                reverted = true;
                revertData = reason;
            }
        }

        assertTrue(reverted, "penalty floor must eventually block further gradual loosening");
        assertEq(revertData, abi.encodeWithSignature("Error(string)", "penalty floor breached"));
    }

    // ── #3: registration snapshot survives a live reshape of the ratio buckets ──

    function test_registrationSnapshot_survivesRatioBucketReshape() public {
        address swapper = makeAddr("swapper3");
        address fillerX = makeAddr("fillerX");

        PartialFillReactor.SignedOrder memory order =
            _signed(_orderInfo(swapper, 4 ether, 0, START_PRICE, 0, 1, 100_000));

        _fundSwapper(swapper, 4 ether);
        _fundFiller(fillerX, 1_000_000e6, 10 ether);

        // Register for the full ceiling under the CURRENT (5 fill-ratio bucket) config.
        _register(fillerX, order, 4 ether);

        // PARAM_ADMIN reshapes ratioThresholds from 4 thresholds (5 buckets) to
        // 6 thresholds (7 buckets) — a bucket-COUNT change, not just a value
        // tweak. Keep collateral/refund economics close to identical at the
        // sampling grid so this is accepted (whichever branch it takes).
        DynamicStakeLib.StakeConfig memory c = auction.stakeConfig();
        c.ratioThresholds = new uint256[](6);
        c.ratioThresholds[0] = 150;
        c.ratioThresholds[1] = 200;
        c.ratioThresholds[2] = 1000;
        c.ratioThresholds[3] = 3000;
        c.ratioThresholds[4] = 7000;
        c.ratioThresholds[5] = 8000;
        // S=4, R=7 now -> refundTable must be 28 long. Reuse each old row's
        // shape, duplicating column 0 to fill the new extra column so every
        // row stays non-decreasing and still ends at 10000.
        uint32[] memory oldTable = c.refundTable; // old S*5 table (still the old length here)
        uint32[] memory newTable = new uint32[](28);
        for (uint256 s = 0; s < 4; s++) {
            newTable[s * 7 + 0] = oldTable[s * 5 + 0];
            newTable[s * 7 + 1] = oldTable[s * 5 + 0];
            newTable[s * 7 + 2] = oldTable[s * 5 + 1];
            newTable[s * 7 + 3] = oldTable[s * 5 + 2];
            newTable[s * 7 + 4] = oldTable[s * 5 + 3];
            newTable[s * 7 + 5] = oldTable[s * 5 + 3];
            newTable[s * 7 + 6] = oldTable[s * 5 + 4];
        }
        c.refundTable = newTable;

        try auction.setStakeConfig(c) {
            DynamicStakeLib.StakeConfig memory pending = auction.pendingConfig();
            if (pending.collateralRate.length != 0) {
                vm.warp(block.timestamp + auction.LOOSEN_DELAY());
                auction.commitPending();
            }
        } catch {
            // If the sampling grid rejects this particular reshape as too big a
            // swing, force it through via two smaller steps isn't needed for
            // THIS test's purpose (proving settlement uses the snapshot) — fail
            // loudly instead of silently passing on an unreached code path.
            fail();
        }

        // Live config now has 7 fill-ratio buckets; the registration's snapshot
        // still has 5. Fully honouring the commitment must NOT revert (would
        // indicate the snapshot leaked live-bucket indices into settlement)
        // and must refund in full (>=70% delivered under the ORIGINAL bucket
        // count the filler registered under).
        vm.prank(fillerX);
        reactor.executePartialChunk(order, 4 ether);

        // _register() posts EXACTLY the required stake as msg.value (no excess),
        // so a full refund (nothing forfeited) means pendingReturns == stake.
        // collateralRate/sizeThresholds/timeThresholds/timeMult are untouched by
        // this reshape, so re-querying stake now still matches what was paid.
        uint256 stake = _stake(order.info, 4 ether);
        assertEq(auction.pendingReturns(fillerX), stake, "full commitment must fully refund off the ORIGINAL snapshot");
    }
}
