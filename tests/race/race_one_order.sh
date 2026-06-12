#!/usr/bin/env bash
# RACE — one big order, two fillers.
#
# Order: 20 WETH → USDC. Each filler is funded with 60,000 USDC and risks at most
# 50% of its inventory per fill (MAX_INVENTORY_USE_BPS), so each can fill at most
# ~12 WETH (60%) in one chunk — NEITHER can fill 100% on the first try. The order
# is therefore filled cooperatively across BOTH fillers in partial chunks.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

INPUT=20000000000000000000      # 20 WETH
MINOUT=45000000000              # 45,000 USDC floor (90% of ~50,000)
PRICE=2500000000                # 2500 USDC / WETH
DECAY=0
MFB=100                         # 1% min fill
FUND_USDC=60000000000           # 60,000 USDC per filler → ~12 WETH (60%) single-fill cap

# ── bring up chain + contracts + funding (before backend/bots read .env) ──
start_anvil
deploy
wire_env
fund_swapper "$INPUT"
fund_filler "$A_COW"   "$PK_COW"   "$FUND_USDC"
fund_filler "$A_WHALE" "$PK_WHALE" "$FUND_USDC"

# ── bring up the off-chain stack ──
start_postgres
start_backend
start_fillers

# ── submit the order and let the bots race ──
echo "[race] submitting 20 WETH order…"
HASH=$(submit_order "$INPUT" "$MINOUT" "$PRICE" "$DECAY" "$MFB" 1 70)
echo "[race] orderHash=$HASH"

echo "[race] waiting for cooperative fill…"
wait_filled "$HASH" "$INPUT" 150 || { echo "[race] FAIL: order not fully filled in time"; exit 1; }

# ── assertions (on-chain is authoritative; the backend indexer is async) ──
echo "[race] ════ assertions ════"
REM=$(onchain_remaining "$HASH" "$INPUT" | awk '{print $1}')
SWUSDC=$(usdc_bal "$A0" | awk '{print $1}')
COW_PAID=$(( FUND_USDC - $(usdc_bal "$A_COW"   | awk '{print $1}') ))
WHALE_PAID=$(( FUND_USDC - $(usdc_bal "$A_WHALE" | awk '{print $1}') ))

sleep 8  # let the backend indexer catch up, for the informational line
NFILLS=$(fills_count "$HASH"); STATUS=$(order_status "$HASH")

echo "  on-chain remaining = $REM"
echo "  swapper USDC       = $SWUSDC   (floor = $MINOUT)"
echo "  CoWFiller   paid   = $COW_PAID USDC"
echo "  WhaleFiller paid   = $WHALE_PAID USDC"
echo "  backend: status=$STATUS fills=$NFILLS (informational; indexer is async)"

fail=0
[ "$REM" = 0 ]                              || { echo "  ✗ order not fully filled on-chain"; fail=1; }
awk "BEGIN{exit !($SWUSDC >= $MINOUT)}"     || { echo "  ✗ swapper received below floor"; fail=1; }
[ "$COW_PAID"   -gt 0 ]                     || { echo "  ✗ CoWFiller contributed nothing"; fail=1; }
[ "$WHALE_PAID" -gt 0 ]                     || { echo "  ✗ WhaleFiller contributed nothing"; fail=1; }
# neither filler covered the whole order alone (each paid < total output)
awk "BEGIN{exit !($COW_PAID < $SWUSDC && $WHALE_PAID < $SWUSDC)}" \
                                            || { echo "  ✗ a single filler covered 100%"; fail=1; }
[ "$fail" = 0 ] && echo "[race] ✅ PASS — both fillers filled partial chunks, neither did 100%, swapper ≥ floor" \
                || { echo "[race] ❌ FAIL"; exit 1; }
