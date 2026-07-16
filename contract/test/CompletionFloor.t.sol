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
    /// Numbers chosen so the order IS reachable in a single fill (passes
    /// _validateOrder's "unreachable min output" register-time check) but a
    /// 2-way EQUAL split still leaks value to flooring:
    ///   inputAmount = 10, minOutputAmount = 19, startPrice = 1.9e18, decay = 0
    ///   single-fill ceiling: 10 * 1.9 = 19 exact -> minOutputAmount (19) is reachable
    ///   chunk A: fill 5 -> out = 5 * 1.9 = 9.5 -> floor 9 ; pro-rata floor = floor(19*5/10) = 9  (9 >= 9 ok)
    ///   chunk B: fill 5 -> out = 5 * 1.9 = 9.5 -> floor 9 ; pro-rata floor = floor(19*5/10) = 9  (9 >= 9 ok)
    ///   sum of pro-rata floors = 18  <  minOutputAmount = 19
    ///   total paid on completion = 9 + 9 = 18  <  19  -> "min output total"
    function test_completionBelowAbsoluteFloor_reverts() public {
        uint256 inputAmount = 10;
        uint256 minOut      = 19;
        uint128 price       = 1.9e18;

        _fundSwapper(swapper, inputAmount);
        _fundFiller(fillerA, 1_000, 1 ether);
        _fundFiller(fillerB, 1_000, 1 ether);

        PartialFillReactor.SignedOrder memory o =
            _signed(_orderInfo(swapper, inputAmount, minOut, price, 0, 1, DEADLINE));

        // A fills 5 of 10 — clears its pro-rata floor, order not yet complete.
        _register(fillerA, o, 5);
        vm.prank(fillerA);
        reactor.executePartialChunk(o, 5);
        assertEq(usdc.balanceOf(swapper), 9, "A should pay its pro-rata share");
        assertEq(reactor.remainingInput(_hash(o.info), inputAmount), 5, "5 units left");

        // B's chunk individually clears its floor (9 >= 9) but completing the
        // order would leave the swapper at 18 < 19 — the backstop blocks it.
        _register(fillerB, o, 5);
        vm.prank(fillerB);
        vm.expectRevert("min output total");
        reactor.executePartialChunk(o, 5);

        // The order is left partially filled rather than completing below floor;
        // the swapper keeps exactly the pro-rata value for what actually sold.
        assertEq(usdc.balanceOf(swapper), 9, "swapper not underpaid on aggregate");
        assertEq(reactor.remainingInput(_hash(o.info), inputAmount), 5, "still 5 units unfilled");
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
