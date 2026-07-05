// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/libs/DynamicStakeLib.sol";
import "../../src/FillAuction.sol";

/// computeCollateral()/computeRefund() now take a full (dynamic) StakeConfig,
/// so this contract holds its own copies as storage StakeConfigs — one
/// hand-picked example (same shape as FillAuction's default: 4 size buckets x
/// 5 fill-ratio buckets, different VALUES) and one that is a live copy of a
/// freshly-deployed FillAuction's actual constructor-default config, so the
/// same checks run against both a hand-picked example and what gets deployed
/// for real.
contract DynamicStakeLibStakeTest is Test {
    DynamicStakeLib.StakeConfig internal cfg;      // hand-picked example, see setUp()
    DynamicStakeLib.StakeConfig internal liveCfg;  // copy of FillAuction's default

    function _defaultShapeThresholds()
        internal
        pure
        returns (uint256[] memory sizeThresholds, uint256[] memory timeThresholds, uint32[] memory timeMult, uint256[] memory ratioThresholds)
    {
        sizeThresholds = new uint256[](3);
        sizeThresholds[0] = 1 ether;
        sizeThresholds[1] = 10 ether;
        sizeThresholds[2] = 100 ether;

        timeThresholds = new uint256[](3);
        timeThresholds[0] = 50;
        timeThresholds[1] = 20;
        timeThresholds[2] = 5;

        timeMult = new uint32[](4);
        timeMult[0] = 10000;
        timeMult[1] = 15000;
        timeMult[2] = 30000;
        timeMult[3] = 50000;

        ratioThresholds = new uint256[](4);
        ratioThresholds[0] = 200;
        ratioThresholds[1] = 1000;
        ratioThresholds[2] = 3000;
        ratioThresholds[3] = 7000;
    }

    function setUp() public {
        // Hand-picked example: collateralRate increases with order size
        // (no fill-ratio dimension - see computeCollateral), and refundTable
        // rows are non-decreasing across fill-ratio buckets and end at
        // 10000 (100% returned for a >=70% actual fill). This is the
        // configuration computeRefund's "small actual fill -> low refund"
        // property assumes - see DynamicStakeLibStake.md. Same bucket SHAPE
        // as FillAuction's default (4x5), only the rate/refund VALUES differ.
        (cfg.sizeThresholds, cfg.timeThresholds, cfg.timeMult, cfg.ratioThresholds) = _defaultShapeThresholds();

        cfg.collateralRate = new uint32[](4);
        cfg.collateralRate[0] = 1000;
        cfg.collateralRate[1] = 3000;
        cfg.collateralRate[2] = 8000;
        cfg.collateralRate[3] = 20000;

        uint32[5][4] memory rt = [
            [uint32(1000), 2000, 4000, 7000, 10000],
            [uint32(800),  1500, 3000, 6000, 10000],
            [uint32(500),  1000, 2500, 5000, 10000],
            [uint32(200),   500, 1500, 4000, 10000]
        ];
        cfg.refundTable = new uint32[](20);
        for (uint256 s = 0; s < 4; s++) {
            for (uint256 r = 0; r < 5; r++) {
                cfg.refundTable[s * 5 + r] = rt[s][r];
            }
        }

        FillAuction auction = new FillAuction(makeAddr("treasury"), address(0), address(0), 0, true);
        // Direct memory -> storage struct assignment deep-copies every dynamic
        // array member (same mechanism FillAuction.setStakeConfig relies on).
        liveCfg = auction.stakeConfig();
    }

    // ── raw table shape ──

    /// The sufficient, sampling-free property: every refundTable row must be
    /// non-decreasing across its R fill-ratio buckets and end at 10000
    /// (filling >=70% of the order always returns the full stake).
    function _assertRefundRowMonotonic(DynamicStakeLib.StakeConfig storage t) internal view {
        uint256 S = t.collateralRate.length;
        uint256 R = t.ratioThresholds.length + 1;
        for (uint256 s = 0; s < S; s++) {
            for (uint256 r = 0; r < R - 1; r++) {
                assertLe(t.refundTable[s * R + r], t.refundTable[s * R + r + 1], "refund row must be non-decreasing across fill-ratio buckets");
            }
            assertEq(t.refundTable[s * R + (R - 1)], 10000, "a >=70% actual fill must return the full stake");
        }
    }

    function test_refundTable_isMonotonicPerRow() public view {
        _assertRefundRowMonotonic(cfg);
    }

    /// Ties to the FillAuction constructor: a freshly-deployed FillAuction's
    /// default refundTable must have non-decreasing rows ending at 10000.
    function test_FillAuctionDefaultRefundTable_isMonotonicPerRow() public view {
        _assertRefundRowMonotonic(liveCfg);
    }

    /// collateralRate must never be all-zero - that would make registration
    /// free regardless of fillAmount, the same failure mode the original
    /// stakeTable constructor fix addressed.
    function test_FillAuctionDefaultCollateralRate_isNonZero() public view {
        bool allZero = true;
        for (uint256 s = 0; s < liveCfg.collateralRate.length; s++) {
            if (liveCfg.collateralRate[s] != 0) { allZero = false; break; }
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
    function _assertRefundMonotonicAtBoundaries(DynamicStakeLib.StakeConfig storage t, uint256 stakeAmount, uint256 orderTotal) internal view {
        uint256[4] memory thresholdPct = [uint256(2), 10, 30, 70];
        uint256 R = t.ratioThresholds.length + 1;
        uint8 sBucket = DynamicStakeLib.getOrderSizeBucket(orderTotal);

        // Same snapshot register() would take: this size bucket's refund row
        // plus the ratio thresholds it was computed against.
        uint32[] memory row = new uint32[](R);
        for (uint256 r = 0; r < R; r++) row[r] = t.refundTable[sBucket * R + r];
        uint256[] memory ratioThresholds = t.ratioThresholds;

        for (uint256 i = 0; i < thresholdPct.length; i++) {
            uint256 fillHi = (thresholdPct[i] * orderTotal + 99) / 100; // ceil
            if (fillHi < 1) continue;
            uint256 fillLo = fillHi - 1;
            if (fillLo < 1) continue;

            uint256 refundLo = DynamicStakeLib.computeRefund(stakeAmount, fillLo, orderTotal, row, ratioThresholds);
            uint256 refundHi = DynamicStakeLib.computeRefund(stakeAmount, fillHi, orderTotal, row, ratioThresholds);
            assertLe(refundLo, refundHi, "refund must not decrease across a fill-ratio bucket boundary");
        }
    }

    function testFuzz_computeRefund_monotonicAtBucketBoundaries(
        uint256 stakeAmount,
        uint256 orderTotal
    ) public view {
        stakeAmount = bound(stakeAmount, 1, type(uint128).max);
        orderTotal  = bound(orderTotal, 100, 10_000_000e6);
        _assertRefundMonotonicAtBoundaries(cfg, stakeAmount, orderTotal);
    }

    function testFuzz_FillAuctionDefaultRefundTable_computeRefund_monotonicAtBucketBoundaries(
        uint256 stakeAmount,
        uint256 orderTotal
    ) public view {
        stakeAmount = bound(stakeAmount, 1, type(uint128).max);
        orderTotal  = bound(orderTotal, 100, 10_000_000e6);
        _assertRefundMonotonicAtBoundaries(liveCfg, stakeAmount, orderTotal);
    }

    /// Filling >=70% of the order always returns the full stake, regardless
    /// of stake size or order size.
    function testFuzz_computeRefund_fullFillReturnsFullStake(uint256 stakeAmount, uint256 orderTotal) public view {
        stakeAmount = bound(stakeAmount, 1, type(uint128).max);
        orderTotal  = bound(orderTotal, 1, 10_000_000e6);

        uint256 R = liveCfg.ratioThresholds.length + 1;
        uint8 sBucket = DynamicStakeLib.getOrderSizeBucket(orderTotal);
        uint32[] memory row = new uint32[](R);
        for (uint256 r = 0; r < R; r++) row[r] = liveCfg.refundTable[sBucket * R + r];

        assertEq(
            DynamicStakeLib.computeRefund(stakeAmount, orderTotal, orderTotal, row, liveCfg.ratioThresholds),
            stakeAmount
        );
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
        uint256 c1 = DynamicStakeLib.computeCollateral(fillAmount1, deadline, liveCfg);
        uint256 c2 = DynamicStakeLib.computeCollateral(fillAmount2, deadline, liveCfg);
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
        uint256 stakeSmall = DynamicStakeLib.computeCollateral(smallCeiling, deadline, liveCfg);
        uint256 stakeBig   = DynamicStakeLib.computeCollateral(bigCeiling, deadline, liveCfg);

        // The bigger ceiling costs proportionally more, never less.
        assertGe(stakeBig, stakeSmall);
        assertEq(stakeBig, stakeSmall * 71); // exactly proportional - same rate, no buckets
    }

    /// The "sniping fee" in action: filling only 1% of a >$1M order forfeits
    /// 99% of the collateral to the treasury; filling >=70% forfeits nothing.
    function test_computeRefund_smallActualFill_forfeitsMostStake() public view {
        uint256 orderTotal = 2_000_000e6;  // sBucket 3 (>$1M)
        uint256 stake      = 100e18;

        uint256 R = liveCfg.ratioThresholds.length + 1;
        uint8 sBucket = DynamicStakeLib.getOrderSizeBucket(orderTotal);
        uint32[] memory row = new uint32[](R);
        for (uint256 r = 0; r < R; r++) row[r] = liveCfg.refundTable[sBucket * R + r];

        uint256 refundSmall = DynamicStakeLib.computeRefund(stake, orderTotal * 1 / 100, orderTotal, row, liveCfg.ratioThresholds);
        uint256 refundFull  = DynamicStakeLib.computeRefund(stake, orderTotal * 70 / 100, orderTotal, row, liveCfg.ratioThresholds);

        assertEq(refundSmall, stake * 100 / 10000); // refundTable[3][0] == 100 bps == 1% kept
        assertEq(refundFull, stake);                // refundTable[3][4] == 10000 bps == 100% kept
    }
}
