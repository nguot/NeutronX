#!/usr/bin/env bash
# setup.sh — deploy contracts, fund accounts, set approvals
# Run once after starting Anvil and before submit_order.sh
# Usage: source the version's anvil script env vars first, then run this

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
init_log   # creates a new timestamped log file for this run

PROJECT_ROOT="/mnt/c/Users/vutie/Documents/DATN/dex-aggregator"

# ── constants ─────────────────────────────────────────────────────────────────
PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3"
WETH="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
USDC="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
USDC_WHALE="0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503"
MAX_UINT="115792089237316195423570985008687907853269984665640564039457584007913129639935"

ACCOUNT0="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ACCOUNT1="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
ACCOUNT2="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
PK0="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
PK1="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
PK2="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"

# Fix Windows CRLF line endings in .env files so grep/cut don't return \r-tainted values
for _f in \
  "$PROJECT_ROOT/backend/.env" \
  "$PROJECT_ROOT/filler/WhaleFiller/.env" \
  "$PROJECT_ROOT/filler/CoWFiller/.env" \
  "$PROJECT_ROOT/solver/.env"; do
  [ -f "$_f" ] && sed -i 's/\r$//' "$_f"
done

log STEP "NeutronX Demo Setup — ${DEMO_VERSION:-vX} (block ${FORK_BLOCK:-latest})"

# ── 1. Check Anvil ────────────────────────────────────────────────────────────
log STEP "Step 1 — Checking Anvil"
check_anvil

# ── 2. Deploy contracts ───────────────────────────────────────────────────────
log STEP "Step 2 — Deploying contracts"
log INFO "Running forge deploy script..."

DEPLOY_OUT=$(cd "$PROJECT_ROOT/contract" && \
  PRIVATE_KEY=$PK0 forge script script/Deploy.s.sol:Deploy \
    --rpc-url "$RPC" \
    --broadcast 2>&1)

echo "$DEPLOY_OUT" | tee -a "$LOG_FILE"

# Parse deployed addresses — extract the 0x address from each labelled line
FILL_AUCTION=$(echo "$DEPLOY_OUT" | grep 'FillAuction:'      | grep -oP '0x[0-9a-fA-F]{40}' | head -1)
REACTOR=$(echo "$DEPLOY_OUT"      | grep 'PartialFillReactor:' | grep -oP '0x[0-9a-fA-F]{40}' | head -1)
FALLBACK=$(echo "$DEPLOY_OUT"     | grep 'FallbackExecutor:'  | grep -oP '0x[0-9a-fA-F]{40}' | head -1)

if [ -z "$FILL_AUCTION" ] || [ -z "$REACTOR" ] || [ -z "$FALLBACK" ]; then
  log ERROR "Could not parse contract addresses from forge output. Check log for details."
  log WARN  "Falling back to addresses already in .env files"
  FILL_AUCTION=$(grep FILL_AUCTION "$PROJECT_ROOT/backend/.env" | cut -d= -f2 | tr -d '\r')
  REACTOR=$(grep PARTIAL_FILL_REACTOR "$PROJECT_ROOT/backend/.env" | cut -d= -f2 | tr -d '\r')
  FALLBACK=$(grep FALLBACK_EXECUTOR "$PROJECT_ROOT/backend/.env" | cut -d= -f2 | tr -d '\r')
fi

log OK "FillAuction:        $FILL_AUCTION"
log OK "PartialFillReactor: $REACTOR"
log OK "FallbackExecutor:   $FALLBACK"

# Save addresses for other scripts to use
cat > "$LOG_DIR/.addresses" << EOF
FILL_AUCTION=$FILL_AUCTION
REACTOR=$REACTOR
FALLBACK=$FALLBACK
EOF

# ── 3. Update .env files ──────────────────────────────────────────────────────
log STEP "Step 3 — Updating .env files with new addresses"

for envfile in \
  "$PROJECT_ROOT/backend/.env" \
  "$PROJECT_ROOT/filler/WhaleFiller/.env" \
  "$PROJECT_ROOT/filler/CoWFiller/.env" \
  "$PROJECT_ROOT/solver/.env"; do
  if [ -f "$envfile" ]; then
    update_env_var "$envfile" "FILL_AUCTION"        "$FILL_AUCTION"
    update_env_var "$envfile" "PARTIAL_FILL_REACTOR" "$REACTOR"
    update_env_var "$envfile" "FALLBACK_EXECUTOR"   "$FALLBACK"
    log OK "Updated $envfile"
  fi
done

# Inject mock market price into filler envs
for envfile in \
  "$PROJECT_ROOT/filler/WhaleFiller/.env" \
  "$PROJECT_ROOT/filler/CoWFiller/.env" \
  "$PROJECT_ROOT/solver/.env"; do
  if [ -f "$envfile" ] && [ -n "$MOCK_MARKET_PRICE" ]; then
    update_env_var "$envfile" "MOCK_MARKET_PRICE" "$MOCK_MARKET_PRICE"
    log OK "Set MOCK_MARKET_PRICE=$MOCK_MARKET_PRICE in $envfile"
  fi
