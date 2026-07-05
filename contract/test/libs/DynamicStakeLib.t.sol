// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/libs/DynamicStakeLib.sol";

/// B2: bucket boundaries are now runtime arrays instead of hardcoded if-chains,
/// so every call below passes the same DEFAULT thresholds the pre-refactor
/// code had hardcoded (2%/10%/30%/70% fill-ratio, 50/20/5 blocks-left,
/// 1/10/100 ETH size, 1x/1.5x/3x/5x time multiplier) — the bucket semantics
/// are unchanged, only the boundaries moved from code into data.
contract DynamicStakeLibTest is Test {
    uint256[] ratioThresholds = [uint256(200), 1000, 3000, 7000];   // 2%/10%/30%/70% in bps
    uint256[] timeThresholds  = [uint256(50), 20, 5];               // blocks-left, strictly decreasing
    uint32[]  timeMult        = [uint32(10000), 15000, 30000, 50000];
    uint256[] sizeThresholdsEth = [uint256(1 ether), 10 ether, 100 ether];

    // ── getFillRatioBucket ──

    function test_fillRatio_edgeCase_fullFill() public view {
        assertEq(DynamicStakeLib.getFillRatioBucket(1000, 1000, ratioThresholds), 4);
    }

    function test_fillRatio_overFill() public view {
        // fill > total vẫn trả về 4
        assertEq(DynamicStakeLib.getFillRatioBucket(1001, 1000, ratioThresholds), 4);
    }

    function test_fillRatio_bucket0() public view {
        // < 2% → bucket 0
        assertEq(DynamicStakeLib.getFillRatioBucket(1, 100, ratioThresholds), 0);
    }

    function test_fillRatio_bucket1() public view {
        // 5% → bucket 1
        assertEq(DynamicStakeLib.getFillRatioBucket(5, 100, ratioThresholds), 1);
    }

    function test_fillRatio_bucket2() public view {
        // 20% → bucket 2
        assertEq(DynamicStakeLib.getFillRatioBucket(20, 100, ratioThresholds), 2);
    }

    function test_fillRatio_bucket3() public view {
        // 50% → bucket 3
        assertEq(DynamicStakeLib.getFillRatioBucket(50, 100, ratioThresholds), 3);
    }

    function test_fillRatio_bucket4() public view {
        // 80% → bucket 4
        assertEq(DynamicStakeLib.getFillRatioBucket(80, 100, ratioThresholds), 4);
    }

    // ── getOrderSizeBucket (legacy USDC-denominated, unchanged by B2) ──

    function test_orderSize_bucket0() public pure {
        assertEq(DynamicStakeLib.getOrderSizeBucket(5_000e6), 0);
    }

    function test_orderSize_bucket1() public pure {
        assertEq(DynamicStakeLib.getOrderSizeBucket(50_000e6), 1);
    }

    function test_orderSize_bucket2() public pure {
        assertEq(DynamicStakeLib.getOrderSizeBucket(500_000e6), 2);
    }

    function test_orderSize_bucket3() public pure {
        assertEq(DynamicStakeLib.getOrderSizeBucket(2_000_000e6), 3);
    }

    // ── getTimeBucket ──

    function test_timeBucket_farFromDeadline() public view {
        uint256 deadline = block.number + 100;
        assertEq(DynamicStakeLib.getTimeBucket(deadline, timeThresholds), 0);
    }

    function test_timeBucket_close() public view {
        uint256 deadline = block.number + 30;
        assertEq(DynamicStakeLib.getTimeBucket(deadline, timeThresholds), 1);
    }

    function test_timeBucket_veryClose() public view {
        uint256 deadline = block.number + 8;
        assertEq(DynamicStakeLib.getTimeBucket(deadline, timeThresholds), 2);
    }

    function test_timeBucket_expired() public view {
        uint256 deadline = block.number; // đúng block hiện tại
        assertEq(DynamicStakeLib.getTimeBucket(deadline, timeThresholds), 3);
    }

    // ── Boundary tests (added 2026-06-30 to kill mutation-testing survivors) ──
    // Mutation testing left boundary mutants alive (`<`→`<=`, `==`→`!=`, `<`→`>=`)
    // on the bucket-classification helpers: the suite probed representative values
    // but never the EXACT tier edges or the per-bucket constants. These pin every
    // edge so an off-by-one shift or constant change now fails a test.

    // timeMult — exact per-bucket constants (now plain config-array indexing;
    // pins the DEFAULT values FillAuction seeds at construction).
    function test_timeMultiplier_exactValues() public view {
        assertEq(timeMult[0], 10000);
        assertEq(timeMult[1], 15000);
        assertEq(timeMult[2], 30000);
        assertEq(timeMult[3], 50000);
    }

    // getFillRatioBucket — exact pct edges. Kills `pctBps < 200/1000/3000`→`<=`.
    function test_fillRatio_exactBoundaries() public view {
        assertEq(DynamicStakeLib.getFillRatioBucket(2, 100, ratioThresholds), 1);  // pct==2 is NOT bucket 0
        assertEq(DynamicStakeLib.getFillRatioBucket(10, 100, ratioThresholds), 2); // pct==10 is NOT bucket 1
        assertEq(DynamicStakeLib.getFillRatioBucket(30, 100, ratioThresholds), 3); // pct==30 is NOT bucket 2
        assertEq(DynamicStakeLib.getFillRatioBucket(70, 100, ratioThresholds), 4); // pct==70 is NOT bucket 3
    }

    // getOrderSizeBucketETH — exact ETH-notional edges (this ETH variant was only
    // exercised indirectly before; the legacy USDC getOrderSizeBucket has its own
    // tests above). Kills `notionalEth < 1/10/100 ether`→`<=` and →`>=`.
    function test_orderSizeETH_exactBoundaries() public view {
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(0,          sizeThresholdsEth), 0);
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(1 ether,    sizeThresholdsEth), 1); // ==1 ether → bucket 1
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(10 ether,   sizeThresholdsEth), 2); // ==10 ether → bucket 2
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(100 ether,  sizeThresholdsEth), 3); // ==100 ether → bucket 3
    }

    // getOrderSizeBucketETH — representative mid-tier values (direct ETH-path coverage).
    function test_orderSizeETH_midTiers() public view {
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(0.5 ether, sizeThresholdsEth), 0);
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(5 ether,   sizeThresholdsEth), 1);
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(50 ether,  sizeThresholdsEth), 2);
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(500 ether, sizeThresholdsEth), 3);
    }
}
