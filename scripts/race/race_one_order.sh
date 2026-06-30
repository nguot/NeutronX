#!/usr/bin/env bash
# RACE — one big order, two fillers.
#
# Order: 20 WETH → USDC. Each filler is funded with 60,000 USDC and risks at most
# 50% of its inventory per fill (MAX_INVENTORY_USE_BPS), so each can fill at most
# ~12 WETH (60%) in one chunk — NEITHER can fill 100% on the first try. The order
# is therefore filled cooperatively across BOTH fillers in partial chunks.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Cap the fillers' auto-seeded USDC below our funding so the seeder doesn't top
# them up to 20M (which would let one filler solo the order). With this, each
# filler is limited to the 60k we fund → ~12 WETH single-fill cap < 20 WETH order.
export SEED_USDC_TARGET=1

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

# ── snapshot filler USDC BEFORE the order (robust to whatever they were seeded/funded with) ──
COW_BEFORE=$(usdc_bal "$A_COW"   | awk '{print $1}')
WHALE_BEFORE=$(usdc_bal "$A_WHALE" | awk '{print $1}')
echo "[race] filler USDC before — CoW=$COW_BEFORE  Whale=$WHALE_BEFORE"

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
COW_PAID=$(( COW_BEFORE   - $(usdc_bal "$A_COW"   | awk '{print $1}') ))
WHALE_PAID=$(( WHALE_BEFORE - $(usdc_bal "$A_WHALE" | awk '{print $1}') ))

# wait for the backend INDEXER to reflect the on-chain fills in the DB
echo "[race] waiting for indexer to update the DB…"
STATUS=pending
for i in $(seq 1 20); do STATUS=$(order_status "$HASH"); [ "$STATUS" = filled ] && break; sleep 1.5; done
NFILLS=$(fills_count "$HASH")

echo "  on-chain remaining = $REM"
echo "  swapper USDC       = $SWUSDC   (floor = $MINOUT)"
echo "  CoWFiller   paid   = $COW_PAID USDC"
echo "  WhaleFiller paid   = $WHALE_PAID USDC"
echo "  backend DB: status=$STATUS  fills=$NFILLS"

fail=0
[ "$REM" = 0 ]                              || { echo "  ✗ order not fully filled on-chain"; fail=1; }
awk "BEGIN{exit !($SWUSDC >= $MINOUT)}"     || { echo "  ✗ swapper received below floor"; fail=1; }
[ "$COW_PAID"   -gt 0 ]                     || { echo "  ✗ CoWFiller contributed nothing"; fail=1; }
[ "$WHALE_PAID" -gt 0 ]                     || { echo "  ✗ WhaleFiller contributed nothing"; fail=1; }
# neither filler covered the whole order alone (each paid < total output)
awk "BEGIN{exit !($COW_PAID < $SWUSDC && $WHALE_PAID < $SWUSDC)}" \
                                            || { echo "  ✗ a single filler covered 100%"; fail=1; }
# the DB (indexer) must reflect reality, not just the chain
[ "$STATUS" = filled ]                      || { echo "  ✗ backend DB still not 'filled' — indexer didn't pick up the fills"; fail=1; }
[ "$NFILLS" -ge 2 ]                         || { echo "  ✗ backend DB recorded < 2 fills — indexer gap"; fail=1; }
[ "$fail" = 0 ] && echo "[race] ✅ PASS — filled cooperatively, neither did 100%, swapper ≥ floor, and the DB reflects it" \
                || { echo "[race] ❌ FAIL"; exit 1; }
