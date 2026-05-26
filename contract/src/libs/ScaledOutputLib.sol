// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";

library ScaledOutputLib {
    function scaleOutput(
        uint256 totalOutput,
        uint256 fillAmount,
        uint256 totalInput,
        bool    isLastFill,
        uint256 alreadyPaid
    ) internal pure returns (uint256) {
        if (isLastFill) {
            // Trả phần còn lại — tránh mất dust do rounding
            return totalOutput - alreadyPaid;
        }
        return FullMath.mulDiv(totalOutput, fillAmount, totalInput);
    }
}