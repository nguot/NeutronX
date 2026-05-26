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
}