#!/usr/bin/env bash
# submit_order.sh — computes deadline, posts the Dutch auction order to backend
# Saves orderHash to logs/.order_hash for use by run.sh and verify.sh
# Must run AFTER setup.sh and after backend is started

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
load_log   # append to the same log file started by setup.sh

log STEP "submit_order.sh — posting Dutch auction order"
check_anvil
check_backend

# Load addresses from setup
ADDRESS_FILE="$LOG_DIR/.addresses"
if [ -f "$ADDRESS_FILE" ]; then
  source "$ADDRESS_FILE"
else
  log WARN ".addresses file not found — using .env values"
  REACTOR=$(grep PARTIAL_FILL_REACTOR "$PROJECT_ROOT/backend/.env" | cut -d= -f2)
fi

# Order parameters (same for all 3 versions)
SWAPPER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
WETH="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
USDC="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
INPUT_AMOUNT="4000000000000000000"        # 4 WETH (18 decimals)
MIN_OUTPUT="9500000000"                   # 9500 USDC (6 decimals)
START_PRICE="2490000000"                  # 2490 USDC/WETH (6 decimals)
DECAY_PER_BLOCK="100000"                  # 0.1 USDC/block (6 decimals)
MIN_FILL_BPS="100"                        # 1% minimum chunk
FEE_TIER="500"                            # Uniswap 0.05% pool
NONCE="1"

# Compute deadline: current block + 100 blocks
CURRENT_BLOCK=$(get_block)
DEADLINE=$((CURRENT_BLOCK + 100))

log INFO "Current block:  $CURRENT_BLOCK"
log INFO "Deadline block: $DEADLINE (current + 100)"
log INFO "Order: 4 WETH → min 9500 USDC | startPrice=2490 | decay=0.1/block"

# POST the order
log INFO "Sending POST /orders..."
# Use -s (silent) not -sf: -f would silently exit on HTTP 4xx before we can print the error body
RESPONSE=$(curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d "{
    \"order\": {
      \"swapper\":         \"$SWAPPER\",
      \"inputToken\":      \"$WETH\",
      \"outputToken\":     \"$USDC\",
      \"inputAmount\":     \"$INPUT_AMOUNT\",
      \"minOutputAmount\": \"$MIN_OUTPUT\",
      \"startPrice\":      \"$START_PRICE\",
      \"decayPerBlock\":   $DECAY_PER_BLOCK,
      \"deadline\":        $DEADLINE,
      \"nonce\":           $NONCE,
      \"minFillBps\":      $MIN_FILL_BPS,
      \"feeTier\":         $FEE_TIER
    },
    \"signature\": \"0x\"
  }" 2>&1)

echo "$RESPONSE" | tee -a "$LOG_FILE"

ORDER_HASH=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('orderHash',''))" 2>/dev/null || \
             echo "$RESPONSE" | grep -oP '"orderHash"\s*:\s*"\K[^"]+' | head -1)

if [ -z "$ORDER_HASH" ]; then
  BACKEND_ERR=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','(no error field)'))" 2>/dev/null || echo "$RESPONSE")
  log ERROR "Failed to extract orderHash. Backend said: $BACKEND_ERR"
  exit 1
fi

log OK "Order submitted — hash: $ORDER_HASH"

# Save for other scripts
echo "$ORDER_HASH" > "$LOG_DIR/.order_hash"
echo "$DEADLINE"   > "$LOG_DIR/.deadline"

log RAW ""
log RAW "  orderHash: $ORDER_HASH"
log RAW "  deadline:  block $DEADLINE  (in ~100 blocks)"
log RAW ""
log RAW "  Next step: ./tests/demo/run.sh"
log RAW ""
log RAW "  Watch filler terminals — they should detect the order within ~6s."
