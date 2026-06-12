// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal slices of the Uniswap V3 factory + pool needed to read a TWAP for
// the D-1 ETH-denominated collateral oracle. Declared locally so the project
// does not need the full Uniswap v3 periphery packages (only v4-core is
// vendored, which supplies TickMath/FullMath).
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3PoolOracle {
    /// Returns the cumulative tick (and seconds-per-liquidity) values as of each
    /// `secondsAgo`. tickCumulatives[i] is the cumulative tick at block.timestamp - secondsAgos[i].
    function observe(uint32[] calldata secondsAgos)
        external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128);
}
