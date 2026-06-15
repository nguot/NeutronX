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

    // ── Trufy 3.1: a per-SESSION cosigner key is rejected. The factory accepts
    //    exactly one immutable cosigner; the backend must therefore sign every
    //    order with that single server key, never a per-swapper-derived key.
    //    This pins the on-chain half of the fix — if the backend regresses to a
    //    per-session signing key, fillSlot reverts here exactly like this.
    function test_fillSlot_perSessionCosignerKey_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory swapperSig = _sign(swapperKey, orderHash);

        // A fresh per-session key (what the old backend derived from rootSecret).
        uint256 perSessionKey = 0x5E5510;
        assertTrue(vm.addr(perSessionKey) != cosigner, "test setup: keys must differ");
        bytes memory perSessionSig = _sign(perSessionKey, orderHash);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;

        vm.prank(filler);
        vm.expectRevert("invalid signature");
        factory.fillSlot{value: DEPOSIT}(info, swapperSig, perSessionSig, 0, hashlock0, proof0);
    }

    // ── Trufy 3.1: the single server cosigner serves multiple distinct swappers.
    //    Two different swappers' orders both verify against the SAME immutable
    //    cosigner — the property the per-session model could never satisfy.
    function test_fillSlot_singleCosigner_servesMultipleSwappers() public {
        // First swapper (the default `swapper`) fills slot 0.
        EscrowSrcFactory.OrderInfo memory info0 = _info();
        bytes32 orderHash0 = factory.hashOrder(info0);
        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;
        vm.prank(filler);
        factory.fillSlot{value: DEPOSIT}(
            info0, _sign(swapperKey, orderHash0), _sign(cosignerKey, orderHash0), 0, hashlock0, proof0
        );

        // A second, unrelated swapper — same single cosigner signs their order too.
        uint256 swapper2Key = 0xCAFE;
        address swapper2     = vm.addr(swapper2Key);
        weth.mint(swapper2, INPUT_AMOUNT);
        vm.prank(swapper2);
        weth.approve(address(permit2), type(uint256).max);

        EscrowSrcFactory.OrderInfo memory info2 = _info();
        info2.swapper = swapper2;
        info2.nonce   = 2;
        bytes32 orderHash2 = factory.hashOrder(info2);

        vm.prank(filler);
        address escrow2 = factory.fillSlot{value: DEPOSIT}(
            info2, _sign(swapper2Key, orderHash2), _sign(cosignerKey, orderHash2), 0, hashlock0, proof0
        );
        assertTrue(factory.isSlotFilled(orderHash2, 0));
        assertEq(weth.balanceOf(escrow2), 1 ether);
    }

    // ── if the secret is never revealed, anyone can cancel after expiry ──────

    function test_cancel_afterExpiry_refundsSwapper_andPaysSwapperDeposit() public {
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
        uint256 swapperEthBefore  = swapper.balance;
        uint256 keeperEthBefore   = keeper.balance;

        // A keeper triggers cleanup, but the safety deposit now compensates the
        // SWAPPER, not the caller — so a griefer cannot self-cancel to reclaim it.
        vm.prank(keeper);
        EscrowSrc(escrow).cancel();

        assertEq(weth.balanceOf(swapper), swapperWethBefore + 1 ether); // lastSlotAmount for slot 1
        assertEq(swapper.balance, swapperEthBefore + DEPOSIT);          // deposit → swapper
        assertEq(keeper.balance, keeperEthBefore);                      // caller gets nothing
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

        // 3.7: a zero (or dust) deposit is now rejected by the factory's
        // griefing floor before the escrow is ever initialized.
        vm.prank(filler);
        vm.expectRevert("deposit below floor");
        factory.fillSlot{value: 0}(info, swapperSig, cosignerSig, 0, hashlock0, proof0);
    }

    // ── 3.7: a positive-but-dust deposit below the floor is also rejected ──────
    function test_fillSlot_dustSafetyDeposit_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory swapperSig  = _sign(swapperKey, orderHash);
        bytes memory cosignerSig = _sign(cosignerKey, orderHash);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;

        uint256 dust = factory.MIN_SAFETY_DEPOSIT() - 1;
        vm.prank(filler);
        vm.expectRevert("deposit below floor");
        factory.fillSlot{value: dust}(info, swapperSig, cosignerSig, 0, hashlock0, proof0);
    }

    // ── 3.8: orders where inputAmount < numSlots (slotAmount rounds to 0) are
    //         rejected at creation, before any funds are pulled ────────────────
    function test_fillSlot_zeroSlotAmount_reverts() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        info.inputAmount = 1; // 1 wei across 2 slots → slotAmount = 0
        bytes32 orderHash = factory.hashOrder(info);
        bytes memory swapperSig  = _sign(swapperKey, orderHash);
        bytes memory cosignerSig = _sign(cosignerKey, orderHash);

        // hashlock/proof are never reached — the slotAmount guard fires first.
        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;

        vm.prank(filler);
        vm.expectRevert("slot amount zero");
        factory.fillSlot{value: DEPOSIT}(info, swapperSig, cosignerSig, 0, hashlock0, proof0);
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
