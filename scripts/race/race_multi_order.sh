#!/usr/bin/env bash
# RACE — multiple big orders, two fillers.
#
# 3 orders of 16 WETH each. Each filler is funded with 90,000 USDC and risks ≤50%
# of inventory per fill, so its first-fill cap (~18 WETH worth of USDC, but bounded
# by inventory as it depletes) is never enough to solo a 16 WETH order outright on
# a shared, depleting balance. The fillers spread across the orders in partial
# chunks; as inventory depletes, later orders may stay partially filled (which is
# itself a realistic outcome → the fallback path would finish them).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Cap auto-seeded USDC below our funding so fillers stay at ~12 WETH single-fill
# capacity (< the 16 WETH order) and the batch is shared cooperatively.
export SEED_USDC_TARGET=1

INPUT=16000000000000000000      # 16 WETH per order
MINOUT=36000000000              # 36,000 USDC floor (90% of ~40,000)
PRICE=2500000000
DECAY=0
MFB=100
NUM_ORDERS=3
FUND_USDC=60000000000           # 60,000 USDC per filler → ~12 WETH single-fill cap (< 16 WETH order)
SWAPPER_WETH=48000000000000000000  # 48 WETH (3 × 16) for the single swapper

start_anvil
deploy
wire_env
fund_swapper "$SWAPPER_WETH"
fund_filler "$A_COW"   "$PK_COW"   "$FUND_USDC"
fund_filler "$A_WHALE" "$PK_WHALE" "$FUND_USDC"

start_postgres
start_backend
start_fillers

# snapshot filler USDC before the batch (robust to seeded/funded starting balance)
COW_BEFORE=$(usdc_bal "$A_COW"   | awk '{print $1}')
WHALE_BEFORE=$(usdc_bal "$A_WHALE" | awk '{print $1}')

# ── submit N orders (distinct nonces) ──
HASHES=()
for n in $(seq 1 "$NUM_ORDERS"); do
  h=$(submit_order "$INPUT" "$MINOUT" "$PRICE" "$DECAY" "$MFB" "$n" 80)
  echo "[race] order #$n  hash=$h"
  HASHES+=("$h")
done

# ── let the bots work the whole batch ──
echo "[race] letting fillers work the batch (100s)…"
sleep 100

# ── assertions (on-chain authoritative; backend indexer is async) ──
# Each filler's single-fill cap (~12 WETH) is below the 16 WETH order size, so
# ANY fully-filled order necessarily required BOTH fillers — that structural fact
# plus "both fillers spent USDC" is what we assert.
echo "[race] ════ assertions ════"
COW_PAID=$(( COW_BEFORE   - $(usdc_bal "$A_COW"   | awk '{print $1}') ))
WHALE_PAID=$(( WHALE_BEFORE - $(usdc_bal "$A_WHALE" | awk '{print $1}') ))
SWUSDC=$(usdc_bal "$A0" | awk '{print $1}')

filled=0; touched=0
for h in "${HASHES[@]}"; do
  rem=$(onchain_remaining "$h" "$INPUT" | awk '{print $1}')
  echo "  order $h  remaining=$rem"
  [ "$rem" = 0 ] && filled=$((filled+1))
  awk "BEGIN{exit !($rem < $INPUT)}" && touched=$((touched+1))
done
echo "  fully filled = $filled / $NUM_ORDERS   touched = $touched"
echo "  CoWFiller paid=$COW_PAID  WhaleFiller paid=$WHALE_PAID  swapper USDC=$SWUSDC"

fail=0
[ "$COW_PAID"   -gt 0 ] || { echo "  ✗ CoWFiller contributed nothing"; fail=1; }
[ "$WHALE_PAID" -gt 0 ] || { echo "  ✗ WhaleFiller contributed nothing"; fail=1; }
[ "$filled"  -ge 1 ]    || { echo "  ✗ no order fully filled (cap 12 < 16 WETH ⇒ needs cooperation)"; fail=1; }
[ "$touched" -ge 2 ]    || { echo "  ✗ fewer than 2 orders received any fills"; fail=1; }
[ "$fail" = 0 ] && echo "[race] ✅ PASS — multiple big orders worked by BOTH fillers in partial chunks; any full fill required cooperation (cap < order size)" \
                || { echo "[race] ❌ FAIL"; exit 1; }
