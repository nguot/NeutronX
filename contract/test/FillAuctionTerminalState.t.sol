// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FillAuction.sol";
import { MockReactor } from "./FillAuction.t.sol";

/// Terminal-state / double-settlement matrix for FillAuction.
///
/// A `Registration` has three mutually-exclusive terminal outcomes, each setting
/// one flag and crediting `pendingReturns` exactly once:
///   • onFillSuccess        → `filled`   (refund to filler + forfeit to treasury)
///   • slash                → `slashed`  (reward to slasher + rest to treasury)
///   • releaseRegistration  → `released` (full stake back to filler)
///
/// Every one of those entry points guards on `!filled && !slashed && !released`
/// ("invalid state"). That guard is the contract's only protection against
/// paying a single staked deposit out twice — i.e. it is economic-safety logic,
/// not a cosmetic require. The happy-path tests in FillAuction.t.sol each drive a
/// registration into ONE terminal state; this file proves that once a
/// registration is in any terminal state, EVERY other settlement path (including
/// repeating the same one) reverts and credits nothing further.
///
/// Note on revert ordering: in `slash`/`releaseRegistration` the "invalid state"
/// check sits BEFORE the "too early" / "still fillable" checks, so these reverts
/// fire regardless of block height or the mocked reactor's remaining/cancelled
/// view — we don't need to roll time or tweak the reactor to reach them.
contract FillAuctionTerminalStateTest is Test {
    FillAuction public auction;
    MockReactor public reactor;

    address public treasury = makeAddr("treasury");
    address public filler   = makeAddr("filler");
    address public slasher  = makeAddr("slasher");

    bytes32 constant ORDER_HASH  = keccak256("order1");
    uint256 constant ORDER_TOTAL = 1000e6; // 1000 USDC, sBucket 0 (<$10k)
    uint256 constant FILL_AMOUNT = 400e6;  // 40% of total -> fill-ratio bucket 3
    uint256 constant DEADLINE    = 1000;
    uint256 constant STAKE       = 80e6;   // FILL_AMOUNT * 2000bps * 1x (tBucket 0)

    function setUp() public {
        reactor = new MockReactor();
        auction = new FillAuction(treasury, address(0), address(0), 0, true); // oracle-disabled (1:1)
        auction.setReactor(address(reactor));
        reactor.setAuction(address(auction));
        vm.roll(100);
    }

    function _register() internal {
        vm.deal(filler, 1 ether);
        vm.prank(filler);
        reactor.callRegister{value: STAKE}(filler, ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
    }

    // Attempt all three settlement paths and assert each reverts "invalid state".
    // `expectedFiller`/`expectedTreasury` are the pendingReturns balances credited
    // by the FIRST (legitimate) terminal action; we assert they are untouched by
    // the blocked attempts — i.e. no second payout sneaks through.
    function _assertAllSettlementsBlocked(uint256 expectedFiller, uint256 expectedTreasury) internal {
        // slash() — "invalid state" is checked before the "too early" guard.
        vm.prank(slasher);
        vm.expectRevert("invalid state");
        auction.slash(ORDER_HASH, filler);

        // releaseRegistration() — "invalid state" before the "still fillable" guard.
        // Make the order look satisfied so we can be sure it's the state flag, not
        // the fillable check, that stops it.
        reactor.setRemaining(0);
        vm.expectRevert("invalid state");
        auction.releaseRegistration(ORDER_HASH, filler);
        reactor.setRemaining(type(uint256).max); // restore the "still open" sentinel

        // onFillSuccess() — onlyReactor, so route through the mock reactor.
        vm.expectRevert("invalid state");
        reactor.callOnFillSuccess(ORDER_HASH, filler, FILL_AMOUNT);

        // No blocked path credited anything: the single payout is preserved.
        assertEq(auction.pendingReturns(filler),   expectedFiller,   "filler credited twice");
        assertEq(auction.pendingReturns(treasury), expectedTreasury, "treasury credited twice");
    }

    // ── filled is terminal ──────────────────────────────────────────────────
    function test_terminal_filled_blocksAllOtherSettlements() public {
        _register();
        reactor.callOnFillSuccess(ORDER_HASH, filler, FILL_AMOUNT);

        // D-2: refund is keyed to the filler's OWN commitment. It registered and
        // delivered FILL_AMOUNT (400e6/400e6 = 100%) -> rBucket 4 -> full refund,
        // nothing forfeited.
        uint256 refund    = STAKE;
        uint256 forfeited = 0;
        assertEq(refund + forfeited, STAKE, "filled: stake not conserved");

        _assertAllSettlementsBlocked(refund, forfeited);
    }

    // ── slashed is terminal ─────────────────────────────────────────────────
    function test_terminal_slashed_blocksAllOtherSettlements() public {
        _register();
        vm.roll(DEADLINE + auction.SLASH_WINDOW() + 1); // make it slashable
        vm.prank(slasher);
        auction.slash(ORDER_HASH, filler);

        uint256 reward     = STAKE / 10;     // 10% slasher bounty
        uint256 toTreasury = STAKE - reward; // 90% forfeited
        assertEq(reward + toTreasury, STAKE, "slashed: stake not conserved");
        assertEq(auction.pendingReturns(slasher), reward, "slasher reward wrong");

        // After slashing, no other path may settle. (filler was never credited.)
        _assertAllSettlementsBlocked(0, toTreasury);
        assertEq(auction.pendingReturns(slasher), reward, "slasher credited twice");
    }

    // ── released is terminal ────────────────────────────────────────────────
    function test_terminal_released_blocksAllOtherSettlements() public {
        _register();
        reactor.setRemaining(0); // order satisfied by someone else -> stake reclaimable
        auction.releaseRegistration(ORDER_HASH, filler);

        // Release returns the full stake to the filler, nothing to treasury.
        assertEq(auction.pendingReturns(filler), STAKE, "release should return full stake");

        _assertAllSettlementsBlocked(STAKE, 0);
    }
}
