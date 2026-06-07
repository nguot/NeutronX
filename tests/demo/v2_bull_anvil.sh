#!/usr/bin/env bash
# v2_bull_anvil.sh
# Fork block 19,500,000  ≈  March 2024
# Chainlink ETH/USD at this block: ~$3,500
# Market >> startPrice (2490 USDC/WETH) → huge spread → fillers rush to fill all at once

export DEMO_VERSION="v2_bull"
export FORK_BLOCK="19500000"
export EXPECTED_ETH_PRICE="3500"
export MOCK_MARKET_PRICE="3500"   # injected into solver strategy

ALCHEMY_URL="https://eth-mainnet.g.alchemy.com/v2/NqceSkD9a9GU5a-EbT9wp"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  NeutronX Demo — Version 2: BULL MARKET                 ║"
echo "║  Fork block : $FORK_BLOCK (~Mar 2024)                ║"
echo "║  ETH price  : ~\$$EXPECTED_ETH_PRICE                             ║"
echo "║  Spread     : +\$1010/WETH (40%)  — fillers rush fill   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Starting Anvil mainnet fork... (leave this terminal open)"
echo ""

anvil \
  --fork-url "$ALCHEMY_URL" \
  --fork-block-number "$FORK_BLOCK" \
  --chain-id 31337 \
  --block-time 0
