// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PartialFillReactor.sol";
import "../src/FillAuction.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockPermit2.sol";

/// Regression tests for the audit fixes (C-1, C-2, H-1, H-2, L-3) wired against
/// the real FillAuction + PartialFillReactor (only Permit2 / tokens are mocked).
contract AuditFixesTest is Test {
    PartialFillReactor public reactor;
    FillAuction         public auction;
    MockPermit2         public permit2;
    MockERC20           public inputToken;  // USDC-like
    MockERC20           public outputToken; // WETH-like

    uint256 cosignerKey = 0xA11CE;
    address public cosigner = vm.addr(cosignerKey);

    address public treasury = makeAddr("treasury");
    address public swapper   = makeAddr("swapper");
    address public fillerA   = makeAddr("fillerA");
    address public fillerB   = makeAddr("fillerB");
    address public fallbackExec = makeAddr("fallbackExec");

    uint256 constant INPUT_AMOUNT = 1000e6;
    uint128 constant START_PRICE  = 1e15;
    uint256 constant DEADLINE     = 1000;
    uint256 constant STAKE        = 1 ether; // far above the (tiny) required collateral

    function setUp() public {
        permit2 = new MockPermit2();
        auction = new FillAuction(treasury, address(0), address(0), 0); // oracle-disabled (1:1) mode
        reactor = new PartialFillReactor(address(permit2), address(auction), cosigner);
        auction.setReactor(address(reactor));
        reactor.setFallbackExecutor(fallbackExec);

        inputToken  = new MockERC20("USDC", "USDC");
        outputToken = new MockERC20("WETH", "WETH");

        inputToken.mint(swapper, INPUT_AMOUNT);
        vm.prank(swapper);
        inputToken.approve(address(permit2), type(uint256).max);

        outputToken.mint(fillerA, 100 ether);
        outputToken.mint(fillerB, 100 ether);
        vm.prank(fillerA);
        outputToken.approve(address(reactor), type(uint256).max);
        vm.prank(fillerB);
        outputToken.approve(address(reactor), type(uint256).max);

        vm.deal(fillerA, 10 ether);
        vm.deal(fillerB, 10 ether);
        vm.roll(100);
    }

    // ── helpers ──

    function _order(uint256 minOut, uint128 startPrice)
        internal view returns (PartialFillReactor.OrderInfo memory info)
    {
        info = PartialFillReactor.OrderInfo({
            swapper: swapper,
            inputToken: address(inputToken),
            inputAmount: INPUT_AMOUNT,
            outputToken: address(outputToken),
            minOutputAmount: minOut,
            deadline: DEADLINE,
            nonce: 1,
            minFillBps: 0,
            startPrice: startPrice,
            decayPerBlock: 0,
            feeTier: 3000
        });
    }

    function _hash(PartialFillReactor.OrderInfo memory info) internal view returns (bytes32) {
        return keccak256(abi.encode(
            reactor.ORDER_TYPE_HASH(),
            info.swapper, info.inputToken, info.inputAmount,
            info.outputToken, info.minOutputAmount,
            info.deadline, info.nonce, info.minFillBps,
            info.startPrice, info.decayPerBlock, info.feeTier
        ));
    }

    function _sign(PartialFillReactor.OrderInfo memory info) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reactor.DOMAIN_SEPARATOR(), _hash(info)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cosignerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signed(uint256 minOut, uint128 startPrice)
        internal view returns (PartialFillReactor.SignedOrder memory)
    {
        PartialFillReactor.OrderInfo memory info = _order(minOut, startPrice);
        return PartialFillReactor.SignedOrder({info: info, sig: _sign(info)});
    }

    function _register(address filler, PartialFillReactor.SignedOrder memory o, uint256 amt) internal {
        vm.prank(filler);
        reactor.register{value: STAKE}(o, amt);
    }

    // ── C-1: price curve is signed ──

    /// A filler cannot swap in a lower startPrice: it changes the order hash, so
    /// the cosigner signature no longer recovers to the cosigner. With M-3 this
    /// is now caught at registration, the earliest possible point.
    function test_C1_tamperedStartPrice_rejected() public {
        PartialFillReactor.SignedOrder memory o = _signed(0, START_PRICE);
        o.info.startPrice = 1; // tamper after signing
        vm.prank(fillerA);
        vm.expectRevert("invalid sig");
        reactor.register{value: STAKE}(o, INPUT_AMOUNT);
    }

    /// C-1: the swapper's min-output floor is enforced.
    function test_C1_minOutputFloor_enforced() public {
        uint256 fullOut = uint256(INPUT_AMOUNT) * START_PRICE / 1e18;
        PartialFillReactor.SignedOrder memory o = _signed(fullOut + 1, START_PRICE); // floor just above achievable
        _register(fillerA, o, INPUT_AMOUNT);
        vm.prank(fillerA);
        vm.expectRevert("min output");
        reactor.executePartialChunk(o, INPUT_AMOUNT);
    }

    // ── C-2: fallback / partial-fill mutual exclusion ──

    function test_C2_fallbackBlocksPartialFill() public {
        PartialFillReactor.SignedOrder memory o = _signed(0, START_PRICE);
        bytes32 h = _hash(o.info);
        _register(fillerA, o, INPUT_AMOUNT);

        vm.prank(fallbackExec);
        reactor.markFallbackInitiated(h);

        // remaining is now zeroed AND the fallback flag is set
        assertEq(reactor.remainingInput(h, INPUT_AMOUNT), 0);
        vm.prank(fillerA);
        vm.expectRevert("fallback initiated");
        reactor.executePartialChunk(o, INPUT_AMOUNT);
    }

    // ── H-1: lose-the-race registrant reclaims stake; cannot be slashed ──

    function test_H1_loserReclaimsStake_andCannotBeSlashed() public {
        PartialFillReactor.SignedOrder memory o = _signed(0, START_PRICE);
        bytes32 h = _hash(o.info);
        _register(fillerA, o, INPUT_AMOUNT);
        _register(fillerB, o, INPUT_AMOUNT);

        // A wins the whole order
        vm.prank(fillerA);
        reactor.executePartialChunk(o, INPUT_AMOUNT);
        assertEq(reactor.remainingInput(h, INPUT_AMOUNT), 0);

        // B was not at fault: cannot be slashed, can reclaim full stake
        vm.roll(DEADLINE + auction.SLASH_WINDOW() + 1);
        vm.expectRevert("order satisfied");
        auction.slash(h, fillerB);

        auction.releaseRegistration(h, fillerB);
        // full STAKE recovered: register-time excess + released collateral == STAKE
        assertEq(auction.pendingReturns(fillerB), STAKE);
    }

    // ── H-2: swapper cancellation cannot grief stakers into a slash ──

    function test_H2_cancelledOrder_notSlashable_reclaimable() public {
        PartialFillReactor.SignedOrder memory o = _signed(0, START_PRICE);
        bytes32 h = _hash(o.info);
        _register(fillerA, o, INPUT_AMOUNT);

        vm.prank(swapper);
        reactor.cancelOrder(o.info);

        vm.roll(DEADLINE + auction.SLASH_WINDOW() + 1);
        vm.expectRevert("cancelled");
        auction.slash(h, fillerA);

        auction.releaseRegistration(h, fillerA);
        assertEq(auction.pendingReturns(fillerA), STAKE);
    }

    // ── L-3: nonce invalidation stops fills ──

    function test_L3_invalidateNonce_blocksFill() public {
        PartialFillReactor.SignedOrder memory o = _signed(0, START_PRICE);
        _register(fillerA, o, INPUT_AMOUNT);

        vm.prank(swapper);
        reactor.invalidateNonce(1);

        vm.prank(fillerA);
        vm.expectRevert("nonce invalidated");
        reactor.executePartialChunk(o, INPUT_AMOUNT);
    }
}
