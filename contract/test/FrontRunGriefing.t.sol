// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PartialFillReactor.sol";
import "../src/FillAuction.sol";
import {DynamicStakeLib} from "../src/libs/DynamicStakeLib.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockPermit2.sol";

/// Proves the FillAuction fix for the front-running griefing vector:
/// a filler registered to fill 100% of an order can still complete for
/// whatever remains after another filler front-runs part of the order
/// (no "not registered" / "filled too little" revert), and recovers a
/// refund proportional to that actual fill ratio. See
/// test/FrontRunGriefing.md for the full before/after explanation.
contract FrontRunGriefingTest is Test {
    PartialFillReactor public reactor;
    FillAuction public auction;
    MockPermit2 public permit2;
    MockERC20 public inputToken;  // USDC
    MockERC20 public outputToken; // WETH

    uint256 cosignerKey = 0xA11CE;
    address public cosigner = vm.addr(cosignerKey);
    address public swapper  = makeAddr("swapper");
    address public fillerA  = makeAddr("fillerA"); // registers for 100% of the order
    address public bot      = makeAddr("bot");     // front-runs with a partial fill
    address public treasury = makeAddr("treasury");

    uint256 constant INPUT_AMOUNT    = 1000e6; // 1000 USDC
    uint256 constant START_PRICE     = 1e15;
    uint32  constant DECAY_PER_BLOCK = 0;
    uint256 constant DEADLINE        = 1000;

    function setUp() public {
        permit2 = new MockPermit2();
        auction = new FillAuction(treasury, address(0), address(0), 0); // oracle-disabled (1:1) mode
        inputToken = new MockERC20("USDC", "USDC");
        outputToken = new MockERC20("WETH", "WETH");

        reactor = new PartialFillReactor(address(permit2), address(auction), cosigner);
        auction.setReactor(address(reactor));

        // Constructor defaults: collateralRate = [2000, 5000, 10000, 30000],
        // refundTable per DynamicStakeLibStake.md. Collateral has no
        // fill-ratio dimension, so registering for the whole order costs
        // proportionally more than registering for a small slice, but never
        // a *cheaper rate* — see _collateral().

        inputToken.mint(swapper, INPUT_AMOUNT);
        outputToken.mint(fillerA, 10 ether);
        outputToken.mint(bot, 10 ether);

        vm.prank(swapper);
        inputToken.approve(address(permit2), type(uint256).max);
        vm.prank(fillerA);
        outputToken.approve(address(reactor), type(uint256).max);
        vm.prank(bot);
        outputToken.approve(address(reactor), type(uint256).max);

        vm.deal(fillerA, 1 ether);
        vm.deal(bot, 1 ether);

        vm.roll(100);
    }

    function _makeOrder() internal view returns (PartialFillReactor.SignedOrder memory) {
        PartialFillReactor.OrderInfo memory info = PartialFillReactor.OrderInfo({
            swapper: swapper,
            inputToken: address(inputToken),
            inputAmount: INPUT_AMOUNT,
            outputToken: address(outputToken),
            minOutputAmount: 0,
            deadline: DEADLINE,
            nonce: 1,
            minFillBps: 0,
            startPrice: uint128(START_PRICE),
            decayPerBlock: DECAY_PER_BLOCK,
            feeTier: 3000
        });
        return PartialFillReactor.SignedOrder({info: info, sig: _signOrder(info)});
    }

    function _signOrder(PartialFillReactor.OrderInfo memory info) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            reactor.ORDER_TYPE_HASH(),
            info.swapper, info.inputToken, info.inputAmount,
            info.outputToken, info.minOutputAmount,
            info.deadline, info.nonce, info.minFillBps,
            info.startPrice, info.decayPerBlock, info.feeTier
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reactor.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cosignerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _orderHash(PartialFillReactor.OrderInfo memory info) internal view returns (bytes32) {
        return keccak256(abi.encode(
            reactor.ORDER_TYPE_HASH(),
            info.swapper, info.inputToken, info.inputAmount,
            info.outputToken, info.minOutputAmount,
            info.deadline, info.nonce, info.minFillBps,
            info.startPrice, info.decayPerBlock, info.feeTier
        ));
    }

    /// Mirrors FillAuction.register()'s computeCollateral(): registration-time
    /// collateral for a given (fillAmount ceiling, orderTotal, deadline).
    function _collateral(uint256 fillAmount, uint256 orderTotal, uint256 deadline) internal view returns (uint256) {
        uint8 sBucket = DynamicStakeLib.getOrderSizeBucket(orderTotal);
        uint8 tBucket = DynamicStakeLib.getTimeBucket(deadline);
        uint32 rate = auction.collateralRate(sBucket);
        uint32 timeMult = DynamicStakeLib._getTimeMultiplier(tBucket);
        return (fillAmount * rate / 10000) * timeMult / 10000;
    }

    /// Mirrors FillAuction.onFillSuccess()'s computeRefund(): the portion of
    /// stakeAmount returned for an actual fill of actualFillAmount/orderTotal.
    function _refund(uint256 stakeAmount, uint256 actualFillAmount, uint256 orderTotal) internal view returns (uint256) {
        uint8 sBucket = DynamicStakeLib.getOrderSizeBucket(orderTotal);
        uint8 rBucket = DynamicStakeLib.getFillRatioBucket(actualFillAmount, orderTotal);
        uint32 refundBps = auction.refundTable(sBucket, rBucket);
        return stakeAmount * refundBps / 10000;
    }

    /// Concrete walk-through matching the design discussion: A registers to
    /// fill 100% of a 1000 USDC order. A bot front-runs with an 11% fill,
    /// shrinking what's left to 89% — *below* the old 90%-of-registration
    /// threshold. With only the hasValidRegistration `>=` relaxation (and
    /// not the onFillSuccess change), this scenario would still revert
    /// "filled too little" and A would eventually be slashed.
    ///
    /// Under the collateral/refund split, A's 89% actual fill is >=70% ->
    /// full refund, so A still recovers everything. The bot's 11% actual
    /// fill lands in the 10-30% bucket -> only a partial refund, with the
    /// rest forfeited to the treasury as a sniping fee.
    function test_frontRun_11pct_concreteExample() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();
        bytes32 orderHash = _orderHash(order.info);

        uint256 frontRunAmount  = INPUT_AMOUNT * 11 / 100; // 110 USDC (11%)
        uint256 remainingAmount = INPUT_AMOUNT - frontRunAmount; // 890 USDC (89%)

        uint256 stakeA = _collateral(INPUT_AMOUNT, INPUT_AMOUNT, DEADLINE);
        uint256 stakeB = _collateral(frontRunAmount, INPUT_AMOUNT, DEADLINE);

        // A registers to fill the whole order, paying collateral sized to
        // the full ceiling.
        vm.prank(fillerA);
        reactor.register{value: 1 ether}(order, INPUT_AMOUNT);

        // Bot front-runs with its own small registration + fill.
        vm.prank(bot);
        reactor.register{value: 1 ether}(order, frontRunAmount);
        vm.prank(bot);
        reactor.executePartialChunk(order, frontRunAmount);

        // A completes for the 89% that's left — not the 100% they
        // originally registered for.
        vm.prank(fillerA);
        reactor.executePartialChunk(order, remainingAmount);

        // A's actual fill (89%) is >=70% -> full refund -> recovers
        // everything they sent.
        uint256 refundA = _refund(stakeA, remainingAmount, INPUT_AMOUNT);
        assertEq(refundA, stakeA);
        assertEq(auction.pendingReturns(fillerA), 1 ether - stakeA + refundA);
        assertEq(auction.pendingReturns(fillerA), 1 ether);

        // The bot's actual fill (11%) is in the 10-30% bucket -> only a
        // partial refund; the rest is forfeited to the treasury.
        uint256 refundB = _refund(stakeB, frontRunAmount, INPUT_AMOUNT);
        assertLt(refundB, stakeB);
        assertEq(auction.pendingReturns(bot), 1 ether - stakeB + refundB);

        assertEq(auction.pendingReturns(treasury), (stakeA - refundA) + (stakeB - refundB));

        // A is no longer slashable after the window passes.
        vm.roll(DEADLINE + auction.SLASH_WINDOW() + 1);
        vm.expectRevert("invalid state");
        auction.slash(orderHash, fillerA);
    }

    /// Fuzz: for ANY front-run size between 1% and 99% of the order, A
    /// (registered for 100%) can still complete for whatever remains -
    /// pre-fix, hasValidRegistration's exact `==` match reverted "not
    /// registered" for *every* value here. A's refund now tracks its actual
    /// fill ratio: a >=70% remainder (frontRunBps <= 3000) returns A's full
    /// stake, anything smaller returns only the matching refundTable share.
    function testFuzz_frontRun_fillerRefundMatchesActualFillRatio(uint256 frontRunBps) public {
        frontRunBps = bound(frontRunBps, 100, 9900); // 1%..99% of the order

        PartialFillReactor.SignedOrder memory order = _makeOrder();
        bytes32 orderHash = _orderHash(order.info);

        uint256 frontRunAmount  = INPUT_AMOUNT * frontRunBps / 10000;
        uint256 remainingAmount = INPUT_AMOUNT - frontRunAmount;

        uint256 stakeA = _collateral(INPUT_AMOUNT, INPUT_AMOUNT, DEADLINE);

        vm.prank(fillerA);
        reactor.register{value: 1 ether}(order, INPUT_AMOUNT);

        vm.prank(bot);
        reactor.register{value: 1 ether}(order, frontRunAmount);
        vm.prank(bot);
        reactor.executePartialChunk(order, frontRunAmount);

        vm.prank(fillerA);
        reactor.executePartialChunk(order, remainingAmount);

        uint256 refundA = _refund(stakeA, remainingAmount, INPUT_AMOUNT);
        assertEq(auction.pendingReturns(fillerA), 1 ether - stakeA + refundA);

        vm.roll(DEADLINE + auction.SLASH_WINDOW() + 1);
        vm.expectRevert("invalid state");
        auction.slash(orderHash, fillerA);
    }
}
