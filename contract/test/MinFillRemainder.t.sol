// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./adversarial/AdversarialBase.sol";

/// M-4: minFillBps is sized against the order's ORIGINAL inputAmount, not the
/// live remaining amount. An earlier fill can leave a tail smaller than
/// _minFill(order), which executePartialChunk could never accept under the
/// old check (fillAmount >= _minFill(order)) — permanently stranding that tail.
/// executePartialChunk now also accepts fillAmount == currentRemaining,
/// letting the order complete regardless of how small the remainder has
/// shrunk to.
contract MinFillRemainderTest is AdversarialBase {
    address swapper = makeAddr("swapper");
    address fillerA = makeAddr("fillerA");
    address fillerB = makeAddr("fillerB");

    uint256 constant DEADLINE = 100_000;

    function setUp() public {
        _deployCore();
    }

    /// A 50%-minFill order: fillerA takes 60 of 100, leaving a 40-unit tail —
    /// below _minFill(order) = 50. fillerB must still be able to complete the
    /// order with that 40-unit tail.
    function test_tailBelowMinFill_completesOrder() public {
        uint256 inputAmount = 100;
        uint16  minFillBps  = 5000; // _minFill = 50

        _fundSwapper(swapper, inputAmount);
        _fundFiller(fillerA, 1_000, 1 ether);
        _fundFiller(fillerB, 1_000, 1 ether);

        PartialFillReactor.OrderInfo memory info = _orderInfo(swapper, inputAmount, 0, 1e18, 0, 1, DEADLINE);
        info.minFillBps = minFillBps;
        PartialFillReactor.SignedOrder memory o = _signed(info);

        // fillerA fills 60 (>= _minFill=50). Leaves a 40-unit tail, below _minFill.
        _register(fillerA, o, 60);
        vm.prank(fillerA);
        reactor.executePartialChunk(o, 60);
        assertEq(reactor.remainingInput(_hash(o.info), inputAmount), 40, "40 left, below minFill");

        // fillerB completes the order with the 40-unit tail. Without the M-4
        // exemption this would revert "fill < minimum" (40 < 50 and 40 != 100).
        _register(fillerB, o, 40);
        vm.prank(fillerB);
        reactor.executePartialChunk(o, 40);

        assertEq(reactor.remainingInput(_hash(o.info), inputAmount), 0, "order fully filled");
        assertEq(weth.balanceOf(fillerB), 40, "fillerB pulled the 40-unit tail");
    }

    /// Boundary check: a chunk that is NEITHER == currentRemaining NOR
    /// >= _minFill(order) must still revert — the M-4 exemption only covers
    /// the order-completing chunk.
    function test_nonCompletingChunkBelowMinFill_stillReverts() public {
        uint256 inputAmount = 100;
        uint16  minFillBps  = 5000; // _minFill = 50

        _fundSwapper(swapper, inputAmount);
        _fundFiller(fillerA, 1_000, 1 ether);

        PartialFillReactor.OrderInfo memory info = _orderInfo(swapper, inputAmount, 0, 1e18, 0, 1, DEADLINE);
        info.minFillBps = minFillBps;
        PartialFillReactor.SignedOrder memory o = _signed(info);

        // 30 is neither == currentRemaining (100) nor >= _minFill (50).
        _register(fillerA, o, 30);
        vm.prank(fillerA);
        vm.expectRevert("fill < minimum");
        reactor.executePartialChunk(o, 30);
    }
}
