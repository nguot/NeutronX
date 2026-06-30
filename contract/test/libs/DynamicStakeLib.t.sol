// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/libs/DynamicStakeLib.sol";

contract DynamicStakeLibTest is Test {

    // ── getFillRatioBucket ──

    function test_fillRatio_edgeCase_fullFill() public pure {
        assertEq(DynamicStakeLib.getFillRatioBucket(1000, 1000), 4);
    }

    function test_fillRatio_overFill() public pure {
        // fill > total vẫn trả về 4
        assertEq(DynamicStakeLib.getFillRatioBucket(1001, 1000), 4);
    }

    function test_fillRatio_bucket0() public pure {
        // < 2% → bucket 0
        assertEq(DynamicStakeLib.getFillRatioBucket(1, 100), 0);
    }

    function test_fillRatio_bucket1() public pure {
        // 5% → bucket 1
        assertEq(DynamicStakeLib.getFillRatioBucket(5, 100), 1);
    }

    function test_fillRatio_bucket2() public pure {
        // 20% → bucket 2
        assertEq(DynamicStakeLib.getFillRatioBucket(20, 100), 2);
    }

    function test_fillRatio_bucket3() public pure {
        // 50% → bucket 3
        assertEq(DynamicStakeLib.getFillRatioBucket(50, 100), 3);
    }

    function test_fillRatio_bucket4() public pure {
        // 80% → bucket 4
        assertEq(DynamicStakeLib.getFillRatioBucket(80, 100), 4);
    }

    // ── getOrderSizeBucket ──

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
        assertEq(DynamicStakeLib.getTimeBucket(deadline), 0);
    }

    function test_timeBucket_close() public view {
        uint256 deadline = block.number + 30;
        assertEq(DynamicStakeLib.getTimeBucket(deadline), 1);
    }

    function test_timeBucket_veryClose() public view {
        uint256 deadline = block.number + 8;
        assertEq(DynamicStakeLib.getTimeBucket(deadline), 2);
    }

    function test_timeBucket_expired() public view {
        uint256 deadline = block.number; // đúng block hiện tại
        assertEq(DynamicStakeLib.getTimeBucket(deadline), 3);
    }

    // ── Boundary tests (added 2026-06-30 to kill mutation-testing survivors) ──
    // Mutation testing left boundary mutants alive (`<`→`<=`, `==`→`!=`, `<`→`>=`)
    // on the bucket-classification helpers: the suite probed representative values
    // but never the EXACT tier edges or the per-bucket constants. These pin every
    // edge so an off-by-one shift or constant change now fails a test.

    // _getTimeMultiplier — exact per-bucket constants. Kills `tBucket == n`→`!= n`.
    function test_timeMultiplier_exactValues() public pure {
        assertEq(DynamicStakeLib._getTimeMultiplier(0), 10000);
        assertEq(DynamicStakeLib._getTimeMultiplier(1), 15000);
        assertEq(DynamicStakeLib._getTimeMultiplier(2), 30000);
        assertEq(DynamicStakeLib._getTimeMultiplier(3), 50000);
    }

    // getFillRatioBucket — exact pct edges. Kills `pct < 2/10/30`→`<= 2/10/30`.
    function test_fillRatio_exactBoundaries() public pure {
        assertEq(DynamicStakeLib.getFillRatioBucket(2, 100), 1);  // pct==2 is NOT bucket 0
        assertEq(DynamicStakeLib.getFillRatioBucket(10, 100), 2); // pct==10 is NOT bucket 1
        assertEq(DynamicStakeLib.getFillRatioBucket(30, 100), 3); // pct==30 is NOT bucket 2
        assertEq(DynamicStakeLib.getFillRatioBucket(70, 100), 4); // pct==70 is NOT bucket 3
    }

    // getOrderSizeBucketETH — exact ETH-notional edges (this ETH variant was only
    // exercised indirectly before; the legacy USDC getOrderSizeBucket has its own
    // tests above). Kills `notionalEth < 1/10/100 ether`→`<=` and →`>=`.
    function test_orderSizeETH_exactBoundaries() public pure {
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(0),         0);
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(1 ether),   1); // ==1 ether → bucket 1
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(10 ether),  2); // ==10 ether → bucket 2
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(100 ether), 3); // ==100 ether → bucket 3
    }

    // getOrderSizeBucketETH — representative mid-tier values (direct ETH-path coverage).
    function test_orderSizeETH_midTiers() public pure {
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(0.5 ether), 0);
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(5 ether),   1);
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(50 ether),  2);
        assertEq(DynamicStakeLib.getOrderSizeBucketETH(500 ether), 3);
    }
}