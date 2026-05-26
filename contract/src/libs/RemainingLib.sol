// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library RemainingLib {
    // raw=0                    → lệnh mới, chưa fill lần nào
    // raw=~x                   → còn lại x token (x = ~raw)
    // raw=type(uint256).max    → đã fill hết

    function remaining(uint256 raw, uint256 orderAmount)
        internal pure returns (uint256)
    {
        if (raw == 0)                 return orderAmount;
        if (raw == type(uint256).max) return 0;
        return ~raw;
    }

    function pack(uint256 remaining_) internal pure returns (uint256) {
        return ~remaining_;
    }

    function fullyFilled() internal pure returns (uint256) {
        return type(uint256).max;
    }

    function isNewOrder(uint256 raw) internal pure returns (bool) {
        return raw == 0;
    }
}