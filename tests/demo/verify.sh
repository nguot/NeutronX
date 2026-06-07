#!/usr/bin/env bash
# verify.sh — checks final on-chain and backend state, prints a summary table
# Run after run.sh completes (or at any point to check current state)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
load_log

log STEP "verify.sh — final state check (${DEMO_VERSION:-unknown})"
check_anvil

ORDER_HASH=$(cat "$LOG_DIR/.order_hash" 2>/dev/null || echo "")
if [ -z "$ORDER_HASH" ]; then
  log ERROR "No order hash found. Run submit_order.sh first."
  exit 1
fi
if [ -f "$LOG_DIR/.addresses" ]; then source "$LOG_DIR/.addresses"; fi

WETH="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
USDC="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
ACCOUNT0="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ACCOUNT1="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
ACCOUNT2="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"

# ── 1. Order status ───────────────────────────────────────────────────────────
log STEP "1. Order status (backend)"
ORDER_JSON=$(curl -sf "http://localhost:3000/orders/$ORDER_HASH" 2>/dev/null || echo "{}")
STATUS=$(echo "$ORDER_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
FILLS_COUNT=$(echo "$ORDER_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('fills',[])))" 2>/dev/null || echo "?")
log INFO "Order status: $STATUS"
log INFO "Total fills:  $FILLS_COUNT"
echo "$ORDER_JSON" >> "$LOG_FILE"

# ── 2. Fill details ───────────────────────────────────────────────────────────
log STEP "2. Fill details"
FILLS_JSON=$(curl -sf "http://localhost:3000/fills?order=$ORDER_HASH" 2>/dev/null || echo "{\"fills\":[]}")
echo "$FILLS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
fills = d.get('fills', [])
print(f'  Total fills: {len(fills)}')
for i, f in enumerate(fills, 1):
    amt_weth = int(f.get('fillAmount','0')) / 1e18
    amt_usdc = int(f.get('outputAmount','0')) / 1e6
    print(f'  Fill {i}: filler={f.get(\"filler\",\"?\")[:10]}...  {amt_weth:.4f} WETH  →  {amt_usdc:.2f} USDC  tx={f.get(\"txHash\",\"?\")[:12]}...')
" 2>/dev/null || echo "$FILLS_JSON"
echo "$FILLS_JSON" >> "$LOG_FILE"

# ── 3. On-chain remaining ─────────────────────────────────────────────────────
log STEP "3. On-chain remaining (PartialFillReactor)"
REMAINING_RAW=$(cast call "$REACTOR" \
  "remainingInput(bytes32,uint256)(uint256)" \
  "$ORDER_HASH" "4000000000000000000" \
  --rpc-url "$RPC" 2>/dev/null || echo "0")
REMAINING_ETH=$(python3 -c "print(f'{int(\"$REMAINING_RAW\") / 1e18:.4f}')" 2>/dev/null || echo "?")
log INFO "Remaining input: $REMAINING_RAW wei  (~$REMAINING_ETH WETH)"

# ── 4. Token balances ─────────────────────────────────────────────────────────
log STEP "4. Token balances"
W0=$(cast call "$WETH" "balanceOf(address)(uint256)" "$ACCOUNT0" --rpc-url "$RPC" 2>/dev/null || echo "?")
U0=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ACCOUNT0" --rpc-url "$RPC" 2>/dev/null || echo "?")
W1=$(cast call "$WETH" "balanceOf(address)(uint256)" "$ACCOUNT1" --rpc-url "$RPC" 2>/dev/null || echo "?")
U1=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ACCOUNT1" --rpc-url "$RPC" 2>/dev/null || echo "?")
W2=$(cast call "$WETH" "balanceOf(address)(uint256)" "$ACCOUNT2" --rpc-url "$RPC" 2>/dev/null || echo "?")
U2=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ACCOUNT2" --rpc-url "$RPC" 2>/dev/null || echo "?")

python3 - "$W0" "$U0" "$W1" "$U1" "$W2" "$U2" << 'PYEOF'
import sys
def parse_wei(s):
    # cast returns "123456 [1.23e5]" — take just the first token
    try: return int(s.split()[0])
    except: return 0
w0,u0,w1,u1,w2,u2 = [parse_wei(x) for x in sys.argv[1:]]
print(f"  Swapper   (Acc0): WETH={w0/1e18:.4f}  USDC={u0/1e6:.2f}")
print(f"  WhaleFiller(Acc1): WETH={w1/1e18:.4f}  USDC={u1/1e6:.2f}")
print(f"  CoWFiller  (Acc2): WETH={w2/1e18:.4f}  USDC={u2/1e6:.2f}")
PYEOF
log INFO "Balances logged above"

# ── Summary ───────────────────────────────────────────────────────────────────
log STEP "Summary"
log RAW ""
log RAW "  Version:       ${DEMO_VERSION:-unknown}"
log RAW "  Fork block:    ${FORK_BLOCK:-unknown}  (ETH ~\$${EXPECTED_ETH_PRICE:-?})"
log RAW "  Order hash:    $ORDER_HASH"
log RAW "  Status:        $STATUS"
log RAW "  Fill count:    $FILLS_COUNT"
log RAW "  Remaining:     $REMAINING_ETH WETH on-chain"
log RAW ""
log RAW "  Full log:      $LOG_FILE"
log RAW ""
