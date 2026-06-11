// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

library DynamicStakeLib {
    // Order size:  0=<$10k, 1=$10k-$100k, 2=$100k-$1M, 3=>$1M       (4 buckets)
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

    function getOrderSizeBucket(uint256 total) internal pure returns (uint8) {
        // Đơn vị USDC (6 decimals)
        if (total < 10_000e6) return 0;
        if (total < 100_000e6) return 1;
        if (total < 1_000_000e6) return 2;
        return 3;
    }

    function getTimeBucket(uint256 deadline) internal view returns (uint8) {
        if (block.number >= deadline) return 3;
        uint256 left = deadline - block.number;
        if (left > 50) return 0;
        if (left > 20) return 1;
        if (left > 5) return 2;
        return 3;
    }

    /// Registration-time collateral: fillAmount(ceiling) x
    /// collateralRate[orderSizeBucket] x timeMultiplier. No fill-ratio
    /// dimension - linear in fillAmount, so a larger ceiling is never
    /// cheaper than a smaller one (no "ceiling-shopping" discount).
    function computeCollateral(
        uint256 fillAmount,
        uint256 orderTotal,
        uint256 deadline,
        uint32[4] storage collateralRate
    ) internal view returns (uint256) {
        uint8 sBucket = getOrderSizeBucket(orderTotal);
        uint8 tBucket = getTimeBucket(deadline);
        uint32 rateBps  = collateralRate[sBucket];
        uint32 timeMult = _getTimeMultiplier(tBucket);
        return
            FullMath.mulDiv(
                FullMath.mulDiv(fillAmount, rateBps, 10000),
                timeMult,
                10000
            );
    }

    /// Settlement-time refund: stakeAmount x
    /// refundTable[orderSizeBucket][fillRatioBucket(actualFillAmount, orderTotal)].
    /// A small actual fill returns only a small fraction of the collateral
    /// (the rest is forfeited to the treasury as a "sniping fee"); filling
    /// >=70% of the order returns it in full.
    function computeRefund(
        uint256 stakeAmount,
        uint256 actualFillAmount,
        uint256 orderTotal,
        uint32[5][4] storage refundTable
    ) internal view returns (uint256) {
        uint8 sBucket = getOrderSizeBucket(orderTotal);
        uint8 rBucket = getFillRatioBucket(actualFillAmount, orderTotal);
        uint32 refundBps = refundTable[sBucket][rBucket];
        return FullMath.mulDiv(stakeAmount, refundBps, 10000);
    }
}
