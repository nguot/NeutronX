// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/libs/RemainingLib.sol";

contract RemainingLibTest is Test {
    using RemainingLib for uint256;

    function test_remaining_newOrder() public pure {
        assertEq(RemainingLib.remaining(0, 1000e18), 1000e18);
    }

    function test_remaining_fullyFilled() public pure {
        assertEq(RemainingLib.remaining(type(uint256).max, 1000e18), 0);
    }

    function test_remaining_partial() public pure {
        uint256 left = 400e18;
        uint256 packed = RemainingLib.pack(left);
        assertEq(RemainingLib.remaining(packed, 1000e18), left);
    }

    function test_fullyFilled() public pure {
        assertEq(RemainingLib.fullyFilled(), type(uint256).max);
    }

    function test_isNewOrder() public pure {
        assertTrue(RemainingLib.isNewOrder(0));
        assertFalse(RemainingLib.isNewOrder(1));
        assertFalse(RemainingLib.isNewOrder(type(uint256).max));
    }

    function test_pack_unpack_roundtrip(uint256 x) public pure {
        // x không được là 0 hoặc type(uint256).max vì đó là sentinel values
        vm.assume(x > 0 && x < type(uint256).max);
        assertEq(RemainingLib.remaining(RemainingLib.pack(x), 0), x);
    }
}