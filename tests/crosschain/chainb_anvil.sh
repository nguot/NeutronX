#!/usr/bin/env bash
# chainb_anvil.sh — start Chain B Anvil (destination chain, USDC chain)
#
# Uses the same mainnet fork so USDC and Permit2 exist at their canonical addresses.
# Port 8546 and chainId 31338 distinguish it from Chain A (port 8545, chainId 31337).
#
# Usage (WSL, separate terminal):
#   bash tests/crosschain/chainb_anvil.sh

ALCHEMY_URL="https://eth-mainnet.g.alchemy.com/v2/NqceSkD9a9GU5a-EbT9wp"
FORK_BLOCK="20500000"   # same block as Chain A so token balances match

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  NeutronX Cross-Chain — Chain B (Destination / USDC)    ║"
echo "║  Port       : 8546                                       ║"
echo "║  Chain ID   : 31338                                      ║"
echo "║  Fork block : $FORK_BLOCK (~Sep 2024)                ║"
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
  --port      8546 \
  --block-time 1
