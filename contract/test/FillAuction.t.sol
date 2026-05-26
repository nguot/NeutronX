// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FillAuction.sol";

contract MockReactor {
    FillAuction public auction;

    function setAuction(address _auction) external {
        auction = FillAuction(_auction);
    }

    function callOnFillSuccess(
        bytes32 orderHash,
        address filler,
        uint256 fillAmount
    ) external {
        auction.onFillSuccess(orderHash, filler, fillAmount);
    }
}

contract FillAuctionTest is Test {
    FillAuction public auction;
    MockReactor public reactor;

    address public treasury = makeAddr("treasury");
    address public filler   = makeAddr("filler");
    address public slasher  = makeAddr("slasher");

    bytes32 constant ORDER_HASH  = keccak256("order1");
    uint256 constant ORDER_TOTAL = 1000e6;  // 1000 USDC
    uint256 constant FILL_AMOUNT = 400e6;   // 400 USDC
    uint256 constant DEADLINE    = 1000;

    // stake = 1% fillAmount = 4e6
    uint256 constant STAKE = 4e6;

    function setUp() public {
        reactor = new MockReactor();
        auction = new FillAuction(treasury);
        auction.setReactor(address(reactor));
        reactor.setAuction(address(auction));

        // set tất cả bucket = 100 bps (1%)
        for (uint8 s = 0; s < 4; s++) {
            for (uint8 r = 0; r < 5; r++) {
                auction.setStakeTable(s, r, 100);
            }
        }

        vm.roll(100);
    }

    function _register() internal {
        vm.deal(filler, 1 ether);
        vm.prank(filler);
        auction.register{value: STAKE}(ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
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
        auction.register{value: STAKE + excess}(ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
        assertEq(auction.pendingReturns(filler), excess);
    }

    function test_register_revert_deadlinePassed() public {
        vm.roll(DEADLINE + 1);
        vm.deal(filler, 1 ether);
        vm.prank(filler);
        vm.expectRevert("deadline passed");
        auction.register{value: STAKE}(ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
    }

    function test_register_revert_alreadyRegistered() public {
        _register();
        vm.deal(filler, 1 ether);
        vm.prank(filler);
        vm.expectRevert("already registered");
        auction.register{value: STAKE}(ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
    }

    function test_register_revert_insufficientStake() public {
        vm.deal(filler, 1 ether);
        vm.prank(filler);
        vm.expectRevert("insufficient stake");
        auction.register{value: STAKE - 1}(ORDER_HASH, FILL_AMOUNT, ORDER_TOTAL, DEADLINE);
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

    function test_onFillSuccess_returnsStake() public {
        _register();
        reactor.callOnFillSuccess(ORDER_HASH, filler, FILL_AMOUNT);
        assertEq(auction.pendingReturns(filler), STAKE);
    }

    function test_onFillSuccess_revert_filledTooLittle() public {
        _register();
        uint256 tooLittle = FILL_AMOUNT * 89 / 100;
        vm.expectRevert("filled too little");
        reactor.callOnFillSuccess(ORDER_HASH, filler, tooLittle);
    }
}