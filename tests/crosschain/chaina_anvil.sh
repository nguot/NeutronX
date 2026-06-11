#!/usr/bin/env bash
# chaina_anvil.sh — start Chain A Anvil (source chain, WETH chain)
#
# Uses the same mainnet fork block as Chain B so WETH/Permit2 exist at their
# canonical addresses and token balances/prices line up across both chains.
#
# Port 8545 and chainId 31337 distinguish it from Chain B (port 8546, chainId 31338).
#
# Usage (WSL, separate terminal):
#   bash tests/crosschain/chaina_anvil.sh

ALCHEMY_URL="https://eth-mainnet.g.alchemy.com/v2/NqceSkD9a9GU5a-EbT9wp"
FORK_BLOCK="20500000"   # same block as Chain B so token balances match

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  NeutronX Cross-Chain — Chain A (Source / WETH)         ║"
echo "║  Port       : 8545                                       ║"
echo "║  Chain ID   : 31337                                      ║"
echo "║  Fork block : $FORK_BLOCK (~Sep 2024)                ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Chain A is the source chain where the swapper locks WETH."
echo "EscrowSrcFactory is deployed here. Run this instead of"
echo "tests/demo/v1_neutral_anvil.sh for crosschain testing — no"
echo "fixed --block-time, since the E2E script drives blocks via cast send."
echo ""
echo "Leave this terminal open while running setup_cc.sh and run_cc.sh."
echo ""

anvil \
  --fork-url  "$ALCHEMY_URL" \
  --fork-block-number "$FORK_BLOCK" \
  --chain-id  31337 \
  --port      8545
