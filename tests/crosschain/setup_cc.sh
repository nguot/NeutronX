#!/usr/bin/env bash
# setup_cc.sh — deploy CC contracts to two chains, fund all accounts
#
# Chain A  port 8545  chainId 31337  CrossChainReactor
# Chain B  port 8546  chainId 31338  EscrowDstFactory  (+ EscrowDst implementation)
#
# Key difference from the old HTLC approach:
#   Fillers no longer need to approve any contract — they call
#   USDC.transfer(escrowAddr, amount) directly to the precomputed clone address.
#   So we do NOT set a USDC approval for the filler here.
#
# Prerequisites (each in a separate terminal):
#   Terminal 1: bash tests/crosschain/chaina_anvil.sh
#   Terminal 2: bash tests/crosschain/chainb_anvil.sh
#   Terminal 3: cd backend && npm start
#
# After setup finishes: RESTART backend so chainBWatcher picks up CHAIN_B_FACTORY.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="/mnt/c/Users/vutie/Documents/DATN/dex-aggregator"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

source "$SCRIPT_DIR/_lib_cc.sh"
export LOG_FILE="$LOG_DIR/setup_cc_$(date +%Y%m%d_%H%M%S).log"

RPC_A="http://127.0.0.1:8545"
RPC_B="http://127.0.0.1:8546"

PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3"
WETH="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
USDC="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
USDC_WHALE="0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503"
MAX_UINT="115792089237316195423570985008687907853269984665640564039457584007913129639935"
BACKEND="http://localhost:3000"

ACCOUNT0="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"   # swapper
ACCOUNT1="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"   # Filler A
ACCOUNT2="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"   # Filler B
PK0="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
PK1="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
PK2="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"

log STEP "NeutronX Cross-Chain Setup (Escrow clone approach)"

# ── 1. Check services ─────────────────────────────────────────────────────────
log STEP "Step 1 — Checking services"

if ! cast block-number --rpc-url "$RPC_A" &>/dev/null; then
  log ERROR "Chain A not running at $RPC_A — start: bash tests/crosschain/chaina_anvil.sh"; exit 1
fi
log OK "Chain A — block $(cast block-number --rpc-url $RPC_A)"

if ! cast block-number --rpc-url "$RPC_B" &>/dev/null; then
  log ERROR "Chain B not running at $RPC_B — start: bash tests/crosschain/chainb_anvil.sh"; exit 1
fi
log OK "Chain B — block $(cast block-number --rpc-url $RPC_B)"

check_backend
sed -i 's/\r$//' "$PROJECT_ROOT/backend/.env" 2>/dev/null || true

# ── 2. Create backend session → get cosigner address ─────────────────────────
log STEP "Step 2 — Creating backend CC session for swapper ($ACCOUNT0)"

SESSION_RESP=$(curl -sf -X POST "$BACKEND/cc/session" \
  -H "Content-Type: application/json" \
  -d "{\"swapper\":\"$ACCOUNT0\"}")

[ -z "$SESSION_RESP" ] && { log ERROR "Empty response from /cc/session"; exit 1; }

COSIGNER=$(echo "$SESSION_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['cosignerAddr'])")
IS_NEW=$(echo   "$SESSION_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['isNew'])")
log OK "Cosigner: $COSIGNER  (isNew=$IS_NEW)"

# ── 3a. Deploy CrossChainReactor on Chain A ───────────────────────────────────
log STEP "Step 3a — Deploying CrossChainReactor on Chain A"

DEPLOY_A=$(cd "$PROJECT_ROOT/contract" && \
  PRIVATE_KEY=$PK0 COSIGNER_ADDRESS=$COSIGNER \
  forge script script/DeployCrossChain.s.sol:DeployCrossChain \
    --sig "runChainA()" --rpc-url "$RPC_A" --broadcast 2>&1)

echo "$DEPLOY_A" | tee -a "$LOG_FILE"
CC_REACTOR=$(echo "$DEPLOY_A" | grep 'CrossChainReactor:' | grep -oP '0x[0-9a-fA-F]{40}' | head -1)
[ -z "$CC_REACTOR" ] && { log ERROR "Could not parse CrossChainReactor address"; exit 1; }
log OK "CrossChainReactor on Chain A: $CC_REACTOR"

# ── 3b. Deploy EscrowDst impl + EscrowDstFactory on Chain B ──────────────────
log STEP "Step 3b — Deploying EscrowDst + EscrowDstFactory on Chain B"

DEPLOY_B=$(cd "$PROJECT_ROOT/contract" && \
  PRIVATE_KEY=$PK0 \
  forge script script/DeployCrossChain.s.sol:DeployCrossChain \
    --sig "runChainB()" --rpc-url "$RPC_B" --broadcast 2>&1)

echo "$DEPLOY_B" | tee -a "$LOG_FILE"
FACTORY=$(echo "$DEPLOY_B" | grep 'EscrowDstFactory:' | grep -oP '0x[0-9a-fA-F]{40}' | head -1)
[ -z "$FACTORY" ] && { log ERROR "Could not parse EscrowDstFactory address"; exit 1; }
log OK "EscrowDstFactory on Chain B: $FACTORY"

# Save for run_cc.sh
cat > "$LOG_DIR/.cc_addresses" << EOF
CC_REACTOR=$CC_REACTOR
FACTORY=$FACTORY
COSIGNER=$COSIGNER
EOF
log OK "Saved addresses to $LOG_DIR/.cc_addresses"

# ── 4. Update backend .env ────────────────────────────────────────────────────
log STEP "Step 4 — Updating backend/.env and filler .env files"

