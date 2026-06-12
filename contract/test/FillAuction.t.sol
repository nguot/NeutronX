// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FillAuction.sol";

contract MockReactor {
    FillAuction public auction;

    function setAuction(address _auction) external {
        auction = FillAuction(_auction);
    }

    function callRegister(
        address filler,
        bytes32 orderHash,
        uint256 fillAmount,
        uint256 orderTotal,
        uint256 deadline
    ) external payable {
        // inputToken/feeTier irrelevant here: auction was deployed oracle-disabled.
        auction.register{value: msg.value}(filler, orderHash, fillAmount, orderTotal, deadline, address(0), uint24(0));
    }

    function callOnFillSuccess(
        bytes32 orderHash,
        address filler,
        uint256 fillAmount
    ) external {
        auction.onFillSuccess(orderHash, filler, fillAmount);
    }

    // IReactorView surface used by FillAuction.slash / releaseRegistration.
    // Defaults model an order that is still open and not cancelled.
    bool public cancelledFlag;
    uint256 public remainingOverride = type(uint256).max; // sentinel: "use orderAmount"

    function setCancelled(bool v) external { cancelledFlag = v; }
    function setRemaining(uint256 v) external { remainingOverride = v; }

    function isCancelled(bytes32) external view returns (bool) { return cancelledFlag; }

    function remainingInput(bytes32, uint256 orderAmount) external view returns (uint256) {
        return remainingOverride == type(uint256).max ? orderAmount : remainingOverride;
    }
}

