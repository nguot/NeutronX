// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/crosschain/EscrowSrc.sol";
import "../../src/crosschain/EscrowSrcFactory.sol";
import "../../src/crosschain/EscrowDst.sol";
import "../../src/crosschain/EscrowDstFactory.sol";
import "../../src/libs/DynamicStakeLib.sol";
import { IEthNotionalOracle } from "../../src/interfaces/IEthNotionalOracle.sol";
import "../mocks/MockERC20.sol";
import "../mocks/MockPermit2.sol";

/// Model 2 (filler-holds-key): T2 > T1 (dest closes AFTER source) is now an
/// on-chain ENFORCED invariant (EscrowSrcFactory.fillSlot rejects auth.t2 <=
/// auth.t1) — the opposite direction, and the opposite status, of what this
/// file used to test. The old suite demonstrated a Model-1 finding: `T2 < T1`
/// was only a comment, never checked, so a swapper could reclaim BOTH legs by
/// racing the destination claim() before its own T1 refund.
///
/// This file now demonstrates the Model 2 abandonment path is SAFE: if the
/// filler funds the destination escrow and then never reveals the secret
/// (aborts), the swapper is made whole on the source leg alone (refund + the
/// filler's forfeited bond) and never touches the destination escrow —
/// because dest refund() is only callable by the filler itself. No double-dip
/// in either direction.
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

    uint256 swapperKey = 0xB0B;
    address swapper    = vm.addr(swapperKey);
    address filler     = makeAddr("filler");

    uint256 constant INPUT_AMOUNT  = 1 ether;
    uint256 constant FILL_USDC     = 2500e6; // what the filler locks on Chain B
    uint256 constant DEADLINE_BASE = 1_000_000;
    uint256 constant BOND          = 0.1 ether; // 10% of 1 ether fill, oracle disabled

    bytes32 secret0   = keccak256("secret-0");
    bytes32 hashlock0 = keccak256(abi.encodePacked(secret0));

    function setUp() public {
        permit2    = new MockPermit2();
        weth       = new MockERC20("Wrapped Ether", "WETH");
        srcImpl    = new EscrowSrc();
        srcFactory = new EscrowSrcFactory(
            address(srcImpl), address(permit2), IEthNotionalOracle(address(0)), true, _stakeConfig()
        );

        usdc       = new MockERC20("USD Coin", "USDC");
        dstImpl    = new EscrowDst();
        dstFactory = new EscrowDstFactory(address(dstImpl));

        weth.mint(swapper, INPUT_AMOUNT);
        vm.prank(swapper);
        weth.approve(address(permit2), type(uint256).max);

        usdc.mint(filler, FILL_USDC);
        vm.deal(filler, 10 ether);

        vm.warp(1000);
    }

    function _stakeConfig() internal pure returns (DynamicStakeLib.StakeConfig memory c) {
        c.collateralRate = new uint32[](1);
        c.collateralRate[0] = 1000; // 10%
        c.timeMult = new uint32[](1);
        c.timeMult[0] = 10000;
        c.refundTable = new uint32[](1);
        c.refundTable[0] = 10000;
        c.minCollateral = 0.001 ether;
    }

    function _info() internal view returns (EscrowSrcFactory.OrderInfo memory) {
        return EscrowSrcFactory.OrderInfo({
            swapper: swapper,
            inputToken: address(weth),
            inputAmount: INPUT_AMOUNT,
            outputToken: address(usdc),
            minOutput: 0,
            deadlineBase: DEADLINE_BASE,
            nonce: 1,
            feeTier: 3000
        });
    }

    function _signStruct(uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", srcFactory.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // Fund + deploy the source escrow (expiry = t1).
    function _openSrc(uint256 t1, uint256 t2) internal returns (EscrowSrc escrow) {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = srcFactory.hashOrder(info);
        EscrowSrcFactory.FillAuth memory auth = EscrowSrcFactory.FillAuth({
            orderHash: orderHash, hashlock: hashlock0, fillAmount: INPUT_AMOUNT, t1: t1, t2: t2
        });

        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig    = _signStruct(swapperKey, srcFactory.hashFill(auth));

        vm.prank(filler);
        escrow = EscrowSrc(srcFactory.fillSlot{value: BOND}(info, swapperSig, auth, fillSig));
    }

    // Fund + deploy the destination escrow for the SAME hashlock (expiry = t2).
    function _openDst(uint256 t2) internal returns (EscrowDst escrow) {
        address predicted = dstFactory.computeAddress(hashlock0, filler);
        vm.prank(filler);
        usdc.transfer(predicted, FILL_USDC);

        vm.prank(filler);
        escrow = EscrowDst(dstFactory.deploy(hashlock0, swapper, address(usdc), FILL_USDC, t2));
    }

    // ── the invariant is now enforced ON-CHAIN, not just documented ──────────

    function test_t2NotGreaterThanT1_rejectedAtFillTime() public {
        EscrowSrcFactory.OrderInfo memory info = _info();
        bytes32 orderHash = srcFactory.hashOrder(info);
        uint256 t1 = block.timestamp + 200;
        // t2 == t1: violates "dest closes AFTER source"
        EscrowSrcFactory.FillAuth memory auth = EscrowSrcFactory.FillAuth({
            orderHash: orderHash, hashlock: hashlock0, fillAmount: INPUT_AMOUNT, t1: t1, t2: t1
        });
        bytes memory swapperSig = _signStruct(swapperKey, orderHash);
        bytes memory fillSig    = _signStruct(swapperKey, srcFactory.hashFill(auth));

        vm.prank(filler);
        vm.expectRevert("t2 must exceed t1");
        srcFactory.fillSlot{value: BOND}(info, swapperSig, auth, fillSig);
    }

    // ── abandonment is safe: filler forfeits only its own funds, no double-dip ──

    function test_abandonedFill_swapperMadeWholeOnceNoDoubleDip() public {
        uint256 t1 = block.timestamp + 100;
        uint256 t2 = t1 + 100; // t2 > t1, as enforced

        EscrowSrc src = _openSrc(t1, t2);
        EscrowDst dst = _openDst(t2);

        assertEq(src.expiry(), t1);
        assertEq(dst.expiry(), t2);
        assertGt(dst.expiry(), src.expiry());

        uint256 swapperWethBefore = weth.balanceOf(swapper);
        uint256 swapperUsdcBefore = usdc.balanceOf(swapper);
        uint256 swapperEthBefore  = swapper.balance;

        // Filler never reveals. Roll past T1: source refunds the swapper +
        // pays out the filler's forfeited bond. Dest is still active (T2 not
        // reached yet).
        //
        // NOTE: this test cannot simulate "nobody knows the secret" — secrecy
        // here is an OFF-CHAIN property (the secret only becomes public via
        // EscrowSrc's Withdrawn event, which never fires in this scenario
        // because the filler never calls withdraw()). The contract itself
        // has no way to distinguish "the correct preimage, supplied by
        // someone who legitimately learned it" from "the correct preimage,
        // supplied by a test that happens to already hold it" — hashlocks are
        // not access control. So this test deliberately does NOT call
        // dst.claim() at all in the abandonment branch (matching what an
        // honest observer who never saw a Withdrawn event actually could do)
        // and instead verifies the FILLER-refund path pays the filler alone.
        vm.warp(t1 + 1);
        assertEq(src.status(), "expired");
        assertEq(dst.status(), "active");

        src.cancel();
        assertEq(weth.balanceOf(swapper), swapperWethBefore + INPUT_AMOUNT);
        assertEq(swapper.balance, swapperEthBefore + BOND);

        // Roll past T2: only the FILLER can reclaim its own dest funds —
        // recipient (swapper) never touches this leg either way.
        vm.warp(t2 + 1);
        vm.prank(swapper);
        vm.expectRevert("not filler");
        dst.refund();

        vm.prank(filler);
        dst.refund();
        assertEq(usdc.balanceOf(filler), FILL_USDC);

        // Swapper ends up with exactly its refunded WETH + the filler's
        // forfeited bond — never the USDC too. No double-dip either direction.
        assertEq(usdc.balanceOf(swapper), swapperUsdcBefore);
    }
}
