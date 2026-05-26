// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/libs/DecayCursorLib.sol";

contract DecayCursorLibTest is Test {

    DecayCursorLib.DecayCursor private cursor;

    function test_init_getCurrentPrice_sameBlock() public {
        DecayCursorLib.init(cursor, 1000e18, 10, uint64(block.number));
        assertEq(uint256(DecayCursorLib.getCurrentPrice(cursor)), 1000e18);
    }

    function test_getCurrentPrice_afterNBlocks() public {
        uint128 startPrice  = 1000e18;
        uint32  decayPerBlock = 10;
        DecayCursorLib.init(cursor, startPrice, decayPerBlock, uint64(block.number));

        uint256 blocks = 20;
        vm.roll(block.number + blocks);

        uint128 expected = startPrice - uint128(blocks * decayPerBlock);
        assertEq(uint256(DecayCursorLib.getCurrentPrice(cursor)), expected);
    }

    function test_getCurrentPrice_fullyDecayed() public {
        // decay hết → trả về 0, không underflow
        DecayCursorLib.init(cursor, 100, 10, uint64(block.number));
        vm.roll(block.number + 20); // 20 * 10 = 200 > 100
        assertEq(uint256(DecayCursorLib.getCurrentPrice(cursor)), 0);
    }

    function test_reset_resetsPrice() public {
        DecayCursorLib.init(cursor, 1000e18, 10, uint64(block.number));
        vm.roll(block.number + 50);

        uint128 newPrice = 800e18;
        DecayCursorLib.reset(cursor, newPrice, uint64(block.number));
        assertEq(uint256(DecayCursorLib.getCurrentPrice(cursor)), newPrice);
    }

    function test_reset_keepsDecayPerBlock() public {
        uint32 decay = 10;
        DecayCursorLib.init(cursor, 1000e18, decay, uint64(block.number));
        DecayCursorLib.reset(cursor, 500e18, uint64(block.number));

        vm.roll(block.number + 10);
        assertEq(uint256(DecayCursorLib.getCurrentPrice(cursor)), 500e18 - 10 * decay);
    }
}