// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath}  from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUniswapV3Factory, IUniswapV3PoolOracle} from "../interfaces/IUniswapV3.sol";
import {IEthNotionalOracle} from "../interfaces/IEthNotionalOracle.sol";

/// D-1's original ETH-denominated collateral oracle (Uniswap V3 TWAP over the
/// (token, wrappedNative) pool), extracted out of DynamicStakeLib into its own
/// deployable contract so it's one swappable implementation of
/// IEthNotionalOracle rather than logic baked into the bond-math library
/// itself. Any Uniswap-V3-ABI-compatible fork (PancakeSwap V3, SushiSwap V3,
/// ...) works here — a chain with no such DEX needs a DIFFERENT
/// IEthNotionalOracle implementation, not a change to this one.
///
/// One instance per chain: `wrappedNative`/`uniV3Factory`/`twapWindow` are all
/// chain-specific deploy-time choices, immutable for the life of the oracle.
contract UniswapV3NotionalOracle is IEthNotionalOracle {
    address public immutable wrappedNative;
    address public immutable uniV3Factory;
    uint32  public immutable twapWindow;

    constructor(address _wrappedNative, address _uniV3Factory, uint32 _twapWindow) {
        require(_wrappedNative != address(0), "zero wrappedNative");
        require(_uniV3Factory  != address(0), "zero uniV3Factory");
        require(_twapWindow    > 0,           "zero twap window");
        wrappedNative = _wrappedNative;
        uniV3Factory  = _uniV3Factory;
        twapWindow    = _twapWindow;
    }

    /// D-1: value `amount` of `token` in this chain's native-token wei, via a
    /// Uniswap V3 TWAP over the (token, wrappedNative) pool at `feeTier`.
    /// token == wrappedNative -> 1:1 (no oracle needed).
    function quoteEthNotional(address token, uint256 amount, uint24 feeTier)
        external view returns (uint256)
    {
        if (token == wrappedNative) return amount;

        address pool = IUniswapV3Factory(uniV3Factory).getPool(token, wrappedNative, feeTier);
        require(pool != address(0), "no twap pool");

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives, ) = IUniswapV3PoolOracle(pool).observe(secondsAgos);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int24 meanTick = int24(delta / int56(uint56(twapWindow)));
        // round toward negative infinity (matches Uniswap's OracleLibrary)
        if (delta < 0 && (delta % int56(uint56(twapWindow)) != 0)) meanTick--;

        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(meanTick);
        return _quote(sqrtPriceX96, amount, token);
    }

    /// wrappedNative amount for `amountIn` of `token` at the given sqrt price.
    /// Mirrors Uniswap OracleLibrary.getQuoteAtTick.
    function _quote(uint160 sqrtPriceX96, uint256 amountIn, address token)
        private view returns (uint256 quote)
    {
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            quote = token < wrappedNative
                ? FullMath.mulDiv(ratioX192, amountIn, 1 << 192)
                : FullMath.mulDiv(1 << 192, amountIn, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 64);
            quote = token < wrappedNative
                ? FullMath.mulDiv(ratioX128, amountIn, 1 << 128)
                : FullMath.mulDiv(1 << 128, amountIn, ratioX128);
        }
    }
}
