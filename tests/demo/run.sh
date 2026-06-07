#!/usr/bin/env bash
# run.sh — mines blocks to drive the scenario through all 3 phases:
#   Phase 1 — Enter register window   (blocksLeft = 60)
#   Phase 2 — Execute fill            (blocksLeft = 59, one block after register)
#   Phase 3 — Enter fallback window   (blocksLeft = 9)
#
# Pauses between phases so you can read filler terminal output.
# Press ENTER to advance each phase, or pass --auto to skip pauses.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
load_log

AUTO=false
[[ "$1" == "--auto" ]] && AUTO=true

pause() {
  if [ "$AUTO" = false ]; then
    echo ""
    printf "${YELLOW}  Press ENTER to continue to next phase...${NC}"
    read -r
  else
    sleep 2
  fi
}

log STEP "run.sh — driving scenario phases"
check_anvil

# Load state saved by submit_order.sh
ORDER_HASH=$(cat "$LOG_DIR/.order_hash" 2>/dev/null || echo "")
DEADLINE=$(cat    "$LOG_DIR/.deadline"  2>/dev/null || echo "")

if [ -z "$ORDER_HASH" ] || [ -z "$DEADLINE" ]; then
  log ERROR "No order hash or deadline found. Did you run submit_order.sh first?"
  exit 1
fi

log INFO "Order hash: $ORDER_HASH"
log INFO "Deadline:   block $DEADLINE"

CURRENT=$(get_block)
BLOCKS_LEFT=$((DEADLINE - CURRENT))
log INFO "Current block: $CURRENT  |  blocks left until deadline: $BLOCKS_LEFT"

# ── Phase 1 — Mine into register window ──────────────────────────────────────
log STEP "Phase 1 — Mine into REGISTER window (blocksLeft = 60)"
log INFO "Fillers register when blocksLeft ≤ 60."

MINE_TO_REGISTER=$((BLOCKS_LEFT - 60))
if [ "$MINE_TO_REGISTER" -lt 1 ]; then
  log WARN "Already within 60 blocks of deadline. Skipping Phase 1 mine."
else
  log INFO "Mining $MINE_TO_REGISTER block(s) to reach register window..."
  mine "$MINE_TO_REGISTER"
fi

log RAW ""
log RAW "  ▶ Filler terminals should now show:"
log RAW "    [Strategy] ✔ FILL  fill=X WETH  spread=YYbps ..."
log RAW "    [Executor]  ✔ registered  tx=0x..."
log RAW ""

pause

# ── Phase 2 — Mine 1 block to trigger execute ────────────────────────────────
log STEP "Phase 2 — Mine 1 block to trigger EXECUTE phase"
mine 1

CURRENT=$(get_block)
log INFO "Current block: $CURRENT  |  blocks left: $((DEADLINE - CURRENT))"
log RAW ""
log RAW "  ▶ Filler terminals should now show:"
log RAW "    [Executor]  ✔ FILLED  tx=0x..."
log RAW "  ▶ Backend log should show:"
log RAW "    Fill detected: $ORDER_HASH"
log RAW "    order updated to active"
log RAW ""

pause

# ── Phase 2b — Check partial fill state ───────────────────────────────────────
log STEP "Phase 2b — Checking on-chain remaining after fills"
if [ -f "$LOG_DIR/.addresses" ]; then source "$LOG_DIR/.addresses"; fi

REMAINING=$(cast call "$REACTOR" \
  "remainingInput(bytes32,uint256)(uint256)" \
  "$ORDER_HASH" "4000000000000000000" \
  --rpc-url "$RPC" 2>/dev/null || echo "unknown")
log INFO "On-chain remaining input: $REMAINING wei"

FILLS=$(curl -sf "http://localhost:3000/fills?order=$ORDER_HASH" 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  fills={d.get(\"total\",0)}')" 2>/dev/null || echo "  (backend not responding)")
log INFO "Backend fills count: $FILLS"

pause

# ── Phase 3 — Mine into fallback window ───────────────────────────────────────
log STEP "Phase 3 — Mine into FALLBACK window (blocksLeft ≤ 10)"
CURRENT=$(get_block)
BLOCKS_LEFT=$((DEADLINE - CURRENT))

MINE_TO_FALLBACK=$((BLOCKS_LEFT - 9))
if [ "$MINE_TO_FALLBACK" -lt 1 ]; then
  log WARN "Already in fallback window. Skipping mine."
else
  log INFO "Mining $MINE_TO_FALLBACK block(s) to reach fallback window..."
  mine "$MINE_TO_FALLBACK"
fi

log RAW ""
log RAW "  ▶ Backend log should show:"
log RAW "    Fallback trigger: $ORDER_HASH"
log RAW "    Fallback executed: 0x..."
log RAW "    order updated to filled"
log RAW ""

# Wait a few seconds for fallback watcher (polls every 12s)
log INFO "Waiting 15s for fallback watcher poll cycle..."
sleep 15

# ── Done ──────────────────────────────────────────────────────────────────────
log STEP "All phases complete"
CURRENT=$(get_block)
log INFO "Final block: $CURRENT"
log RAW ""
log RAW "  Run verify.sh to check final state:"
log RAW "    ./tests/demo/verify.sh"
log RAW ""
