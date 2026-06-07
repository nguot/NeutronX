#!/usr/bin/env bash
# v3_bear_anvil.sh
# Fork block 17,000,000  ≈  April 2023
# Chainlink ETH/USD at this block: ~$1,900
# Market << startPrice (2490 USDC/WETH) → fillers lose money → no voluntary fills → fallback only

export DEMO_VERSION="v3_bear"
export FORK_BLOCK="17000000"
export EXPECTED_ETH_PRICE="1900"
export MOCK_MARKET_PRICE="1900"   # injected into solver strategy

ALCHEMY_URL="https://eth-mainnet.g.alchemy.com/v2/NqceSkD9a9GU5a-EbT9wp"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  NeutronX Demo — Version 3: BEAR MARKET                 ║"
echo "║  Fork block : $FORK_BLOCK (~Apr 2023)                ║"
echo "║  ETH price  : ~\$$EXPECTED_ETH_PRICE                             ║"
echo "║  Spread     : -\$590/WETH  — NO filler fills             ║"
echo "║  Result     : fallback sweeps all 4 WETH via Uniswap    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "NOTE: In this scenario the swapper receives ~$7600 USDC"
echo "      (below the 9500 minOutputAmount). This is intentional:"
echo "      it demonstrates the protocol limitation when market"
echo "      price is below the order's floor price."
echo ""
echo "Starting Anvil mainnet fork... (leave this terminal open)"
echo ""

anvil \
  --fork-url "$ALCHEMY_URL" \
  --fork-block-number "$FORK_BLOCK" \
  --chain-id 31337 \
  --block-time 0
