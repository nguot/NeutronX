#!/usr/bin/env bash
# chaina_anvil.sh — start Chain A Anvil (source chain, WETH chain)
#
# Uses the same mainnet fork block as Chain B so WETH/Permit2 exist at their
# canonical addresses and token balances/prices line up across both chains.
#
# Port 8545 and chainId 31337 distinguish it from Chain B (port 8546, chainId 31338).
#
# Usage (WSL, separate terminal):
#   bash chaina_anvil.sh

ALCHEMY_URL="https://eth-mainnet.g.alchemy.com/v2/NqceSkD9a9GU5a-EbT9wp"
FORK_BLOCK="25450000"   # same block as Chain B so token balances match.
# NOTE: bump this every so often — a block pinned too far in the past starts
# failing `eth_feeHistory` ("pruned history unavailable") on Alchemy's free
# tier, AND the hardcoded whale addresses (funding/, filler/*/src/funding/,
# scripts/crosschain/setup_cc.sh, scripts/race/common.sh) can drain over time
# (verified: the old 20500000 pin's USDC whales had gone from ~543M/45K USDC
# down to ~$0/~45K by 2026-07 — re-check whale balances at the new block
# with `cast call <token> "balanceOf(address)(uint256)" <whale> --block <N>`
# before bumping again).

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  NeutronX Cross-Chain — Chain A (Source / WETH)         ║"
echo "║  Port       : 8545                                       ║"
echo "║  Chain ID   : 31337                                      ║"
echo "║  Fork block : $FORK_BLOCK (~Jul 2026)                ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Chain A is the source chain where the swapper locks WETH."
echo "EscrowSrcFactory is deployed here. Run this instead of the single-chain anvil"
echo "for crosschain testing — no"
echo "fixed --block-time, since the E2E script drives blocks via cast send."
echo ""
echo "Leave this terminal open while running setup_cc.sh and run_cc.sh."
echo ""

anvil \
  --fork-url  "$ALCHEMY_URL" \
  --fork-block-number "$FORK_BLOCK" \
  --chain-id  31337 \
  --port      8545
