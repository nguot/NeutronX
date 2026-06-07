#!/usr/bin/env bash
# v1_neutral_anvil.sh
# Fork block 20,500,000  ≈  September 2024
# Chainlink ETH/USD at this block: ~$2,500
# Market ≈ startPrice (2490 USDC/WETH) → small positive spread → both fillers fill

export DEMO_VERSION="v1_neutral"
export FORK_BLOCK="20500000"
export EXPECTED_ETH_PRICE="2500"
export MOCK_MARKET_PRICE="2500"   # injected into solver strategy (overrides Binance call)

ALCHEMY_URL="https://eth-mainnet.g.alchemy.com/v2/NqceSkD9a9GU5a-EbT9wp"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  NeutronX Demo — Version 1: NEUTRAL MARKET              ║"
echo "║  Fork block : $FORK_BLOCK (~Sep 2024)                ║"
echo "║  ETH price  : ~\$$EXPECTED_ETH_PRICE                             ║"
echo "║  Spread     : +\$10/WETH (0.4%)  — both fillers profit  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Starting Anvil mainnet fork... (leave this terminal open)"
echo ""

anvil \
  --fork-url "$ALCHEMY_URL" \
  --fork-block-number "$FORK_BLOCK" \
  --chain-id 31337 \
  --block-time 5