contract FillAuctionTest is Test {
    FillAuction public auction;
    MockReactor public reactor;

    address public treasury = makeAddr("treasury");
    address public filler   = makeAddr("filler");
    address public slasher  = makeAddr("slasher");

    bytes32 constant ORDER_HASH  = keccak256("order1");
    uint256 constant ORDER_TOTAL = 1000e6;  // 1000 USDC, sBucket 0 (<$10k)
    uint256 constant FILL_AMOUNT = 400e6;   // 400 USDC ceiling (40% of total)
    uint256 constant DEADLINE    = 1000;

    // collateral = FILL_AMOUNT * collateralRate[0] (2000bps = 20%) * timeMult (1x, tBucket 0)
    uint256 constant STAKE = 80e6;

    function setUp() public {
        reactor = new MockReactor();
        auction = new FillAuction(treasury, address(0), address(0), 0); // oracle-disabled (1:1) mode
        auction.setReactor(address(reactor));
        reactor.setAuction(address(auction));

        // Constructor defaults: collateralRate = [2000, 5000, 10000, 30000],
        // refundTable per DynamicStakeLibStake.md.
        vm.roll(100);
    }

    function _register() internal {
        vm.deal(filler, 1 ether);
        vm.prank(filler);
        reactor.callRegister{value: STAKE}(filler, ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
    }

    // ── register() ──

    function test_register_success() public {
        _register();
        assertTrue(auction.hasValidRegistration(ORDER_HASH, filler, FILL_AMOUNT));
    }

    function test_register_refundsExcess() public {
        uint256 excess = 1 ether;
        vm.deal(filler, STAKE + excess);
        vm.prank(filler);
        reactor.callRegister{value: STAKE + excess}(filler, ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
        assertEq(auction.pendingReturns(filler), excess);
    }

    function test_register_revert_deadlinePassed() public {
        vm.roll(DEADLINE + 1);
        vm.deal(filler, 1 ether);
        vm.prank(filler);
        vm.expectRevert("deadline passed");
        reactor.callRegister{value: STAKE}(filler, ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
    }

    function test_register_revert_alreadyRegistered() public {
        _register();
        vm.deal(filler, 1 ether);
        vm.prank(filler);
        vm.expectRevert("already registered");
        reactor.callRegister{value: STAKE}(filler, ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
    }

    function test_register_revert_insufficientStake() public {
        vm.deal(filler, 1 ether);
        vm.prank(filler);
        vm.expectRevert("insufficient stake");
        reactor.callRegister{value: STAKE - 1}(filler, ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
    }

    function test_register_revert_onlyReactor() public {
        vm.deal(filler, 1 ether);
        vm.prank(filler);
        vm.expectRevert("only reactor");
        auction.register{value: STAKE}(filler, ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE, address(0), uint24(0));
    }

    // ── slash() ──

    function test_slash_success() public {
        _register();
        vm.roll(DEADLINE + auction.SLASH_WINDOW() + 1);
        vm.prank(slasher);
        auction.slash(ORDER_HASH, filler);

        uint256 reward     = STAKE / 10;
        uint256 toTreasury = STAKE - reward;
        assertEq(auction.pendingReturns(slasher),  reward);
        assertEq(auction.pendingReturns(treasury), toTreasury);
    }

    function test_slash_revert_tooEarly() public {
        _register();
        vm.roll(DEADLINE + 1);
        vm.prank(slasher);
        vm.expectRevert("too early");
        auction.slash(ORDER_HASH, filler);
    }

    function test_slash_revert_alreadyFilled() public {
        _register();
        reactor.callOnFillSuccess(ORDER_HASH, filler, FILL_AMOUNT);
        vm.roll(DEADLINE + auction.SLASH_WINDOW() + 1);
        vm.prank(slasher);
        vm.expectRevert("invalid state");
        auction.slash(ORDER_HASH, filler);
    }

    // ── withdraw() ──

    function test_withdraw_success() public {
        _register();
        vm.roll(DEADLINE + auction.SLASH_WINDOW() + 1);
        vm.prank(slasher);
        auction.slash(ORDER_HASH, filler);

        uint256 reward    = auction.pendingReturns(slasher);
        uint256 balBefore = slasher.balance;
        vm.prank(slasher);
        auction.withdraw();
        assertEq(slasher.balance, balBefore + reward);
    }

    function test_withdraw_revert_nothingToWithdraw() public {
        vm.prank(filler);
        vm.expectRevert("nothing to withdraw");
        auction.withdraw();
    }

    // ── onFillSuccess() ──

    // actualFillAmount = FILL_AMOUNT = 400e6 = 40% of ORDER_TOTAL -> rBucket 3
    // (30-70%) -> refundTable[0][3] = 5000bps = 50% refund.
    function test_onFillSuccess_partialFill_refundsHalfStake() public {
        _register();
        reactor.callOnFillSuccess(ORDER_HASH, filler, FILL_AMOUNT);

        uint256 refund    = STAKE * 5000 / 10000;
        uint256 forfeited = STAKE - refund;
        assertEq(auction.pendingReturns(filler), refund);
        assertEq(auction.pendingReturns(treasury), forfeited);
        assertFalse(auction.hasValidRegistration(ORDER_HASH, filler, FILL_AMOUNT));
    }

    // A "sniper" who only manages a tiny actual fill (1% of ORDER_TOTAL,
    // < 2% -> rBucket 0 -> refundTable[0][0] = 500bps = 5% refund) forfeits
    // most of their collateral to the treasury.
    function test_onFillSuccess_smallActualFill_forfeitsMostStake() public {
        _register();
        uint256 tinyFill = ORDER_TOTAL * 1 / 100;
        reactor.callOnFillSuccess(ORDER_HASH, filler, tinyFill);

        uint256 refund    = STAKE * 500 / 10000;
        uint256 forfeited = STAKE - refund;
        assertEq(auction.pendingReturns(filler), refund);
        assertEq(auction.pendingReturns(treasury), forfeited);
    }

    // Filling >=70% of ORDER_TOTAL -> rBucket 4 -> refundTable[0][4] =
    // 10000bps = 100% refund, nothing forfeited.
    function test_onFillSuccess_largeActualFill_returnsFullStake() public {
        _register();
        uint256 bigFill = ORDER_TOTAL * 70 / 100;
        reactor.callOnFillSuccess(ORDER_HASH, filler, bigFill);

        assertEq(auction.pendingReturns(filler), STAKE);
        assertEq(auction.pendingReturns(treasury), 0);
    }

    // ── hasValidRegistration() ──

    function test_hasValidRegistration_allowsSmallerFillAmount() public {
        _register();
        // Registered fillAmount acts as a ceiling: a smaller remaining
        // amount (e.g. after a front-running fill shrank what's left)
        // still matches the registration.
        assertTrue(auction.hasValidRegistration(ORDER_HASH, filler, FILL_AMOUNT - 1));
    }

    function test_hasValidRegistration_revert_largerFillAmount() public {
        _register();
        assertFalse(auction.hasValidRegistration(ORDER_HASH, filler, FILL_AMOUNT + 1));
    }
}