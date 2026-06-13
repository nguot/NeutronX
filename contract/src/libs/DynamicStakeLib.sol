// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUniswapV3Factory, IUniswapV3PoolOracle} from "../interfaces/IUniswapV3.sol";

library DynamicStakeLib {
    // Order size (ETH notional): 0=<1, 1=1-10, 2=10-100, 3=>100 ETH  (4 buckets)
    // Fill ratio:  0=0-2%, 1=2-10%, 2=10-30%, 3=30-70%, 4=70-100%   (5 buckets)

    // 1x, 1.5x, 3x, 5x
    function _getTimeMultiplier(uint8 tBucket) internal pure returns (uint32) {
        if (tBucket == 0) return 10000;
        if (tBucket == 1) return 15000;
        if (tBucket == 2) return 30000;
        return 50000;
    }
    function getFillRatioBucket(
        uint256 fill,
        uint256 total
    ) internal pure returns (uint8) {
        if (fill >= total) return 4;
        uint256 pct = (fill * 100) / total;
        if (pct < 2) return 0;
        if (pct < 10) return 1;
        if (pct < 30) return 2;
        if (pct < 70) return 3;
        return 4;
    }

    /// D-1: order-size bucket on an ETH-denominated notional (wei). Token
    /// decimals/price are normalized away upstream by toEthNotional, so this is
    /// correct for any input token, not just 6-decimal stables.
    function getOrderSizeBucketETH(uint256 notionalEth) internal pure returns (uint8) {
        if (notionalEth < 1 ether)   return 0;
        if (notionalEth < 10 ether)  return 1;
        if (notionalEth < 100 ether) return 2;
        return 3;
    }

    /// Legacy USDC-denominated size bucket. Retained only for the refund-table
    /// shape tests; production collateral/refund now bucket on the ETH notional.
    function getOrderSizeBucket(uint256 total) internal pure returns (uint8) {
        // Đơn vị USDC (6 decimals)
        if (total < 10_000e6) return 0;
        if (total < 100_000e6) return 1;
        if (total < 1_000_000e6) return 2;
        return 3;
    }

    /// D-1: value `fillAmount` of `inputToken` in ETH (wei), via a Uniswap V3
    /// TWAP over the (inputToken, WETH) pool at the order's `feeTier`.
    /// - inputToken == weth  → 1:1 (no oracle needed)
    /// - factory == 0        → oracle disabled (test/mock mode): treats the raw
    ///                         amount as the notional, reproducing pre-D-1 behaviour
    /// The V3 price is already expressed in raw token units, so token decimals
    /// are handled automatically.
    function toEthNotional(
        uint256 fillAmount,
        address inputToken,
        uint24  feeTier,
        address weth,
        address uniV3Factory,
        uint32  twapWindow
    ) internal view returns (uint256) {
        if (uniV3Factory == address(0) || weth == address(0) || inputToken == weth) {
            return fillAmount;
        }
        address pool = IUniswapV3Factory(uniV3Factory).getPool(inputToken, weth, feeTier);
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
        return _quoteWeth(sqrtPriceX96, fillAmount, inputToken, weth);
    }

    /// WETH amount for `amountIn` of `inputToken` at the given sqrt price.
    /// Mirrors Uniswap OracleLibrary.getQuoteAtTick.
    function _quoteWeth(
        uint160 sqrtPriceX96,
        uint256 amountIn,
        address inputToken,
        address weth
    ) private pure returns (uint256 quote) {
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            quote = inputToken < weth
                ? FullMath.mulDiv(ratioX192, amountIn, 1 << 192)
                : FullMath.mulDiv(1 << 192, amountIn, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 64);
            quote = inputToken < weth
                ? FullMath.mulDiv(ratioX128, amountIn, 1 << 128)
                : FullMath.mulDiv(1 << 128, amountIn, ratioX128);
        }
    }

    function getTimeBucket(uint256 deadline) internal view returns (uint8) {
        if (block.number >= deadline) return 3;
        uint256 left = deadline - block.number;
        if (left > 50) return 0;
        if (left > 20) return 1;
        if (left > 5) return 2;
        return 3;
    }

    /// Registration-time collateral: notionalEth(ceiling, in ETH wei) x
    /// collateralRate[orderSizeBucket] x timeMultiplier. No fill-ratio
    /// dimension - linear in the notional, so a larger ceiling is never
    /// cheaper than a smaller one (no "ceiling-shopping" discount).
    ///
    /// D-1: the input is now an ETH-denominated notional (see toEthNotional),
    /// so the stake is dimensionally consistent with the ETH it is paid in,
    /// for any input token — not just WETH.
    function computeCollateral(
        uint256 notionalEth,
        uint256 deadline,
        uint32[4] storage collateralRate
    ) internal view returns (uint256) {
        uint8 sBucket = getOrderSizeBucketETH(notionalEth);
        uint8 tBucket = getTimeBucket(deadline);
        uint32 rateBps  = collateralRate[sBucket];
        uint32 timeMult = _getTimeMultiplier(tBucket);
        return
            FullMath.mulDiv(
                FullMath.mulDiv(notionalEth, rateBps, 10000),
                timeMult,
                10000
            );
    }

    /// Settlement-time refund: stakeAmount x
    /// refundRow[fillRatioBucket(actualFillAmount, committedFill)].
    /// D-2: the ratio is the fraction of the filler's OWN commitment delivered,
    /// not the fraction of the whole order. Delivering your full commitment (any
    /// size) returns the stake in full; only under-delivering vs. what you
    /// promised forfeits to the treasury.
    ///
    /// M-2: the row is snapshotted into the Registration at register time, so an
    /// owner who later rewrites the refund table cannot retroactively shrink the
    /// refund a filler was promised when they staked.
    function computeRefund(
        uint256 stakeAmount,
        uint256 actualFillAmount,
        uint256 committedFill,
        uint32[5] memory refundRow
    ) internal pure returns (uint256) {
        uint8 rBucket = getFillRatioBucket(actualFillAmount, committedFill);
        uint32 refundBps = refundRow[rBucket];
        return FullMath.mulDiv(stakeAmount, refundBps, 10000);
    }
}
