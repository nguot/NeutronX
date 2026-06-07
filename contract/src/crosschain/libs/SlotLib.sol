// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * SlotLib — helpers for deciding how many fill slots an order gets.
 *
 * WHY SLOTS?
 * ----------
 * A cross-chain order is split into N "slots".  Each slot is an independent
 * mini-HTLC worth (inputAmount / N) of the input token.  Different fillers
 * can claim different slots in parallel, giving us partial-fill semantics
 * without deploying N separate contracts.
 *
 * The Merkle tree built by the KeyDistributor has N leaves (one per slot).
 * Storing only the root on-chain costs O(1); each claim costs O(log N) gas
 * for the proof check — far cheaper than O(N) individual hashlocks.
 *
 * SLOT COUNT RULES
 * ----------------
 * We want powers of 2 so the Merkle tree is perfectly balanced (every proof
 * is exactly log2(N) hashes long, which is easy to reason about).
 *
 * The thresholds below assume the input token is priced roughly like ETH/WETH.
 * For stablecoin-in / token-out orders the server can override numSlots when
 * it creates the Merkle tree — the contract just validates 2 ≤ N ≤ 32 and
 * that N is a power of two.
 */
library SlotLib {

    /**
     * Recommend N based on raw input amount (in wei / smallest unit).
     * Called OFF-CHAIN by the KeyDistributor server; result is submitted in
     * the OrderInfo struct and validated by CrossChainReactor.createOrder().
     *
     *   < 0.5 ETH  →  2  slots   (tiny order, 1 filler is usually enough)
     *   < 2 ETH    →  4  slots
     *   < 10 ETH   →  8  slots
     *   < 50 ETH   →  16 slots
     *   ≥ 50 ETH   →  32 slots   (largest supported tree depth = log2(32) = 5)
     */
    function getNumSlots(uint256 inputAmountWei) internal pure returns (uint8) {
        if (inputAmountWei <  0.5 ether) return 2;
        if (inputAmountWei <  2   ether) return 4;
        if (inputAmountWei <  10  ether) return 8;
        if (inputAmountWei <  50  ether) return 16;
        return 32;
    }

    /**
     * Returns true if n is a power of two and within [2, 64].
     * Used in createOrder() to reject invalid numSlots values.
     *
     * Bit trick: a power of two has exactly one set bit, so (n & (n-1)) == 0.
     */
    function isPowerOfTwo(uint8 n) internal pure returns (bool) {
        return n >= 2 && n <= 64 && (n & (n - 1)) == 0;
    }

    /**
     * How many Merkle proof hashes are needed for a tree of size n?
     * Always log2(n) for a balanced binary tree.
     * Useful for off-chain validation before submitting a proof.
     */
    function proofLength(uint8 n) internal pure returns (uint8 depth) {
        while ((uint8(1) << depth) < n) depth++;
    }
}
