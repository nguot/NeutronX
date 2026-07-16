// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/crosschain/EscrowSrc.sol";
import "../../src/crosschain/EscrowSrcFactory.sol";
import "../../src/libs/DynamicStakeLib.sol";
import { IEthNotionalOracle } from "../../src/interfaces/IEthNotionalOracle.sol";
import "../mocks/MockERC20.sol";
import "../mocks/MockPermit2.sol";

/// Model 2 (filler-holds-key, continuous fill) tests for EscrowSrcFactory.
/// Supersedes the old Merkle-slot / cosigner-signature test suite: no more
/// merkleRoot/numSlots/cosignerSig/reopenSlot — instead per-fill hashlocks,
/// on-chain `remaining` accounting (RemainingLib, same as PartialFillReactor),
/// and a dynamic bond sized via DynamicStakeLib.
contract EscrowSrcFactoryTest is Test {
    EscrowSrc        public impl;
    EscrowSrcFactory public factory;
    MockPermit2      public permit2;
    MockERC20        public weth;

    uint256 swapperKey = 0xB0B;
    address swapper    = vm.addr(swapperKey);
    address filler     = makeAddr("filler");
    address keeper     = makeAddr("keeper");

    uint256 constant INPUT_AMOUNT  = 2 ether;
    uint256 constant FILL_AMOUNT   = 1 ether;
    uint256 constant DEADLINE_BASE = 1_000_000;
    // With oracle disabled, notionalEth == fillAmount (D-1 short-circuit).
    // StakeConfig below: collateralRate=1000bps (10%), timeMult=1x, single
    // bucket each way (empty threshold arrays) -> required = fillAmount * 10%.
    uint256 constant REQUIRED_BOND = FILL_AMOUNT / 10; // 0.1 ether for a 1 ether fill

    bytes32 secret0   = keccak256("secret-0");
    bytes32 secret1   = keccak256("secret-1");
    bytes32 hashlock0 = keccak256(abi.encodePacked(secret0));
    bytes32 hashlock1 = keccak256(abi.encodePacked(secret1));

    function setUp() public {
        permit2 = new MockPermit2();
        weth    = new MockERC20("Wrapped Ether", "WETH");
        impl    = new EscrowSrc();
        factory = new EscrowSrcFactory(
            address(impl), address(permit2), IEthNotionalOracle(address(0)), true, _stakeConfig()
        );

        weth.mint(swapper, INPUT_AMOUNT);
        vm.prank(swapper);
        weth.approve(address(permit2), type(uint256).max);

        vm.deal(filler, 10 ether);
        vm.warp(1000); // block.timestamp baseline well above 0
    }

    function _stakeConfig() internal pure returns (DynamicStakeLib.StakeConfig memory c) {
        c.collateralRate = new uint32[](1);
        c.collateralRate[0] = 1000; // 10%
        c.timeMult = new uint32[](1);
        c.timeMult[0] = 10000; // 1x
        c.refundTable = new uint32[](1);
        c.refundTable[0] = 10000;
        c.minCollateral = 0.001 ether;
    }

    function _info() internal view returns (EscrowSrcFactory.OrderInfo memory) {
        return EscrowSrcFactory.OrderInfo({
            swapper: swapper,
            inputToken: address(weth),
            inputAmount: INPUT_AMOUNT,
            outputToken: address(0xBEEF),
            minOutput: 0,
            deadlineBase: DEADLINE_BASE,
            nonce: 1,
            feeTier: 3000
        });
    }

    function _auth(bytes32 orderHash, bytes32 hashlock, uint256 fillAmount, uint256 t1, uint256 t2)
        internal pure returns (EscrowSrcFactory.FillAuth memory)
    {
        return EscrowSrcFactory.FillAuth({
            orderHash: orderHash, hashlock: hashlock, fillAmount: fillAmount, t1: t1, t2: t2
        });
    }

    function _signStruct(uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", factory.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fill(bytes32 hashlock, uint256 fillAmount, uint256 t1, uint256 t2, uint256 bond)
        internal returns (address escrow, bytes32 orderHash)
    {
        EscrowSrcFactory.OrderInfo memory info = _info();
        orderHash = factory.hashOrder(info);
        EscrowSrcFactory.FillAuth memory auth = _auth(orderHash, hashlock, fillAmount, t1, t2);

        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig    = _signStruct(swapperKey, factory.hashFill(auth));

        vm.prank(filler);
        escrow = factory.fillSlot{value: bond}(info, swapperSig, auth, fillSig);
    }

    // ── happy path: fill, then withdraw pays the filler + bond ────────────────

    function test_fillSlot_then_withdraw_paysFiller() public {
        address predicted = factory.computeAddress(factory.hashOrder(_info()), hashlock0);

        (address escrow, bytes32 orderHash) = _fill(hashlock0, FILL_AMOUNT, DEADLINE_BASE - 100, DEADLINE_BASE, REQUIRED_BOND);

        assertEq(escrow, predicted);
        assertEq(weth.balanceOf(escrow), FILL_AMOUNT);
        assertEq(EscrowSrc(escrow).safetyDeposit(), REQUIRED_BOND);
        assertTrue(factory.isFilled(orderHash, hashlock0));
        assertEq(factory.remainingInput(orderHash, INPUT_AMOUNT), INPUT_AMOUNT - FILL_AMOUNT);

        uint256 fillerWethBefore = weth.balanceOf(filler);
        uint256 fillerEthBefore  = filler.balance;

        // anyone can call withdraw once the secret is public
        vm.prank(keeper);
        EscrowSrc(escrow).withdraw(secret0);

        assertEq(weth.balanceOf(filler), fillerWethBefore + FILL_AMOUNT);
        assertEq(filler.balance, fillerEthBefore + REQUIRED_BOND);
        assertEq(EscrowSrc(escrow).status(), "withdrawn");
    }

    // ── partial fills: two fillers can split one order via `remaining` ────────

    function test_twoPartialFills_shareRemaining() public {
        (, bytes32 orderHash) = _fill(hashlock0, FILL_AMOUNT, DEADLINE_BASE - 100, DEADLINE_BASE, REQUIRED_BOND);
        assertEq(factory.remainingInput(orderHash, INPUT_AMOUNT), FILL_AMOUNT);

        address filler2 = makeAddr("filler2");
        vm.deal(filler2, 10 ether);

        EscrowSrcFactory.OrderInfo memory info = _info();
        EscrowSrcFactory.FillAuth memory auth2 = _auth(orderHash, hashlock1, FILL_AMOUNT, DEADLINE_BASE - 100, DEADLINE_BASE);
        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig2   = _signStruct(swapperKey, factory.hashFill(auth2));

        vm.prank(filler2);
        address escrow2 = factory.fillSlot{value: REQUIRED_BOND}(info, swapperSig, auth2, fillSig2);

        assertEq(weth.balanceOf(escrow2), FILL_AMOUNT);
        assertEq(factory.remainingInput(orderHash, INPUT_AMOUNT), 0);
    }

    // ── over-fill: a fill exceeding what's left reverts ───────────────────────

    function test_fillSlot_overRemaining_reverts() public {
        _fill(hashlock0, FILL_AMOUNT, DEADLINE_BASE - 100, DEADLINE_BASE, REQUIRED_BOND);

        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        // only FILL_AMOUNT left (INPUT_AMOUNT - FILL_AMOUNT), try to take more
        EscrowSrcFactory.FillAuth memory auth2 = _auth(orderHash, hashlock1, FILL_AMOUNT + 1, DEADLINE_BASE - 100, DEADLINE_BASE);
        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig2   = _signStruct(swapperKey, factory.hashFill(auth2));

        vm.prank(filler);
        vm.expectRevert("fill > remaining");
        factory.fillSlot{value: REQUIRED_BOND}(info, swapperSig, auth2, fillSig2);
    }

    // ── reused hashlock: CREATE2 collision reverts cleanly (no explicit bitmap needed) ──

    function test_fillSlot_reusedHashlock_reverts() public {
        _fill(hashlock0, FILL_AMOUNT, DEADLINE_BASE - 100, DEADLINE_BASE, REQUIRED_BOND);

        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        EscrowSrcFactory.FillAuth memory auth2 = _auth(orderHash, hashlock0, 0.1 ether, DEADLINE_BASE - 100, DEADLINE_BASE);
        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig2   = _signStruct(swapperKey, factory.hashFill(auth2));

        address otherFiller = makeAddr("otherFiller");
        vm.deal(otherFiller, 1 ether);
        vm.prank(otherFiller);
        vm.expectRevert(); // ERC1167Clone: create2 collision (already deployed)
        factory.fillSlot{value: REQUIRED_BOND / 10}(info, swapperSig, auth2, fillSig2);
    }

    // ── swapper's order-level signature must be genuine ───────────────────────

    function test_fillSlot_invalidSwapperSig_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        EscrowSrcFactory.FillAuth memory auth = _auth(orderHash, hashlock0, FILL_AMOUNT, DEADLINE_BASE - 100, DEADLINE_BASE);

        uint256 wrongKey = 0xBAD;
        bytes memory wrongSig = _signStruct(wrongKey, orderHash);
        bytes memory fillSig  = _signStruct(swapperKey, factory.hashFill(auth));

        vm.prank(filler);
        vm.expectRevert("invalid signature");
        factory.fillSlot{value: REQUIRED_BOND}(info, wrongSig, auth, fillSig);
    }

    // ── per-fill signature must be genuine — a filler cannot self-authorize ───

    function test_fillSlot_invalidPerFillSig_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        EscrowSrcFactory.FillAuth memory auth = _auth(orderHash, hashlock0, FILL_AMOUNT, DEADLINE_BASE - 100, DEADLINE_BASE);

        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        uint256 fillerKey = 0xF11E12; // filler tries to sign its own fill authorization
        bytes memory forgedFillSig = _signStruct(fillerKey, factory.hashFill(auth));

        vm.prank(filler);
        vm.expectRevert("invalid signature");
        factory.fillSlot{value: REQUIRED_BOND}(info, swapperSig, auth, forgedFillSig);
    }

    // ── Model 2's core enforced invariant: T2 must exceed T1, on-chain ────────

    function test_fillSlot_t2NotGreaterThanT1_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        uint256 t1 = DEADLINE_BASE - 100;
        EscrowSrcFactory.FillAuth memory auth = _auth(orderHash, hashlock0, FILL_AMOUNT, t1, t1); // t2 == t1

        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig    = _signStruct(swapperKey, factory.hashFill(auth));

        vm.prank(filler);
        vm.expectRevert("t2 must exceed t1");
        factory.fillSlot{value: REQUIRED_BOND}(info, swapperSig, auth, fillSig);
    }

    // ── t1 cannot exceed the order's deadlineBase ceiling ─────────────────────

    function test_fillSlot_t1BeyondDeadlineBase_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        EscrowSrcFactory.FillAuth memory auth = _auth(orderHash, hashlock0, FILL_AMOUNT, DEADLINE_BASE + 1, DEADLINE_BASE + 2);

        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig    = _signStruct(swapperKey, factory.hashFill(auth));

        vm.prank(filler);
        vm.expectRevert("t1 beyond deadlineBase");
        factory.fillSlot{value: REQUIRED_BOND}(info, swapperSig, auth, fillSig);
    }

    // ── bond below the dynamically-required stake is rejected ────────────────

    function test_fillSlot_bondBelowRequired_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        EscrowSrcFactory.FillAuth memory auth = _auth(orderHash, hashlock0, FILL_AMOUNT, DEADLINE_BASE - 100, DEADLINE_BASE);

        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig    = _signStruct(swapperKey, factory.hashFill(auth));

        vm.prank(filler);
        vm.expectRevert("bond below required stake");
        factory.fillSlot{value: REQUIRED_BOND - 1}(info, swapperSig, auth, fillSig);
    }

    // ── if the secret is never revealed, anyone can cancel after T1 ───────────

    function test_cancel_afterExpiry_refundsSwapper_andPaysSwapperBond() public {
        uint256 t1 = block.timestamp + 500;
        (address escrow, ) = _fill(hashlock0, FILL_AMOUNT, t1, t1 + 100, REQUIRED_BOND);

        vm.warp(t1 + 1);

        uint256 swapperWethBefore = weth.balanceOf(swapper);
        uint256 swapperEthBefore  = swapper.balance;
        uint256 keeperEthBefore   = keeper.balance;

        vm.prank(keeper);
        EscrowSrc(escrow).cancel();

        assertEq(weth.balanceOf(swapper), swapperWethBefore + FILL_AMOUNT);
        assertEq(swapper.balance, swapperEthBefore + REQUIRED_BOND); // bond -> swapper, not the caller
        assertEq(keeper.balance, keeperEthBefore);
        assertEq(EscrowSrc(escrow).status(), "cancelled");

        // §12.4 fix: the abandoned amount is now RESTORED to `remaining` — the
        // swapper's input is back in their wallet, so cancel() hands the slice
        // back to the order's fillable remainder (was: permanently spent).
        assertEq(factory.remainingInput(factory.hashOrder(_info()), INPUT_AMOUNT), INPUT_AMOUNT);
    }

    // ── §12.4: after an abandoned fill is cancelled, another filler can take
    //    the reopened slice with a FRESH hashlock ──────────────────────────────

    function test_refillAfterRestore() public {
        uint256 t1 = block.timestamp + 500;
        (address escrow, bytes32 orderHash) = _fill(hashlock0, FILL_AMOUNT, t1, t1 + 100, REQUIRED_BOND);
        assertEq(factory.remainingInput(orderHash, INPUT_AMOUNT), INPUT_AMOUNT - FILL_AMOUNT);

        // filler abandons; anyone cancels after T1 -> slice restored to remaining
        vm.warp(t1 + 1);
        EscrowSrc(escrow).cancel();
        assertEq(factory.remainingInput(orderHash, INPUT_AMOUNT), INPUT_AMOUNT);

        // a different filler refills the reopened slice using a NEW hashlock
        weth.mint(swapper, FILL_AMOUNT); // top up: original input went back to swapper on cancel
        address filler2 = makeAddr("filler2");
        vm.deal(filler2, 10 ether);

        // fresh timelocks in the future (the original t1 has now elapsed)
        uint256 t1b = block.timestamp + 500;
        EscrowSrcFactory.OrderInfo memory info = _info();
        EscrowSrcFactory.FillAuth memory auth2 = _auth(orderHash, hashlock1, FILL_AMOUNT, t1b, t1b + 100);
        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig2   = _signStruct(swapperKey, factory.hashFill(auth2));

        vm.prank(filler2);
        address escrow2 = factory.fillSlot{value: REQUIRED_BOND}(info, swapperSig, auth2, fillSig2);

        assertEq(weth.balanceOf(escrow2), FILL_AMOUNT);
        assertEq(factory.remainingInput(orderHash, INPUT_AMOUNT), INPUT_AMOUNT - FILL_AMOUNT);
    }

    // ── §12.4: restoreRemaining is only callable by the genuine clone ─────────

    function test_restoreRemaining_revert_notClone() public {
        (, bytes32 orderHash) = _fill(hashlock0, FILL_AMOUNT, DEADLINE_BASE - 100, DEADLINE_BASE, REQUIRED_BOND);

        // an arbitrary address cannot inflate `remaining`
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert("not escrow clone");
        factory.restoreRemaining(orderHash, hashlock0, FILL_AMOUNT);
    }

    // ── §12.4: a clone can only restore once (cancel is one-shot) ─────────────

    function test_restoreRemaining_doubleCancel_reverts() public {
        uint256 t1 = block.timestamp + 500;
        (address escrow, bytes32 orderHash) = _fill(hashlock0, FILL_AMOUNT, t1, t1 + 100, REQUIRED_BOND);

        vm.warp(t1 + 1);
        EscrowSrc(escrow).cancel();
        assertEq(factory.remainingInput(orderHash, INPUT_AMOUNT), INPUT_AMOUNT);

        // a second cancel reverts on "settled" — remaining cannot be inflated twice
        vm.expectRevert("settled");
        EscrowSrc(escrow).cancel();
        assertEq(factory.remainingInput(orderHash, INPUT_AMOUNT), INPUT_AMOUNT);
    }

    // ── zero fill amount / zero order amount are rejected up front ────────────

    function test_fillSlot_zeroFillAmount_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        EscrowSrcFactory.FillAuth memory auth = _auth(orderHash, hashlock0, 0, DEADLINE_BASE - 100, DEADLINE_BASE);

        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig    = _signStruct(swapperKey, factory.hashFill(auth));

        vm.prank(filler);
        vm.expectRevert("zero fill amount");
        factory.fillSlot{value: REQUIRED_BOND}(info, swapperSig, auth, fillSig);
    }

    function test_fillSlot_orderExpired_reverts() public {
        vm.warp(DEADLINE_BASE + 1);
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        EscrowSrcFactory.FillAuth memory auth = _auth(orderHash, hashlock0, FILL_AMOUNT, DEADLINE_BASE - 100, DEADLINE_BASE);

        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig    = _signStruct(swapperKey, factory.hashFill(auth));

        vm.prank(filler);
        vm.expectRevert("order expired");
        factory.fillSlot{value: REQUIRED_BOND}(info, swapperSig, auth, fillSig);
    }
}
