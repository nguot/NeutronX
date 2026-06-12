// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./adversarial/AdversarialBase.sol";

/// C-1 completion-time backstop: `executePartialChunk` enforces the swapper's
/// signed `minOutputAmount` in TWO places —
///   1. a PER-CHUNK pro-rata floor:  outputAmount >= minOutputAmount * fill / input
///   2. an ABSOLUTE floor on completion: once `newRemaining == 0`,
///      cumulative paid >= minOutputAmount   ("min output total")
///
/// (2) is not redundant with (1). Because each chunk's pro-rata floor is computed
/// with integer (flooring) division, the sum of the per-chunk floors can be
/// strictly LESS than the absolute floor. A multi-filler order can therefore have
/// every chunk individually clear its pro-rata floor while the order as a whole
/// would settle the swapper below the minimum they signed. The absolute floor is
/// the backstop that refuses to *complete* such an order.
///
/// This is swapper-protection logic (it bounds the worst case under partial
/// fills + decay), so it gets a dedicated deterministic test for the revert arm
/// plus a fuzz test for the guarantee it provides.
contract CompletionFloorTest is AdversarialBase {
    address swapper = makeAddr("swapper");
    address fillerA = makeAddr("fillerA");
    address fillerB = makeAddr("fillerB");

    uint256 constant DEADLINE = 100_000;

    function setUp() public {
        _deployCore();
    }

    /// Deterministic: two chunks each clear their pro-rata floor, but completing
    /// the order would pay the swapper below the absolute `minOutputAmount`, so
    /// the completing chunk reverts "min output total".
    ///
    /// Numbers (tiny units chosen so the flooring gap is exact and visible):
    ///   inputAmount = 3, minOutputAmount = 5, startPrice = 1.5e18, decay = 0
    ///   chunk A: fill 2 -> out = 2 * 1.5 = 3 ; pro-rata floor = floor(5*2/3) = 3  (3 >= 3 ok)
    ///   chunk B: fill 1 -> out = 1 * 1.5 = 1 ; pro-rata floor = floor(5*1/3) = 1  (1 >= 1 ok)
    ///   sum of pro-rata floors = 4  <  minOutputAmount = 5
    ///   total paid on completion = 3 + 1 = 4  <  5  -> "min output total"
    function test_completionBelowAbsoluteFloor_reverts() public {
        uint256 inputAmount = 3;
        uint256 minOut      = 5;
        uint128 price       = 1.5e18;

        _fundSwapper(swapper, inputAmount);
        _fundFiller(fillerA, 1_000, 1 ether);
        _fundFiller(fillerB, 1_000, 1 ether);

        PartialFillReactor.SignedOrder memory o =
            _signed(_orderInfo(swapper, inputAmount, minOut, price, 0, 1, DEADLINE));

        // A fills 2 of 3 — clears its pro-rata floor, order not yet complete.
        _register(fillerA, o, 2);
        vm.prank(fillerA);
        reactor.executePartialChunk(o, 2);
        assertEq(usdc.balanceOf(swapper), 3, "A should pay its pro-rata share");
        assertEq(reactor.remainingInput(_hash(o.info), inputAmount), 1, "1 unit left");

        // B's chunk individually clears its floor (1 >= 1) but completing the
        // order would leave the swapper at 4 < 5 — the backstop blocks it.
        _register(fillerB, o, 1);
        vm.prank(fillerB);
        vm.expectRevert("min output total");
        reactor.executePartialChunk(o, 1);

        // The order is left partially filled rather than completing below floor;
        // the swapper keeps exactly the pro-rata value for what actually sold.
        assertEq(usdc.balanceOf(swapper), 3, "swapper not underpaid on aggregate");
        assertEq(reactor.remainingInput(_hash(o.info), inputAmount), 1, "still 1 unit unfilled");
    }

    /// Fuzz guarantee: for any 2-way split and any non-decaying price >= the floor
    /// price, IF the order completes (both chunks settle), the swapper received at
    /// least the `minOutputAmount` they signed. We re-deploy per run so each
    /// iteration is independent (forge runs setUp only once).
    ///
    /// We set minOutputAmount == inputAmount and price >= 1e18, so the floor is
    /// always reachable and the order should complete; the assertion proves the
    /// absolute floor is never violated on a completed order.
    function testFuzz_completedOrder_neverBelowSignedFloor(uint256 splitRaw, uint256 priceRaw) public {
        _deployCore(); // fresh reactor/auction/tokens for this iteration

        uint256 inputAmount = 1_000;
        uint256 split = bound(splitRaw, 1, inputAmount - 1); // fillerA's chunk
        uint256 rest  = inputAmount - split;                 // fillerB's completing chunk
        uint128 price = uint128(bound(priceRaw, 1e18, 5e18));

        uint256 minOut = inputAmount; // at price 1e18, paid == inputAmount == floor

        _fundSwapper(swapper, inputAmount);
        _fundFiller(fillerA, 1_000_000, 1 ether);
        _fundFiller(fillerB, 1_000_000, 1 ether);

        PartialFillReactor.SignedOrder memory o =
            _signed(_orderInfo(swapper, inputAmount, minOut, price, 0, 1, DEADLINE));

        _register(fillerA, o, split);
        vm.prank(fillerA);
        reactor.executePartialChunk(o, split);

        _register(fillerB, o, rest);
        vm.prank(fillerB);
        // The completing chunk must succeed for these inputs (price >= floor price);
        // if it does, the absolute-floor invariant must hold.
        reactor.executePartialChunk(o, rest);

        assertEq(reactor.remainingInput(_hash(o.info), inputAmount), 0, "order should be complete");
        assertGe(usdc.balanceOf(swapper), minOut, "completed order paid below signed floor");
    }
}
