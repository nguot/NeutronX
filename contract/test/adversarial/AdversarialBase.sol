// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/PartialFillReactor.sol";
import "../../src/FillAuction.sol";
import "../mocks/MockERC20.sol";
import "../mocks/MockPermit2.sol";

/// Shared harness for the Adversary-A suite (MEV filler vs. users & other fillers).
///
/// There are NO filler "servers" here — a filler is just an address that sends
/// `register` / `executePartialChunk` transactions. An honest filler and an MEV
/// filler differ only by the *sequence* of calls a test makes on their behalf
/// (via vm.prank), which is exactly how on-chain MEV works once you strip away
/// the mempool race. Everything is in-process: mocked Permit2 + ERC20s, real
/// FillAuction + PartialFillReactor. No fork required.
///
/// Scale follows the live market: input = WETH-like (18 dec), output = USDC-like
/// (raw 6-dec amounts), price = output-per-WETH scaled 1e18 (so a 2_500e6 price
/// pays ~2500 "USDC" per WETH). The collateral oracle is deployed disabled
/// (factory == 0 → notional == fill amount), so stakes are deterministic.
abstract contract AdversarialBase is Test {
    PartialFillReactor public reactor;
    FillAuction         public auction;
    MockPermit2         public permit2;
    MockERC20           public weth;  // input token (swapper sells)
    MockERC20           public usdc;  // output token (filler pays)

    uint256 internal cosignerKey = 0xA11CE;
    address internal cosigner    = vm.addr(0xA11CE);
    address internal treasury    = makeAddr("treasury");
    address internal fallbackExec = makeAddr("fallbackExec");

    uint128 internal constant START_PRICE = 2_500e6; // ~2500 USDC per WETH
    uint24  internal constant FEE_TIER    = 3000;

    function _deployCore() internal {
        permit2 = new MockPermit2();
        auction = new FillAuction(treasury, address(0), address(0), 0); // oracle-disabled (notional == fill)
        reactor = new PartialFillReactor(address(permit2), address(auction), cosigner);
        auction.setReactor(address(reactor));
        reactor.setFallbackExecutor(fallbackExec);

        weth = new MockERC20("WETH", "WETH");
        usdc = new MockERC20("USDC", "USDC");

        vm.roll(100);
    }

    // ── order construction ──

    function _orderInfo(
        address swapper,
        uint256 inputAmount,
        uint256 minOutput,
        uint128 startPrice,
        uint32  decayPerBlock,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (PartialFillReactor.OrderInfo memory info) {
        info = PartialFillReactor.OrderInfo({
            swapper: swapper,
            inputToken: address(weth),
            inputAmount: inputAmount,
            outputToken: address(usdc),
            minOutputAmount: minOutput,
            deadline: deadline,
            nonce: nonce,
            minFillBps: 0,
            startPrice: startPrice,
            decayPerBlock: decayPerBlock,
            feeTier: FEE_TIER
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

    function _signed(PartialFillReactor.OrderInfo memory info)
        internal view returns (PartialFillReactor.SignedOrder memory)
    {
        return PartialFillReactor.SignedOrder({info: info, sig: _sign(info)});
    }

    // ── funding ──

    /// Swapper holds WETH and has approved Permit2 (the reactor pulls via Permit2).
    function _fundSwapper(address swapper, uint256 wethAmount) internal {
        weth.mint(swapper, wethAmount);
        vm.prank(swapper);
        weth.approve(address(permit2), type(uint256).max);
    }

    /// Filler holds USDC to pay swappers, has approved the reactor, and has ETH for stake.
    function _fundFiller(address filler, uint256 usdcAmount, uint256 eth) internal {
        usdc.mint(filler, usdcAmount);
        vm.prank(filler);
        usdc.approve(address(reactor), type(uint256).max);
        vm.deal(filler, eth);
    }

    /// Exact ETH collateral the auction will require for this fill.
    function _stake(PartialFillReactor.OrderInfo memory info, uint256 fill) internal view returns (uint256) {
        return auction.previewCollateral(info.inputToken, info.feeTier, fill, info.deadline);
    }

    /// Register `filler` for `fill` of `order`, posting the exact required stake.
    function _register(address filler, PartialFillReactor.SignedOrder memory order, uint256 fill) internal {
        uint256 stake = _stake(order.info, fill);
        vm.prank(filler);
        reactor.register{value: stake}(order, fill);
    }
}