done

# ── 4. Wrap ETH → WETH for swapper ───────────────────────────────────────────
log STEP "Step 4 — Wrapping ETH → WETH for swapper (Account 0)"
run_cmd "wrap 5 ETH" \
  cast send "$WETH" "deposit()" \
    --value 5ether \
    --private-key "$PK0" \
    --rpc-url "$RPC"

WETH_BAL=$(cast call "$WETH" "balanceOf(address)(uint256)" "$ACCOUNT0" --rpc-url "$RPC")
log OK "WETH balance of Account 0: $WETH_BAL"

# ── 5. Permit2 approvals for swapper ──────────────────────────────────────────
log STEP "Step 5 — Setting Permit2 approvals for swapper"

run_cmd "ERC20 approve WETH → Permit2" \
  cast send "$WETH" "approve(address,uint256)" \
    "$PERMIT2" "$MAX_UINT" \
    --private-key "$PK0" --rpc-url "$RPC"

run_cmd "Permit2 allowance WETH → Reactor" \
  cast send "$PERMIT2" "approve(address,address,uint160,uint48)" \
    "$WETH" "$REACTOR" \
    "1000000000000000000000" "9999999999" \
    --private-key "$PK0" --rpc-url "$RPC"

run_cmd "Permit2 allowance WETH → FallbackExecutor" \
  cast send "$PERMIT2" "approve(address,address,uint160,uint48)" \
    "$WETH" "$FALLBACK" \
    "1000000000000000000000" "9999999999" \
    --private-key "$PK0" --rpc-url "$RPC"

# ── 6. Fund fillers with USDC ─────────────────────────────────────────────────
log STEP "Step 6 — Funding fillers with USDC (impersonating whale)"

run_cmd "impersonate USDC whale" \
  cast rpc anvil_impersonateAccount "$USDC_WHALE" --rpc-url "$RPC"

run_cmd "send 5000 USDC to WhaleFiller (Account 1)" \
  cast send "$USDC" "transfer(address,uint256)" \
    "$ACCOUNT1" "5000000000" \
    --from "$USDC_WHALE" --unlocked --rpc-url "$RPC"

run_cmd "send 10000 USDC to CoWFiller (Account 2)" \
  cast send "$USDC" "transfer(address,uint256)" \
    "$ACCOUNT2" "10000000000" \
    --from "$USDC_WHALE" --unlocked --rpc-url "$RPC"

run_cmd "stop impersonating whale" \
  cast rpc anvil_stopImpersonatingAccount "$USDC_WHALE" --rpc-url "$RPC"

USDC_BAL1=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ACCOUNT1" --rpc-url "$RPC")
USDC_BAL2=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ACCOUNT2" --rpc-url "$RPC")
log OK "WhaleFiller USDC: $USDC_BAL1"
log OK "CoWFiller USDC:   $USDC_BAL2"

# ── 7. Fillers approve Reactor to spend USDC ──────────────────────────────────
log STEP "Step 7 — Filler USDC approvals to Reactor"

run_cmd "WhaleFiller approve USDC → Reactor" \
  cast send "$USDC" "approve(address,uint256)" \
    "$REACTOR" "$MAX_UINT" \
    --private-key "$PK1" --rpc-url "$RPC"

run_cmd "CoWFiller approve USDC → Reactor" \
  cast send "$USDC" "approve(address,uint256)" \
    "$REACTOR" "$MAX_UINT" \
    --private-key "$PK2" --rpc-url "$RPC"

# ── Summary ───────────────────────────────────────────────────────────────────
log STEP "Setup complete"
log RAW ""
log RAW "  Contracts:"
log RAW "    FillAuction:        $FILL_AUCTION"
log RAW "    PartialFillReactor: $REACTOR"
log RAW "    FallbackExecutor:   $FALLBACK"
log RAW ""
log RAW "  Next steps:"
log WARN "  ⚠  RESTART backend + fillers now — they must load the new contract addresses"
log RAW "    1. Restart backend:   Ctrl-C then: cd backend && npm start"
log RAW "    2. Restart WhaleFiller: Ctrl-C then: cd filler/WhaleFiller && npm start"
log RAW "    3. Restart CoWFiller:   Ctrl-C then: cd filler/CoWFiller && npm start"
log RAW "    4. Run:               ./tests/demo/submit_order.sh"
log RAW "    (backend uses PARTIAL_FILL_REACTOR in its EIP-712 domain separator —"
log RAW "     if it was running before setup.sh, it has the old address → invalid sig)"
log RAW ""
log RAW "  Log file: $LOG_FILE"
