// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Pluggable ETH-denominated notional-value oracle. Decouples DynamicStakeLib's
/// bond-economics math (bucket/rate/refund tables — DEX-agnostic) from the
/// concrete pricing mechanism (Uniswap V3 TWAP, or any other source a chain
/// wants to use).
///
/// A chain without a Uniswap-V3-ABI-compatible DEX can supply a different
/// implementation of this interface (a Chainlink-fed oracle, a different AMM's
/// TWAP, etc.) — FillAuction and EscrowSrcFactory only ever call through this
/// interface, never a concrete DEX ABI directly. "Oracle disabled" (raw amount
/// treated as the notional) is a caller-level policy — see each contract's
/// `oracleDisabled` flag — not something an implementation of this interface
/// needs to support itself.
interface IEthNotionalOracle {
    /// Returns `amount` of `token` valued in wei of THIS chain's own native
    /// asset (e.g. ETH on an ETH L1/L2, POL on Polygon, ...) — never a
    /// cross-chain price. `feeTier` is passed through to whatever pool-fee
    /// concept the underlying DEX uses (ignored by oracles that don't have one).
    function quoteEthNotional(address token, uint256 amount, uint24 feeTier)
        external view returns (uint256);
}
