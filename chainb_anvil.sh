#!/usr/bin/env bash
# chainb_anvil.sh — start Chain B Anvil (destination chain, USDC chain)
#
# Uses the same mainnet fork so USDC and Permit2 exist at their canonical addresses.
# Port 8546 and chainId 31338 distinguish it from Chain A (port 8545, chainId 31337).
#
# Same config shape as chaina_anvil.sh — no fixed --block-time. Both EscrowSrc/Dst
# factories are deployed on every chain (chains.json), so each chain's anvil only
# needs to mine when a tx is sent to it; confirmations:0 in chains.json relies on
# this (the deploy tx's own block already satisfies "current >= deployBlock + 0").
# This is the template for adding a new chain: copy this file with a new
# port/chainId, no --block-time, and add a confirmations:0 entry to chains.json.
#
# Usage (WSL, separate terminal):
#   bash chainb_anvil.sh

ALCHEMY_URL="https://eth-mainnet.g.alchemy.com/v2/NqceSkD9a9GU5a-EbT9wp"
FORK_BLOCK="25450000"   # same block as Chain A so token balances match.
# NOTE: see the matching comment in chaina_anvil.sh — bump both together, and
# re-verify whale balances at the new block before doing so.

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  NeutronX Cross-Chain — Chain B (Destination / USDC)    ║"
echo "║  Port       : 8546                                       ║"
echo "║  Chain ID   : 31338                                      ║"
echo "║  Fork block : $FORK_BLOCK (~Jul 2026)                ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Chain B is the destination chain where fillers deposit USDC."
echo "EscrowDstFactory is deployed here.  The backend chainBWatcher monitors this port."
echo ""
echo "Leave this terminal open while running setup_cc.sh and run_cc.sh."
echo ""

anvil \
  --fork-url  "$ALCHEMY_URL" \
  --fork-block-number "$FORK_BLOCK" \
  --chain-id  31338 \
  --port      8546
