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
        // remainingAtFill = max ⇒ refund denominator stays the full commitment
        // (the pre-3.5 behaviour these existing tests assert).
        auction.onFillSuccess(orderHash, filler, fillAmount, type(uint256).max);
    }

    // 3.5: lets a test model a live remainder that shrank below the commitment.
    function callOnFillSuccessWithRemaining(
        bytes32 orderHash,
        address filler,
        uint256 fillAmount,
        uint256 remainingAtFill
    ) external {
        auction.onFillSuccess(orderHash, filler, fillAmount, remainingAtFill);
    }

    // IReactorView surface used by FillAuction.slash / releaseRegistration.
    // Defaults model an order that is still open and not cancelled.
    bool public cancelledFlag;
    bool public nonceInvalidatedFlag;
    uint256 public remainingOverride = type(uint256).max; // sentinel: "use orderAmount"

    function setCancelled(bool v) external { cancelledFlag = v; }
    function setNonceInvalidated(bool v) external { nonceInvalidatedFlag = v; }
    function setRemaining(uint256 v) external { remainingOverride = v; }

    function isCancelled(bytes32) external view returns (bool) { return cancelledFlag; }
    function isNonceInvalidatedForOrder(bytes32) external view returns (bool) { return nonceInvalidatedFlag; }

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
        auction = new FillAuction(treasury, address(0), address(0), 0, true); // oracle-disabled (1:1) mode
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

    // D-2: refund ratio is actual ÷ COMMITTED (FILL_AMOUNT), not ÷ order.
    // Delivering the full 400e6 commitment -> rBucket 4 -> 100% refund.
    function test_onFillSuccess_fullCommitment_refundsFullStake() public {
        _register();
        reactor.callOnFillSuccess(ORDER_HASH, filler, FILL_AMOUNT);

        assertEq(auction.pendingReturns(filler), STAKE);
        assertEq(auction.pendingReturns(treasury), 0);
        assertFalse(auction.hasValidRegistration(ORDER_HASH, filler, FILL_AMOUNT));
    }

    // Delivering 40% of the COMMITTED 400e6 (160e6) -> rBucket 3 (30-70%) ->
    // refundTable[0][3] = 5000bps = 50% refund; the rest forfeited.
    function test_onFillSuccess_underDelivery_refundsHalfStake() public {
        _register();
        reactor.callOnFillSuccess(ORDER_HASH, filler, FILL_AMOUNT * 40 / 100);

        uint256 refund    = STAKE * 5000 / 10000;
        uint256 forfeited = STAKE - refund;
        assertEq(auction.pendingReturns(filler), refund);
        assertEq(auction.pendingReturns(treasury), forfeited);
    }

    // Delivering only 2.5% of the COMMITTED 400e6 (10e6) -> rBucket 1 (2-10%) ->
    // refundTable[0][1] = 1000bps = 10% refund; most is forfeited.
    function test_onFillSuccess_tinyDelivery_forfeitsMostStake() public {
        _register();
        uint256 tinyFill = FILL_AMOUNT * 25 / 1000; // 2.5% of commitment
        reactor.callOnFillSuccess(ORDER_HASH, filler, tinyFill);

        uint256 refund    = STAKE * 1000 / 10000;
        uint256 forfeited = STAKE - refund;
        assertEq(auction.pendingReturns(filler), refund);
        assertEq(auction.pendingReturns(treasury), forfeited);
    }

    // ── 3.5: shrunk-remainder relief ──
    // Same tiny fill as test_onFillSuccess_tinyDelivery, but here the live
    // remainder had already been shrunk (by competing fillers) to exactly that
    // tiny amount. The honest registrant filled 100% of what was available, so
    // they must get the FULL stake back — not be punished as an under-deliverer.
    // The contrast with the test above is the whole point: identical fill size,
    // opposite outcome, decided solely by whether volume was actually available.
    function test_onFillSuccess_shrunkRemainder_fullRefund() public {
        _register();
        uint256 tinyFill = FILL_AMOUNT * 25 / 1000; // 2.5% of commitment
        // remainingAtFill == the fill: the registrant consumed the entire remainder.
        reactor.callOnFillSuccessWithRemaining(ORDER_HASH, filler, tinyFill, tinyFill);

        assertEq(auction.pendingReturns(filler), STAKE);
        assertEq(auction.pendingReturns(treasury), 0);
    }

    // 3.5 guard: relief only applies when the remainder genuinely shrank below
    // the commitment. If full volume was available and the filler still under-
    // delivered, the original penalty stands (no sniping loophole).
    function test_onFillSuccess_underDelivery_withFullRemainder_stillPenalised() public {
        _register();
        uint256 tinyFill = FILL_AMOUNT * 25 / 1000;
        // remainingAtFill >= commitment ⇒ denominator stays FILL_AMOUNT.
        reactor.callOnFillSuccessWithRemaining(ORDER_HASH, filler, tinyFill, FILL_AMOUNT);

        uint256 refund = STAKE * 1000 / 10000; // same 10% as the tinyDelivery case
        assertEq(auction.pendingReturns(filler), refund);
        assertEq(auction.pendingReturns(treasury), STAKE - refund);
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