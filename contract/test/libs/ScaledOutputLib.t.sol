// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/libs/ScaledOutputLib.sol";

// test 1 chiều, cho biết filler cần nạp bao nhiêu output để nhận được input (tạm thời test chưa cover input, input do reactor chuyển cho filler ở PartialFill)
contract ScaledOutputLibTest is Test {

    // ── non-last fill ──

    function test_nonLastFill_proportional() public pure {
        // fill 40% input → nhận 40% output
        uint256 out = ScaledOutputLib.scaleOutput(1000e18, 400e18, 1000e18, false, 0);
        assertEq(out, 400e18);
    }

    function test_nonLastFill_partial() public pure {
        uint256 out = ScaledOutputLib.scaleOutput(1000e18, 100e18, 1000e18, false, 0);
        assertEq(out, 100e18);
    }

    // ── last fill ──

    function test_lastFill_returnsRemainder() public pure {
        // đã trả 400e18, last fill trả phần còn lại
        uint256 out = ScaledOutputLib.scaleOutput(1000e18, 600e18, 1000e18, true, 400e18);
        assertEq(out, 600e18);
    }

    function test_lastFill_noRounding_dust() public pure {
        // tổng 3 fills phải == totalOutput, không mất dust
        uint256 total      = 1000e18;
        uint256 totalInput = 1000e18;

        uint256 fill1 = ScaledOutputLib.scaleOutput(total, 333e18, totalInput, false, 0);
        uint256 fill2 = ScaledOutputLib.scaleOutput(total, 333e18, totalInput, false, fill1);
        uint256 fill3 = ScaledOutputLib.scaleOutput(total, 334e18, totalInput, true,  fill1 + fill2);

        assertEq(fill1 + fill2 + fill3, total);
    }

    function test_lastFill_alreadyPaidZero() public pure {
        // chưa trả gì, last fill trả hết
        uint256 out = ScaledOutputLib.scaleOutput(1000e18, 1000e18, 1000e18, true, 0);
        assertEq(out, 1000e18);
    }
}