// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/FillAuction.sol";

/// Minimal slice of the Uniswap V3 SwapRouter (original, with a `deadline` field).
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

/// Quantifies Trufy 3.5 / audit N-3: **collateral-oracle manipulation resistance as a
/// function of TWAP window length and attacker size.**
///
/// `TwapManipulation.t.sol` shows the *deployed* 60 s window collapses the required
/// collateral when an attacker pushes the (USDC, WETH, 0.05%) pool. This test turns
/// that single data point into a 2x3 table: two dump sizes (whale / moderate) read
/// back through three FillAuction instances configured with 60 / 600 / 1800 s windows.
///
/// Method (shared honest baseline via snapshot/revert, so every row is comparable):
///   1. Deploy three auctions (windows 60 / 600 / 1800 s) against the live pool and
///      snapshot each one's honest required collateral for a 3000-USDC order.
///   2. snapshot EVM state, then for each dump size:
///        a. dump USDC into the pool (crashes USDC's WETH-denominated price);
///        b. warp 120 s WITHOUT further trades — the manipulated tick now fills the
///           whole 60 s look-back, but only 120/600 (20%) and 120/1800 (~6.7%) of the
///           longer windows, which still average in honest historical observations;
///        c. re-read each collateral, tabulate the drop, revert to the honest state.
///
/// Two robust, theory-backed facts are asserted (exact magnitudes vary by fork block,
/// so they are logged, not asserted):
///   - the deployed 60 s window is gutted by a whale dump (drop > 50%);
///   - drop is monotonically NON-INCREASING in window length — a longer TWAP averages
///     the spike against more honest history, so it is never less resistant. This is
///     the on-chain evidence behind widening the window (bounded below by
///     minCollateral) before any mainnet deployment.
contract TwapWindowComparisonTest is Test {
    address constant WETH        = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC        = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant FACTORY     = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address constant SWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    uint24  constant FEE         = 500; // 0.05% pool — the tier the order prices through

    address treasury = makeAddr("treasury");
    address attacker = makeAddr("attacker");

    uint256 constant FILL_USDC = 3000e6; // ~1 ETH of value at the honest price

    // Pinned for reproducibility + on-disk fork caching (retries don't re-hit RPC).
    uint256 constant FORK_BLOCK = 25_423_900;

    FillAuction[3] auctions;
    uint32[3]      windows = [uint32(60), uint32(600), uint32(1800)];
    uint256[3]     baseline;
    uint256        deadline;

    function setUp() public {
        vm.createSelectFork(vm.envString("ALCHEMY_RPC_URL"), FORK_BLOCK);
        deadline = block.number + 100;
        for (uint256 i = 0; i < 3; i++) {
            auctions[i] = new FillAuction(treasury, WETH, FACTORY, windows[i], false);
            baseline[i] = auctions[i].previewCollateral(USDC, FEE, FILL_USDC, deadline);
            assertGt(baseline[i], 0, "baseline collateral must be non-zero");
        }
    }

    function test_windowResistance_acrossDumpSizes() public {
        uint256 honest = vm.snapshotState();

        emit log_string("=== TWAP window vs collateral-manipulation resistance (3000 USDC order, 120s hold) ===");
        emit log_named_uint("honest collateral 60s  (wei)", baseline[0]);
        emit log_named_uint("honest collateral 600s (wei)", baseline[1]);
        emit log_named_uint("honest collateral 1800s(wei)", baseline[2]);

        // Row 1 — moderate attacker.
        uint256[3] memory dropModerate = _runDump(30_000_000e6, "MODERATE dump = 30M USDC");
        vm.revertToState(honest);

        // Row 2 — whale attacker.
        uint256[3] memory dropWhale = _runDump(300_000_000e6, "WHALE dump = 300M USDC");

        // ── Assertions: only the fork-stable, theory-backed facts ──────────────
        // The deployed 60 s window is broken by a whale.
        assertGt(dropWhale[0], 5000, "60s window must collapse >50% under a whale dump");

        // Monotonic non-increasing resistance for BOTH dump sizes (the core theorem).
        assertLe(dropModerate[1], dropModerate[0], "600s resists >= 60s (moderate)");
        assertLe(dropModerate[2], dropModerate[1], "1800s resists >= 600s (moderate)");
        assertLe(dropWhale[1],    dropWhale[0],    "600s resists >= 60s (whale)");
        assertLe(dropWhale[2],    dropWhale[1],    "1800s resists >= 600s (whale)");

        // The longest window is strictly more robust than the deployed one.
        assertLt(dropWhale[2],    dropWhale[0],    "1800s strictly resists better than 60s (whale)");
    }

    /// Dump `amountIn` USDC into the pool, hold 120 s, and return the per-window
    /// collateral drop in basis points. Logs a row of the results table.
    function _runDump(uint256 amountIn, string memory label) internal returns (uint256[3] memory dropBps) {
        deal(USDC, attacker, amountIn);
        vm.startPrank(attacker);
        IERC20(USDC).approve(SWAP_ROUTER, amountIn);
        ISwapRouter(SWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: FEE,
                recipient: attacker,
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();

        vm.warp(block.timestamp + 120);

        emit log_string(label);
        emit log_string("  window(s) | after(wei) | drop(bps)");
        for (uint256 i = 0; i < 3; i++) {
            uint256 cAfter = auctions[i].previewCollateral(USDC, FEE, FILL_USDC, deadline);
            dropBps[i] = baseline[i] > cAfter ? (baseline[i] - cAfter) * 10_000 / baseline[i] : 0;
            emit log_named_uint("  window(s)", windows[i]);
            emit log_named_uint("    after (wei)", cAfter);
            emit log_named_uint("    drop (bps)", dropBps[i]);
        }
    }
}
