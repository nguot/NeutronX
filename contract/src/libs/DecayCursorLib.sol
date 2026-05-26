// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library DecayCursorLib {
    struct DecayCursor {
        uint128 currentStartPrice;  // giá tại thời điểm reset gần nhất
        uint64  lastResetBlock;
        uint32  decayPerBlock;      // wei giảm mỗi block
        uint32  reserved;
    }   // = 32 bytes = 1 storage slot

    function init(
        DecayCursor storage cursor,
        uint128 startPrice,
        uint32  decayPerBlock_,
        uint64  blockNum
    ) internal {
        cursor.currentStartPrice = startPrice;
        cursor.lastResetBlock    = blockNum;
        cursor.decayPerBlock     = decayPerBlock_;
    }

    function getCurrentPrice(DecayCursor storage cursor)
        internal view returns (uint128)
    {
        uint256 blocksPassed = block.number - uint256(cursor.lastResetBlock);
        uint256 decayed      = blocksPassed * uint256(cursor.decayPerBlock);
        if (decayed >= uint256(cursor.currentStartPrice)) return 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        return cursor.currentStartPrice - uint128(decayed);
    }

    function reset(
        DecayCursor storage cursor,
        uint128 newStartPrice,
        uint64  blockNum
    ) internal {
        cursor.currentStartPrice = newStartPrice;
        cursor.lastResetBlock    = blockNum;
        // decayPerBlock giữ nguyên
    }
}