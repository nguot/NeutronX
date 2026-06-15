// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/crosschain/EscrowSrc.sol";
import "../../src/crosschain/EscrowSrcFactory.sol";
import "../mocks/MockERC20.sol";
import "../mocks/MockPermit2.sol";

contract EscrowSrcFactoryTest is Test {
    EscrowSrc        public impl;
    EscrowSrcFactory public factory;
    MockPermit2      public permit2;
    MockERC20        public weth;

    uint256 cosignerKey = 0xA11CE;
    uint256 swapperKey  = 0xB0B;
    address cosigner = vm.addr(cosignerKey);
    address swapper  = vm.addr(swapperKey);
    address filler   = makeAddr("filler");
    address keeper   = makeAddr("keeper");

    uint256 constant INPUT_AMOUNT = 2 ether; // 2 slots x 1 ether
    uint8   constant NUM_SLOTS    = 2;
    uint256 constant DEADLINE     = 200;
    uint256 constant DEPOSIT      = 0.01 ether;

    bytes32 secret0;
    bytes32 secret1;
    bytes32 hashlock0;
    bytes32 hashlock1;
    bytes32 leaf0;
    bytes32 leaf1;
    bytes32 root;

    function setUp() public {
        permit2 = new MockPermit2();
        weth    = new MockERC20("Wrapped Ether", "WETH");
        impl    = new EscrowSrc();
        factory = new EscrowSrcFactory(address(impl), address(permit2), cosigner);

        weth.mint(swapper, INPUT_AMOUNT);
        vm.prank(swapper);
        weth.approve(address(permit2), type(uint256).max);

        vm.deal(filler, 10 ether);

        secret0   = keccak256("secret-0");
        secret1   = keccak256("secret-1");
        hashlock0 = keccak256(abi.encodePacked(secret0));
        hashlock1 = keccak256(abi.encodePacked(secret1));
        leaf0     = keccak256(bytes.concat(keccak256(abi.encode(hashlock0, uint8(0)))));
        leaf1     = keccak256(bytes.concat(keccak256(abi.encode(hashlock1, uint8(1)))));
        root      = _hashPair(leaf0, leaf1);

        vm.roll(100);
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _info() internal view returns (EscrowSrcFactory.OrderInfo memory) {
        return EscrowSrcFactory.OrderInfo({
            swapper: swapper,
            inputToken: address(weth),
            inputAmount: INPUT_AMOUNT,
            outputToken: address(0xBEEF),
            minOutput: 0,
            deadline: DEADLINE,
            nonce: 1,
            merkleRoot: root,
            numSlots: NUM_SLOTS
        });
    }

    function _sign(uint256 key, bytes32 orderHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", factory.DOMAIN_SEPARATOR(), orderHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── happy path: fill slot 0, then withdraw pays the filler + deposit ──────

    function test_fillSlot_then_withdraw_paysFiller() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory swapperSig  = _sign(swapperKey, orderHash);
        bytes memory cosignerSig = _sign(cosignerKey, orderHash);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;

        address predicted = factory.computeAddress(orderHash, 0);

        vm.prank(filler);
        address escrow = factory.fillSlot{value: DEPOSIT}(info, swapperSig, cosignerSig, 0, hashlock0, proof0);

        assertEq(escrow, predicted);
        assertEq(weth.balanceOf(escrow), 1 ether);
        assertEq(EscrowSrc(escrow).safetyDeposit(), DEPOSIT);
        assertTrue(factory.isSlotFilled(orderHash, 0));

        uint256 fillerWethBefore = weth.balanceOf(filler);
        uint256 fillerEthBefore  = filler.balance;

        // anyone can call withdraw once the secret is public on Chain B
        vm.prank(keeper);
        EscrowSrc(escrow).withdraw(secret0);

        assertEq(weth.balanceOf(filler), fillerWethBefore + 1 ether);
        assertEq(filler.balance, fillerEthBefore + DEPOSIT);
        assertEq(EscrowSrc(escrow).status(), "withdrawn");
    }

    // ── racing fillers: second fillSlot for the same slot reverts cleanly ────

    function test_fillSlot_secondTime_revertsSlotAlreadyFilled() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory swapperSig  = _sign(swapperKey, orderHash);
        bytes memory cosignerSig = _sign(cosignerKey, orderHash);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;

        vm.prank(filler);
        factory.fillSlot{value: DEPOSIT}(info, swapperSig, cosignerSig, 0, hashlock0, proof0);

        address otherFiller = makeAddr("otherFiller");
        vm.deal(otherFiller, 1 ether);
        vm.prank(otherFiller);
        vm.expectRevert("slot already filled");
        factory.fillSlot{value: DEPOSIT}(info, swapperSig, cosignerSig, 0, hashlock0, proof0);
    }

    // ── a hashlock/proof not in the tree must be rejected before any funds move ──

    function test_fillSlot_invalidProof_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory swapperSig  = _sign(swapperKey, orderHash);
        bytes memory cosignerSig = _sign(cosignerKey, orderHash);

        // leaf0 is not a sibling of itself — invalid proof for slot 0
        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = leaf0;

        vm.prank(filler);
        vm.expectRevert("invalid merkle proof");
        factory.fillSlot{value: DEPOSIT}(info, swapperSig, cosignerSig, 0, hashlock0, badProof);
    }

    // ── order registration requires both swapper and cosigner signatures ─────

    function test_fillSlot_invalidSwapperSig_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory cosignerSig = _sign(cosignerKey, orderHash);
        bytes memory wrongSig    = _sign(cosignerKey, orderHash); // signed by cosigner, not swapper

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;

        vm.prank(filler);
        vm.expectRevert("invalid signature");
        factory.fillSlot{value: DEPOSIT}(info, wrongSig, cosignerSig, 0, hashlock0, proof0);
    }

    // ── if the secret is never revealed, anyone can cancel after expiry ──────

    function test_cancel_afterExpiry_refundsSwapper_andPaysCanceller() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory swapperSig  = _sign(swapperKey, orderHash);
        bytes memory cosignerSig = _sign(cosignerKey, orderHash);

        bytes32[] memory proof1 = new bytes32[](1);
        proof1[0] = leaf0;

        vm.prank(filler);
        address escrow = factory.fillSlot{value: DEPOSIT}(info, swapperSig, cosignerSig, 1, hashlock1, proof1);

        // escrow.expiry == order.deadline == DEADLINE; roll past it
        vm.roll(DEADLINE + 1);

        uint256 swapperWethBefore = weth.balanceOf(swapper);
        uint256 keeperEthBefore   = keeper.balance;

        vm.prank(keeper);
        EscrowSrc(escrow).cancel();

        assertEq(weth.balanceOf(swapper), swapperWethBefore + 1 ether); // lastSlotAmount for slot 1
        assertEq(keeper.balance, keeperEthBefore + DEPOSIT);
        assertEq(EscrowSrc(escrow).status(), "cancelled");
    }

    // ── M-3: a zero-value safety deposit is rejected ──────────────────────────

    function test_fillSlot_zeroSafetyDeposit_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory swapperSig  = _sign(swapperKey, orderHash);
        bytes memory cosignerSig = _sign(cosignerKey, orderHash);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;

        vm.prank(filler);
        vm.expectRevert("zero safety deposit");
        factory.fillSlot{value: 0}(info, swapperSig, cosignerSig, 0, hashlock0, proof0);
    }

    // ── M-3: a slot whose escrow was grief-filled (by someone who can never
    // reveal the secret) and then cancelled after expiry can be reopened —
    // clearing the permanently-set filledBitmap bit and pointing
    // computeAddress at a fresh CREATE2 clone for any future fill ───────────

    function test_reopenSlot_beforeCancel_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory swapperSig  = _sign(swapperKey, orderHash);
        bytes memory cosignerSig = _sign(cosignerKey, orderHash);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;

        vm.prank(filler);
        factory.fillSlot{value: DEPOSIT}(info, swapperSig, cosignerSig, 0, hashlock0, proof0);

        vm.expectRevert("escrow not cancelled");
        factory.reopenSlot(orderHash, 0);
    }

    function test_reopenSlot_afterCancel_clearsBitmapAndBumpsAttempt() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory swapperSig  = _sign(swapperKey, orderHash);
        bytes memory cosignerSig = _sign(cosignerKey, orderHash);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;

        vm.prank(filler);
        address escrow0 = factory.fillSlot{value: DEPOSIT}(info, swapperSig, cosignerSig, 0, hashlock0, proof0);

        // secret never revealed -> anyone cancels after expiry, refunding the
        // swapper and forfeiting the deposit to the canceller.
        vm.roll(DEADLINE + 1);
        vm.prank(keeper);
        EscrowSrc(escrow0).cancel();

        assertTrue(factory.isSlotFilled(orderHash, 0));
        assertEq(factory.attempt(orderHash, 0), 0);

        factory.reopenSlot(orderHash, 0);

        assertFalse(factory.isSlotFilled(orderHash, 0));
        assertEq(factory.attempt(orderHash, 0), 1);

        address freshAddr = factory.computeAddress(orderHash, 0);
        assertTrue(freshAddr != escrow0, "reopened slot should map to a fresh clone address");

        // already cleared -> cannot reopen again
        vm.expectRevert("slot not filled");
        factory.reopenSlot(orderHash, 0);
    }
}
