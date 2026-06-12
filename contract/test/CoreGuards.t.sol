// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./adversarial/AdversarialBase.sol";

/// Branch-coverage batch for the protective shell around the two core contracts:
/// owner/access guards, one-time setters, L-2 input-bound checks, and the
/// `minFillBps` floor. These are the revert arms that high statement-coverage
/// (happy-path) tests leave untaken — and several (the L-2 setter bounds) are
/// audit fixes that previously shipped without a pinning test.
///
/// Harness: AdversarialBase wires a real PartialFillReactor + FillAuction with an
/// oracle-disabled auction (factory == 0 -> notional == fill amount), so stakes
/// are deterministic. The auction's owner is this test contract (it deployed it),
/// and `reactor` is the auction's only authorized caller — so to exercise
/// `FillAuction.register`'s input guards directly we `vm.prank(address(reactor))`.
contract CoreGuardsTest is AdversarialBase {
    address swapper  = makeAddr("swapper");
    address filler   = makeAddr("filler");
    address notOwner = makeAddr("notOwner");
    address rando    = makeAddr("rando");

    bytes32 constant H        = keccak256("guard-order");
    uint256 constant DEADLINE = 100_000;

    function setUp() public {
        _deployCore();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  FillAuction — owner-only setters & one-time guards
    // ─────────────────────────────────────────────────────────────────────────

    function test_setReactor_revert_notOwner() public {
        vm.prank(notOwner);
        vm.expectRevert("not owner");
        auction.setReactor(address(0xBEEF));
    }

    function test_setReactor_revert_alreadySet() public {
        // _deployCore already pointed the auction at `reactor`.
        vm.expectRevert("already set");
        auction.setReactor(address(0xBEEF));
    }

    function test_setReactor_revert_zero() public {
        // A fresh auction has no reactor yet, so we reach the zero-address guard.
        FillAuction fresh = new FillAuction(treasury, address(0), address(0), 0);
        vm.expectRevert("zero reactor");
        fresh.setReactor(address(0));
    }

    // ── setCollateralRate (L-2 bounds) ──
    function test_setCollateralRate_revert_notOwner() public {
        vm.prank(notOwner);
        vm.expectRevert("not owner");
        auction.setCollateralRate(0, 1000);
    }

    function test_setCollateralRate_revert_badBucket() public {
        vm.expectRevert("bad bucket");
        auction.setCollateralRate(4, 1000); // valid buckets are 0..3
    }

    function test_setCollateralRate_revert_rateTooHigh() public {
        uint32 tooHigh = auction.MAX_COLLATERAL_RATE() + 1; // read before arming expectRevert
        vm.expectRevert("rate too high");
        auction.setCollateralRate(0, tooHigh);
    }

    function test_setCollateralRate_success() public {
        auction.setCollateralRate(0, 1234); // positive control for the happy branch
        assertEq(auction.collateralRate(0), 1234);
    }

    // ── setRefundTable (L-2 bounds) ──
    function test_setRefundTable_revert_notOwner() public {
        vm.prank(notOwner);
        vm.expectRevert("not owner");
        auction.setRefundTable(0, 0, 1000);
    }

    function test_setRefundTable_revert_badSizeBucket() public {
        vm.expectRevert("bad bucket");
        auction.setRefundTable(4, 0, 1000); // size bucket out of range (0..3)
    }

    function test_setRefundTable_revert_badRatioBucket() public {
        vm.expectRevert("bad bucket");
        auction.setRefundTable(0, 5, 1000); // ratio bucket out of range (0..4)
    }

    function test_setRefundTable_revert_tooHigh() public {
        uint32 tooHigh = auction.MAX_REFUND_BPS() + 1; // read before arming expectRevert
        vm.expectRevert("refund > 100%");
        auction.setRefundTable(0, 0, tooHigh);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  FillAuction.register — input guards (called as the reactor)
    // ─────────────────────────────────────────────────────────────────────────

    function test_register_revert_zeroFill() public {
        vm.prank(address(reactor));
        vm.expectRevert("zero fill");
        auction.register(filler, H, 0, 1000e6, DEADLINE, address(0), uint24(0));
    }

    function test_register_revert_fillExceedsTotal() public {
        vm.prank(address(reactor));
        vm.expectRevert("fill > total");
        auction.register(filler, H, 1001e6, 1000e6, DEADLINE, address(0), uint24(0));
    }

    function test_register_revert_fillTooLarge() public {
        uint256 huge = uint256(type(uint128).max) + 1;
        // fill == total == huge: passes "fill <= total", trips the uint128 guard.
        vm.prank(address(reactor));
        vm.expectRevert("fill too large");
        auction.register(filler, H, huge, huge, DEADLINE, address(0), uint24(0));
    }

    function test_register_revert_totalTooLarge() public {
        uint256 huge = uint256(type(uint128).max) + 1;
        // small fill (passes its own uint128 guard) but an over-large total.
        vm.prank(address(reactor));
        vm.expectRevert("total too large");
        auction.register(filler, H, 1000, huge, DEADLINE, address(0), uint24(0));
    }

    function test_register_revert_stakeTooLarge() public {
        // Extreme-value guard: a uint128-max fill in the top size bucket produces a
        // required stake (~3x notional) that overflows the uint128 stake field.
        // We must fund enough ETH to clear "insufficient stake" first, so the only
        // failing check is the stake-width guard.
        uint256 fill = type(uint128).max;
        uint256 needed = fill * 3 + 1 ether; // > computed required (~3x notional)
        vm.deal(address(reactor), needed);
        vm.prank(address(reactor));
        vm.expectRevert("stake too large");
        auction.register{value: needed}(filler, H, fill, fill, DEADLINE, address(0), uint24(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PartialFillReactor — setters, fallback, cancellation
    // ─────────────────────────────────────────────────────────────────────────

    function test_setFallbackExecutor_revert_alreadySet() public {
        // _deployCore already set it to fallbackExec.
        vm.expectRevert("already set");
        reactor.setFallbackExecutor(address(0xBEEF));
    }

    function test_setFallbackExecutor_revert_zero() public {
        // Fresh reactor: fallbackExecutor is still zero, so we reach the zero guard.
        PartialFillReactor fresh = new PartialFillReactor(address(permit2), address(auction), cosigner);
        vm.expectRevert("zero address");
        fresh.setFallbackExecutor(address(0));
    }

    function test_markFallbackInitiated_revert_notFallbackExecutor() public {
        vm.prank(rando);
        vm.expectRevert("not fallbackExecutor");
        reactor.markFallbackInitiated(H);
    }

    function test_markFallbackInitiated_revert_cancelled() public {
        // The swapper cancels the order, then the fallback path is blocked on it.
        PartialFillReactor.OrderInfo memory info =
            _orderInfo(swapper, 4 ether, 0, START_PRICE, 0, 1, DEADLINE);
        vm.prank(swapper);
        reactor.cancelOrder(info);

        bytes32 h = _hash(info); // compute before arming expectRevert (it makes a view call)
        vm.prank(fallbackExec);
        vm.expectRevert("cancelled");
        reactor.markFallbackInitiated(h);
    }

    function test_cancelOrder_revert_notSwapper() public {
        PartialFillReactor.OrderInfo memory info =
            _orderInfo(swapper, 4 ether, 0, START_PRICE, 0, 1, DEADLINE);
        vm.prank(rando); // not the order's swapper
        vm.expectRevert("not swapper");
        reactor.cancelOrder(info);
    }

    function test_cancelOrder_revert_alreadyCancelled() public {
        PartialFillReactor.OrderInfo memory info =
            _orderInfo(swapper, 4 ether, 0, START_PRICE, 0, 1, DEADLINE);
        vm.startPrank(swapper);
        reactor.cancelOrder(info);
        vm.expectRevert("already cancelled");
        reactor.cancelOrder(info);
        vm.stopPrank();
    }

    function test_register_revert_cancelled() public {
        // Reactor-level register rejects a cancelled order before staking.
        PartialFillReactor.SignedOrder memory o =
            _signed(_orderInfo(swapper, 4 ether, 0, START_PRICE, 0, 1, DEADLINE));
        vm.prank(swapper);
        reactor.cancelOrder(o.info);

        vm.prank(filler);
        vm.expectRevert("cancelled");
        reactor.register(o, 4 ether); // reverts before any stake is required
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  executePartialChunk — minFillBps floor & cancellation
    // ─────────────────────────────────────────────────────────────────────────

    function test_executePartialChunk_revert_belowMinFill() public {
        // minFillBps = 5000 => a chunk must be >= 50% of inputAmount.
        PartialFillReactor.OrderInfo memory info =
            _orderInfo(swapper, 4 ether, 0, START_PRICE, 0, 1, DEADLINE);
        info.minFillBps = 5000;
        PartialFillReactor.SignedOrder memory o = _signed(info);

        _fundSwapper(swapper, 4 ether);
        _fundFiller(filler, 1_000_000e6, 10 ether);
        _register(filler, o, 4 ether); // register for the full ceiling

        // 1 ether is only 25% of the order, below the 50% minFill floor.
        vm.prank(filler);
        vm.expectRevert("fill < minimum");
        reactor.executePartialChunk(o, 1 ether);
    }

    function test_executePartialChunk_revert_cancelled() public {
        PartialFillReactor.SignedOrder memory o =
            _signed(_orderInfo(swapper, 4 ether, 0, START_PRICE, 0, 1, DEADLINE));

        _fundSwapper(swapper, 4 ether);
        _fundFiller(filler, 1_000_000e6, 10 ether);
        _register(filler, o, 4 ether);

        vm.prank(swapper);
        reactor.cancelOrder(o.info);

        vm.prank(filler);
        vm.expectRevert("cancelled");
        reactor.executePartialChunk(o, 4 ether);
    }
}
