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
 * Bigger orders get proportionally more slots than smaller ones (not a flat
 * doubling), because a fixed slot count would let the per-slot size — and
 * therefore the minimum capital a filler needs to participate at all — grow
 * right alongside the order size. Splitting larger orders more finely keeps
 * that participation floor from climbing out of reach for smaller fillers.
 *
 * The thresholds below assume the input token is priced roughly like ETH/WETH.
 * For stablecoin-in / token-out orders the server can override numSlots when
 * it creates the Merkle tree — the contract just validates 2 ≤ N ≤ 64 and
 * that N is a power of two (claimedBitmap is a uint64 — one bit per slot).
 */
library SlotLib {

    /**
     * Recommend N based on raw input amount (in wei / smallest unit).
     * Called OFF-CHAIN by the KeyDistributor server; result is submitted in
     * the OrderInfo struct and validated by CrossChainReactor.createOrder().
     *
     *   < 0.5 ETH  →  4  slots   (tiny order, but still splittable for small fillers)
     *   < 2 ETH    →  8  slots
     *   < 10 ETH   →  16 slots
     *   < 50 ETH   →  32 slots
     *   ≥ 50 ETH   →  64 slots   (max supported — tree depth = log2(64) = 6)
     */
    function getNumSlots(uint256 inputAmountWei) internal pure returns (uint8) {
        if (inputAmountWei <  0.5 ether) return 4;
        if (inputAmountWei <  2   ether) return 8;
        if (inputAmountWei <  10  ether) return 16;
        if (inputAmountWei <  50  ether) return 32;
        return 64;
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
