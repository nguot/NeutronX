// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/libs/DynamicStakeLib.sol";
import "../../src/FillAuction.sol";

/// computeCollateral()/computeRefund() need storage to read collateralRate /
/// refundTable, so this contract holds its own copies (DynamicStakeLib's
/// bucket functions are pure/independent of any FillAuction instance) plus a
/// copy of FillAuction's *actual* constructor-default tables, so the same
/// checks run against both a hand-picked example and what gets deployed for
/// real.
contract DynamicStakeLibStakeTest is Test {
    uint32[4]    internal collateralRate; // hand-picked example, see setUp()
    uint32[5][4] internal refundTable;    // hand-picked example, see setUp()

    uint32[4]    internal liveCollateralRate; // copy of FillAuction's default
    uint32[5][4] internal liveRefundTable;    // copy of FillAuction's default

    function setUp() public {
        // Hand-picked example: collateralRate increases with order size
        // (no fill-ratio dimension - see computeCollateral), and refundTable
        // rows are non-decreasing across fill-ratio buckets and end at
        // 10000 (100% returned for a >=70% actual fill). This is the
        // configuration computeRefund's "small actual fill -> low refund"
        // property assumes - see DynamicStakeLibStake.md.
        collateralRate = [uint32(1000), 3000, 8000, 20000];
        uint32[5][4] memory rt = [
            [uint32(1000), 2000, 4000, 7000, 10000],
            [uint32(800),  1500, 3000, 6000, 10000],
            [uint32(500),  1000, 2500, 5000, 10000],
            [uint32(200),   500, 1500, 4000, 10000]
        ];
        for (uint8 s = 0; s < 4; s++) {
            for (uint8 r = 0; r < 5; r++) {
                refundTable[s][r] = rt[s][r];
            }
        }

        FillAuction auction = new FillAuction(makeAddr("treasury"), address(0), address(0), 0);
        for (uint8 s = 0; s < 4; s++) {
            liveCollateralRate[s] = auction.collateralRate(s);
            for (uint8 r = 0; r < 5; r++) {
                liveRefundTable[s][r] = auction.refundTable(s, r);
            }
        }
    }

    // ── raw table shape ──

    /// The sufficient, sampling-free property: every refundTable row must be
    /// non-decreasing across its 5 fill-ratio buckets and end at 10000
    /// (filling >=70% of the order always returns the full stake).
    function _assertRefundRowMonotonic(uint32[5][4] storage t) internal view {
        for (uint8 s = 0; s < 4; s++) {
            for (uint8 r = 0; r < 4; r++) {
                assertLe(t[s][r], t[s][r + 1], "refund row must be non-decreasing across fill-ratio buckets");
            }
            assertEq(t[s][4], 10000, "a >=70% actual fill must return the full stake");
        }
    }

    function test_refundTable_isMonotonicPerRow() public view {
        _assertRefundRowMonotonic(refundTable);
    }

    /// Ties to the FillAuction constructor: a freshly-deployed FillAuction's
    /// default refundTable must have non-decreasing rows ending at 10000.
    function test_FillAuctionDefaultRefundTable_isMonotonicPerRow() public view {
        _assertRefundRowMonotonic(liveRefundTable);
    }

    /// collateralRate must never be all-zero - that would make registration
    /// free regardless of fillAmount, the same failure mode the original
    /// stakeTable constructor fix addressed.
    function test_FillAuctionDefaultCollateralRate_isNonZero() public view {
        bool allZero = true;
        for (uint8 s = 0; s < 4; s++) {
            if (liveCollateralRate[s] != 0) { allZero = false; break; }
        }
        assertFalse(allZero, "FillAuction must not deploy with an all-zero (free) collateralRate");
    }

    // ── computeRefund at the tightest possible bucket boundaries ──

    /// For a fixed (stakeAmount, orderTotal), computeRefund must be
    /// non-decreasing in actualFillAmount. As with the old stakeTable check,
    /// interior sample points aren't enough - a small dip in a refund row
    /// only shows up for actualFillAmounts right at a bucket transition. So
    /// for each fill-ratio threshold (2%, 10%, 30%, 70%) this picks the
    /// largest actualFillAmount just below the threshold and the smallest at
    /// or above it - consecutive integers straddling the bucket change.
    function _assertRefundMonotonicAtBoundaries(uint32[5][4] storage t, uint256 stakeAmount, uint256 orderTotal) internal view {
        uint256[4] memory thresholdPct = [uint256(2), 10, 30, 70];
        for (uint256 i = 0; i < thresholdPct.length; i++) {
            uint256 fillHi = (thresholdPct[i] * orderTotal + 99) / 100; // ceil
            if (fillHi < 1) continue;
            uint256 fillLo = fillHi - 1;
            if (fillLo < 1) continue;

            uint32[5] memory row = t[DynamicStakeLib.getOrderSizeBucket(orderTotal)];
            uint256 refundLo = DynamicStakeLib.computeRefund(stakeAmount, fillLo, orderTotal, row);
            uint256 refundHi = DynamicStakeLib.computeRefund(stakeAmount, fillHi, orderTotal, row);
            assertLe(refundLo, refundHi, "refund must not decrease across a fill-ratio bucket boundary");
        }
    }

    function testFuzz_computeRefund_monotonicAtBucketBoundaries(
        uint256 stakeAmount,
        uint256 orderTotal
    ) public view {
        stakeAmount = bound(stakeAmount, 1, type(uint128).max);
        orderTotal  = bound(orderTotal, 100, 10_000_000e6);
        _assertRefundMonotonicAtBoundaries(refundTable, stakeAmount, orderTotal);
    }

    function testFuzz_FillAuctionDefaultRefundTable_computeRefund_monotonicAtBucketBoundaries(
        uint256 stakeAmount,
        uint256 orderTotal
    ) public view {
        stakeAmount = bound(stakeAmount, 1, type(uint128).max);
        orderTotal  = bound(orderTotal, 100, 10_000_000e6);
        _assertRefundMonotonicAtBoundaries(liveRefundTable, stakeAmount, orderTotal);
    }

    /// Filling >=70% of the order always returns the full stake, regardless
    /// of stake size or order size.
    function testFuzz_computeRefund_fullFillReturnsFullStake(uint256 stakeAmount, uint256 orderTotal) public view {
        stakeAmount = bound(stakeAmount, 1, type(uint128).max);
        orderTotal  = bound(orderTotal, 1, 10_000_000e6);
        assertEq(DynamicStakeLib.computeRefund(stakeAmount, orderTotal, orderTotal, liveRefundTable[DynamicStakeLib.getOrderSizeBucket(orderTotal)]), stakeAmount);
    }

    // ── computeCollateral: linear in fillAmount, no ratio dimension ──

    /// computeCollateral has no fill-ratio dimension, so for a fixed
    /// (orderTotal, deadline) it's linear in fillAmount - a larger ceiling is
    /// never cheaper than a smaller one. This is the property that makes
    /// "ceiling-shopping" (the old computeStake's failure mode, see
    /// DynamicStakeLibStake.md) impossible: there's no bucket boundary to dip
    /// across.
    function testFuzz_computeCollateral_monotonicInFillAmount(
        uint256 fillAmount1,
        uint256 fillAmount2,
        uint256 orderTotal,
        uint256 deadlineOffset
    ) public view {
        orderTotal = bound(orderTotal, 100, 10_000_000e6);
        fillAmount1 = bound(fillAmount1, 1, orderTotal);
        fillAmount2 = bound(fillAmount2, 1, orderTotal);
        if (fillAmount1 > fillAmount2) (fillAmount1, fillAmount2) = (fillAmount2, fillAmount1);
        uint256 deadline = block.number + bound(deadlineOffset, 1, 1000);

        // D-1: collateral is now sized off an ETH notional; treat the (bounded)
        // fillAmount as that notional. Monotonicity in the ceiling still holds.
        uint256 c1 = DynamicStakeLib.computeCollateral(fillAmount1, deadline, liveCollateralRate);
        uint256 c2 = DynamicStakeLib.computeCollateral(fillAmount2, deadline, liveCollateralRate);
        assertLe(c1, c2, "collateral must not decrease as the registered ceiling grows");
    }

    // ── concrete worked examples ──

    /// Ceiling-shopping is gone: registering for a 71% ceiling on a >$1M
    /// order is NOT cheaper than registering for a 1% ceiling - under the
    /// old (decreasing) stakeTable it was ($142k vs $200k for the original
    /// 0.05x-20x table). collateralRate has no ratio dimension, so cost
    /// scales exactly with the ceiling.
    function test_computeCollateral_noCeilingShoppingDiscount() public view {
        uint256 orderTotal = 2_000_000e6;          // sBucket 3 (>$1M)
        uint256 deadline   = block.number + 100;   // tBucket 0

        uint256 smallCeiling = orderTotal * 1 / 100;  // 1%
        uint256 bigCeiling   = orderTotal * 71 / 100; // 71%

        // D-1: both ceilings fall in the same ETH-notional bucket, so the rate is
        // identical and cost scales exactly with the ceiling (no discount).
        uint256 stakeSmall = DynamicStakeLib.computeCollateral(smallCeiling, deadline, liveCollateralRate);
        uint256 stakeBig   = DynamicStakeLib.computeCollateral(bigCeiling, deadline, liveCollateralRate);

        // The bigger ceiling costs proportionally more, never less.
        assertGe(stakeBig, stakeSmall);
        assertEq(stakeBig, stakeSmall * 71); // exactly proportional - same rate, no buckets
    }

    /// The "sniping fee" in action: filling only 1% of a >$1M order forfeits
    /// 99% of the collateral to the treasury; filling >=70% forfeits nothing.
    function test_computeRefund_smallActualFill_forfeitsMostStake() public view {
        uint256 orderTotal = 2_000_000e6;  // sBucket 3 (>$1M)
        uint256 stake      = 100e18;

        uint8 sBucket = DynamicStakeLib.getOrderSizeBucket(orderTotal);
        uint256 refundSmall = DynamicStakeLib.computeRefund(stake, orderTotal * 1 / 100, orderTotal, liveRefundTable[sBucket]);
        uint256 refundFull  = DynamicStakeLib.computeRefund(stake, orderTotal * 70 / 100, orderTotal, liveRefundTable[sBucket]);

        assertEq(refundSmall, stake * 100 / 10000); // refundTable[3][0] == 100 bps == 1% kept
        assertEq(refundFull, stake);                // refundTable[3][4] == 10000 bps == 100% kept
    }
}
