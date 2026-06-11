// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PartialFillReactor.sol";
import "../src/FillAuction.sol";
import {DynamicStakeLib} from "../src/libs/DynamicStakeLib.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockPermit2.sol";

/// FIXED: FillAuction.register() used to accept filler-supplied
/// `orderTotal`/`deadline` with no link to the order being registered
/// against. A filler could register `orderTotal == fillAmount`, which
/// simultaneously picked a cheaper `collateralRate[sBucket]` and guaranteed
/// `getFillRatioBucket == 4` (100% refund), regardless of the real order's
/// size. See exploit.md for the original writeup.
///
/// The fix: FillAuction.register() is now `onlyReactor` with an explicit
/// `filler` param (mirroring onFillSuccess), and PartialFillReactor exposes
/// `register(SignedOrder, fillAmount)`, which derives `orderTotal` and
/// `deadline` from the *real, hashed* `order.info` — there is no longer a
/// free-form `orderTotal`/`deadline` parameter for a filler to misreport.
contract RegistrationForgeryTest is Test {
    PartialFillReactor public reactor;
    FillAuction public auction;
    MockPermit2 public permit2;
    MockERC20 public inputToken;  // USDC
    MockERC20 public outputToken; // WETH

    uint256 cosignerKey = 0xA11CE;
    address public cosigner = vm.addr(cosignerKey);
    address public swapper  = makeAddr("swapper");
    address public filler   = makeAddr("filler");
    address public evil     = makeAddr("evil");
    address public treasury = makeAddr("treasury");

    uint256 constant INPUT_AMOUNT    = 2_000_000e6; // 2,000,000 USDC order -> sBucket 3 (>$1M)
    uint256 constant FILL_CHUNK      = 20_000e6;    // 1% of the order
    uint256 constant START_PRICE     = 1e15;
    uint32  constant DECAY_PER_BLOCK = 0;
    uint256 constant DEADLINE        = 1000;

    function setUp() public {
        permit2 = new MockPermit2();
        auction = new FillAuction(treasury);
        inputToken = new MockERC20("USDC", "USDC");
        outputToken = new MockERC20("WETH", "WETH");

        reactor = new PartialFillReactor(address(permit2), address(auction), cosigner);
        auction.setReactor(address(reactor));

        inputToken.mint(swapper, INPUT_AMOUNT);
        outputToken.mint(filler, 1 ether);
        outputToken.mint(evil, 1 ether);

        vm.prank(swapper);
        inputToken.approve(address(permit2), type(uint256).max);
        vm.prank(filler);
        outputToken.approve(address(reactor), type(uint256).max);
        vm.prank(evil);
        outputToken.approve(address(reactor), type(uint256).max);

        vm.deal(filler, 1000 ether);
        vm.deal(evil, 1000 ether);

        vm.roll(100);
    }

    function _makeOrder(uint256 inputAmount, uint256 nonce) internal view returns (PartialFillReactor.SignedOrder memory) {
        PartialFillReactor.OrderInfo memory info = PartialFillReactor.OrderInfo({
            swapper: swapper,
            inputToken: address(inputToken),
            inputAmount: inputAmount,
            outputToken: address(outputToken),
            minOutputAmount: 0,
            deadline: DEADLINE,
            nonce: nonce,
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
            info.deadline, info.nonce, info.minFillBps
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
            info.deadline, info.nonce, info.minFillBps
        ));
    }

    /// Mirrors FillAuction.register()'s computeCollateral().
    function _collateral(uint256 fillAmount, uint256 orderTotal, uint256 deadline) internal view returns (uint256) {
        uint8 sBucket = DynamicStakeLib.getOrderSizeBucket(orderTotal);
        uint8 tBucket = DynamicStakeLib.getTimeBucket(deadline);
        uint32 rate = auction.collateralRate(sBucket);
        uint32 timeMult = DynamicStakeLib._getTimeMultiplier(tBucket);
        return (fillAmount * rate / 10000) * timeMult / 10000;
    }

    /// Mirrors FillAuction.onFillSuccess()'s computeRefund().
    function _refund(uint256 stakeAmount, uint256 actualFillAmount, uint256 orderTotal) internal view returns (uint256) {
        uint8 sBucket = DynamicStakeLib.getOrderSizeBucket(orderTotal);
        uint8 rBucket = DynamicStakeLib.getFillRatioBucket(actualFillAmount, orderTotal);
        uint32 refundBps = auction.refundTable(sBucket, rBucket);
        return stakeAmount * refundBps / 10000;
    }

    /// FillAuction.register() can no longer be called directly — only the
    /// reactor (set once via setReactor) may call it.
    function test_register_revert_onlyReactor() public {
        bytes32 orderHash = _orderHash(_makeOrder(INPUT_AMOUNT, 1).info);
        vm.prank(evil);
        vm.expectRevert("only reactor");
        auction.register{value: 1 ether}(evil, orderHash, FILL_CHUNK, FILL_CHUNK, DEADLINE);
    }

    /// Filling 1% of a 2,000,000 USDC order via reactor.register(order,
    /// fillAmount) always lands in sBucket 3 (collateralRate[3] = 30000, 3x)
    /// and refundTable[3][0] (1% refund) — the "honest" outcome from the
    /// original exploit.md PoC, now the *only* reachable outcome. There is
    /// no orderTotal/deadline parameter left for a filler to under-report.
    function test_reactorRegister_derivesOrderTotalAndDeadlineFromRealOrder() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder(INPUT_AMOUNT, 1);

        uint256 collateral = _collateral(FILL_CHUNK, INPUT_AMOUNT, DEADLINE);
        vm.prank(filler);
        reactor.register{value: collateral}(order, FILL_CHUNK);
        vm.prank(filler);
        reactor.executePartialChunk(order, FILL_CHUNK);

        // sBucket(2,000,000) = 3 -> collateralRate[3] = 30000 (3x)
        assertEq(collateral, FILL_CHUNK * 3);

        // 1% fill of 2,000,000 -> rBucket 0 -> refundTable[3][0] = 100bps (1%)
        uint256 refund = _refund(collateral, FILL_CHUNK, INPUT_AMOUNT);
        assertEq(refund, collateral / 100);
        assertEq(auction.pendingReturns(filler), refund);

        emit log_named_uint("collateral posted", collateral);
        emit log_named_uint("refund received  ", refund);
        emit log_named_uint("forfeited         ", collateral - refund);
    }

    /// The old "claim my slice IS the entire order" trick (registering with
    /// orderTotal == fillAmount) cannot be recreated via a forged OrderInfo
    /// either: an OrderInfo with inputAmount == fillAmount hashes to a
    /// *different* orderHash than the real order, so the resulting cheap
    /// registration is invisible to — and unusable against — the real order.
    function test_forgedOrderInfo_decouplesRegistrationFromRealOrder() public {
        PartialFillReactor.SignedOrder memory realOrder = _makeOrder(INPUT_AMOUNT, 1);
        PartialFillReactor.SignedOrder memory fakeOrder = _makeOrder(FILL_CHUNK, 1);

        assertTrue(_orderHash(realOrder.info) != _orderHash(fakeOrder.info));

        uint256 cheapCollateral = _collateral(FILL_CHUNK, FILL_CHUNK, DEADLINE);
        vm.prank(evil);
        reactor.register{value: cheapCollateral}(fakeOrder, FILL_CHUNK);

        // The cheap registration exists only under fakeOrder's hash...
        assertTrue(auction.hasValidRegistration(_orderHash(fakeOrder.info), evil, FILL_CHUNK));
        // ...and is invisible to the real order.
        assertFalse(auction.hasValidRegistration(_orderHash(realOrder.info), evil, FILL_CHUNK));

        vm.prank(evil);
        vm.expectRevert("not registered");
        reactor.executePartialChunk(realOrder, FILL_CHUNK);
    }
}