update_env_var "$PROJECT_ROOT/backend/.env" "CROSS_CHAIN_REACTOR"   "$CC_REACTOR"
update_env_var "$PROJECT_ROOT/backend/.env" "CHAIN_B_FACTORY"       "$FACTORY"
update_env_var "$PROJECT_ROOT/backend/.env" "CHAIN_B_RPC"           "$RPC_B"
update_env_var "$PROJECT_ROOT/backend/.env" "CHAIN_B_CONFIRMATIONS" "1"
log OK "backend/.env updated (CHAIN_B_FACTORY=$FACTORY)"

# Fillers need CC vars so their dev UIs can show CC orders and fill slots
for FILLER_DIR in "filler/WhaleFiller" "filler/CoWFiller"; do
  ENV_FILE="$PROJECT_ROOT/$FILLER_DIR/.env"
  if [ -f "$ENV_FILE" ]; then
    update_env_var "$ENV_FILE" "CC_REACTOR"      "$CC_REACTOR"
    update_env_var "$ENV_FILE" "CHAIN_B_RPC"     "$RPC_B"
    update_env_var "$ENV_FILE" "CHAIN_B_FACTORY" "$FACTORY"
    log OK "$FILLER_DIR/.env updated with CC vars"
  else
    log WARN "$ENV_FILE not found — skipping (run tests/demo/setup.sh first)"
  fi
done

# ── 5. Chain A — wrap WETH + Permit2 approvals for swapper ───────────────────
log STEP "Step 5 — Chain A: fund swapper + Permit2 approvals"

run_cmd "wrap 5 ETH → WETH (Chain A)" \
  cast send "$WETH" "deposit()" --value 5ether --private-key "$PK0" --rpc-url "$RPC_A"

run_cmd "ERC-20 approve WETH → Permit2 (Chain A)" \
  cast send "$WETH" "approve(address,uint256)" \
    "$PERMIT2" "$MAX_UINT" --private-key "$PK0" --rpc-url "$RPC_A"

run_cmd "Permit2 allowance WETH → CrossChainReactor" \
  cast send "$PERMIT2" "approve(address,address,uint160,uint48)" \
    "$WETH" "$CC_REACTOR" "10000000000000000000000" "9999999999" \
    --private-key "$PK0" --rpc-url "$RPC_A"

WETH_BAL=$(cast call "$WETH" "balanceOf(address)(uint256)" "$ACCOUNT0" --rpc-url "$RPC_A")
log OK "Chain A — swapper WETH: $WETH_BAL wei"

# ── 6. Chain B — fund both fillers with USDC ─────────────────────────────────
# NOTE: No approve step needed. Fillers transfer USDC directly to the precomputed
# escrow clone address — EscrowDst.initialize() verifies the balance.
log STEP "Step 6 — Chain B: fund Filler A (Account 1) and Filler B (Account 2) with USDC"
log INFO "No ERC-20 approval needed — fillers use direct transfer to escrow address"

run_cmd "impersonate USDC whale" \
  cast rpc anvil_impersonateAccount "$USDC_WHALE" --rpc-url "$RPC_B"

run_cmd "transfer 10 000 USDC to Filler A (Account 1) on Chain B" \
  cast send "$USDC" "transfer(address,uint256)" \
    "$ACCOUNT1" "10000000000" --from "$USDC_WHALE" --unlocked --rpc-url "$RPC_B"

run_cmd "transfer 10 000 USDC to Filler B (Account 2) on Chain B" \
  cast send "$USDC" "transfer(address,uint256)" \
    "$ACCOUNT2" "10000000000" --from "$USDC_WHALE" --unlocked --rpc-url "$RPC_B"

run_cmd "stop impersonating whale" \
  cast rpc anvil_stopImpersonatingAccount "$USDC_WHALE" --rpc-url "$RPC_B"

USDC_BAL1=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ACCOUNT1" --rpc-url "$RPC_B")
USDC_BAL2=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ACCOUNT2" --rpc-url "$RPC_B")
log OK "Chain B — Filler A USDC: $USDC_BAL1"
log OK "Chain B — Filler B USDC: $USDC_BAL2"

# ── 7. Chain B — fund cosigner with ETH (for claim() gas) ────────────────────
log STEP "Step 7 — Chain B: fund cosigner with ETH"

run_cmd "send 1 ETH to cosigner on Chain B" \
  cast send "$COSIGNER" --value 1ether --private-key "$PK0" --rpc-url "$RPC_B"

COSIGNER_BAL=$(cast balance "$COSIGNER" --rpc-url "$RPC_B")
log OK "Chain B — cosigner ETH: $COSIGNER_BAL wei"

# ── Summary ───────────────────────────────────────────────────────────────────
log STEP "Setup complete"
log RAW ""
log RAW "  ┌─ Chain A (port 8545, chainId 31337) ────────────────────────"
log RAW "  │  CrossChainReactor : $CC_REACTOR"
log RAW "  │  Swapper WETH      : $WETH_BAL wei"
log RAW "  │"
log RAW "  ├─ Chain B (port 8546, chainId 31338) ────────────────────────"
log RAW "  │  EscrowDstFactory  : $FACTORY"
log RAW "  │  Filler A USDC     : $USDC_BAL1 (no approval needed — direct transfer)"
log RAW "  │  Filler B USDC     : $USDC_BAL2 (no approval needed — direct transfer)"
log RAW "  │  Cosigner ETH      : $COSIGNER_BAL wei"
log RAW "  │"
log RAW "  └─ Cosigner wallet   : $COSIGNER"
log RAW ""
log WARN "  ⚠  RESTART backend — needs CHAIN_B_FACTORY + CHAIN_B_RPC to watch Chain B:"
log RAW "       Ctrl-C in backend terminal, then: cd backend && npm start"
log RAW ""
log RAW "  Then run: bash tests/crosschain/run_cc.sh"
log RAW "  Log: $LOG_FILE"
