#!/usr/bin/env bash
# setup_cc.sh — deploy CC contracts to two chains, fund all accounts
#
# Chain A  port 8545  chainId 31337  EscrowSrcFactory + EscrowDstFactory
# Chain B  port 8546  chainId 31338  EscrowDstFactory + EscrowSrcFactory
#
# Each chain gets BOTH factory kinds so swaps can run in either direction:
#   A→B: EscrowSrcFactory on A (ESCROW_SRC_FACTORY)  + EscrowDstFactory on B (FACTORY)
#   B→A: EscrowSrcFactory on B (ESCROW_SRC_FACTORY_B) + EscrowDstFactory on A (CHAIN_A_DST_FACTORY)
#
# Model 2 (filler-holds-key, continuous fill): there is no more cosigner/session
# step. EscrowSrcFactory only checks the swapper's own two signatures (order
# intent + per-fill authorization) — see EscrowSrcFactory.sol's file header.
# The backend's RELAYER_PRIVATE_KEY (backend/.env) is just a funded gas-paying
# wallet for relaying EscrowDst.claim() (permissionless — no on-chain trust
# check on who calls it), not a protocol-trusted signing key.
#
# Key difference from the old HTLC approach:
#   Fillers no longer need to approve any contract — they call
#   USDC.transfer(escrowAddr, amount) directly to the precomputed clone address.
#   So we do NOT set a USDC approval for the filler here.
#
# Prerequisites (each in a separate terminal):
#   Terminal 1: bash chaina_anvil.sh
#   Terminal 2: bash chainb_anvil.sh
#   Terminal 3: cd backend && npm start
#
# After setup finishes: RESTART backend so its watchers pick up CHAIN_B_FACTORY
# (A→B) and CHAIN_A_DST_FACTORY (B→A).

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
# Aave V3 aUSDC reserve — was 0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503 (a
# Binance-style hot wallet) but that address drained from ~543M USDC down to
# ~$0.01 over time; a protocol reserve is far more stable. Re-verify with
# `cast call <USDC> "balanceOf(address)(uint256)" <whale> --rpc-url <RPC>`
# if this ever needs replacing again.
USDC_WHALE="0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c"
MAX_UINT="115792089237316195423570985008687907853269984665640564039457584007913129639935"
BACKEND="http://localhost:3000"

ACCOUNT0="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"   # swapper
ACCOUNT1="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"   # Filler A
ACCOUNT2="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"   # Filler B
PK0="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
PK1="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
PK2="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"

# ── Tokens the swapper may use as inputToken — same SUPPORTED_TOKENS as
# filler/*/src/config.ts. Funded + Permit2-approved for the swapper on BOTH
# chains' EscrowSrcFactory (Steps 5 and 6b) so ANY token pair works for both
# A→B and B→A orders. WETH is wrapped from ETH; the rest come from Binance hot
# wallets — same whales filler/*/src/dev/seed.ts uses (deep balances on a
# mainnet fork).
USDT="0xdAC17F958D2ee523a2206206994597C13D831ec7"
DAI="0x6B175474E89094C44Da98b954EedeAC495271d0F"
WBTC="0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"
LINK="0x514910771AF9Ca656af840dff83E8264EcF986CA"
UNI="0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"
WHALE_1="0x28C6c06298d514Db089934071355E5743bf21d60"   # Binance 14
WHALE_2="0xF977814e90dA44bFA03b6295A0616a897441aceC"   # Binance 8 (fallback)
# Curve 3pool — DAI/USDC/USDT protocol reserve, fallback for when WHALE_1/2's
# stablecoin balances (exchange wallets, drift over time) fall short. See the
# USDC_WHALE comment above for why a protocol reserve is preferred here.
WHALE_3="0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7"
MAX_UINT160="1461501637330902918203684832716283019655932542975"   # Permit2 "infinite" allowance

declare -A TOKEN_ADDR=([WETH]=$WETH [USDC]=$USDC [USDT]=$USDT [DAI]=$DAI [WBTC]=$WBTC [LINK]=$LINK [UNI]=$UNI)
declare -A TOKEN_AMOUNT=([USDC]=10000000000 [USDT]=10000000000 [DAI]=10000000000000000000000 \
                         [WBTC]=1000000000 [LINK]=10000000000000000000000 [UNI]=10000000000000000000000)

# fund_swapper_token <rpc> <symbol> — transfer TOKEN_AMOUNT[symbol] of
# TOKEN_ADDR[symbol] to the swapper from a Binance whale (WHALE_1, fallback
# WHALE_2, fallback WHALE_3 for stablecoins).
fund_swapper_token() {
  local rpc="$1" sym="$2" token="${TOKEN_ADDR[$2]}" amount="${TOKEN_AMOUNT[$2]}"
  for whale in "$WHALE_1" "$WHALE_2" "$WHALE_3"; do
    cast rpc anvil_setBalance "$whale" "0xDE0B6B3A7640000" --rpc-url "$rpc" >/dev/null 2>&1 || true
    cast rpc anvil_impersonateAccount "$whale" --rpc-url "$rpc" >/dev/null 2>&1 || true
    if cast send "$token" "transfer(address,uint256)" "$ACCOUNT0" "$amount" \
         --from "$whale" --unlocked --rpc-url "$rpc" >>"$LOG_FILE" 2>&1; then
      cast rpc anvil_stopImpersonatingAccount "$whale" --rpc-url "$rpc" >/dev/null 2>&1 || true
      log OK "swapper $sym funded ($amount raw, from ${whale:0:10}…)"
      return 0
    fi
    cast rpc anvil_stopImpersonatingAccount "$whale" --rpc-url "$rpc" >/dev/null 2>&1 || true
  done
  log WARN "could not fund swapper with $sym on $rpc from any whale — orders using $sym as inputToken on this chain will fail"
}

# approve_swapper_token <rpc> <factory> <symbol> — ERC-20 approve(Permit2) +
# Permit2.approve(token, factory, MAX_UINT160, ...) for the swapper.
approve_swapper_token() {
  local rpc="$1" factory="$2" sym="$3" token="${TOKEN_ADDR[$3]}"
  # Real USDT reverts on approve(spender, nonzero) if the current allowance to
  # that spender is already nonzero (its approve() has an explicit require()
  # against the race-condition, unlike USDC/DAI). Resetting to 0 first makes
  # this idempotent across re-runs of this script for every token, not just USDT.
  run_cmd "ERC-20 reset $sym allowance -> Permit2 ($rpc)" \
    cast send "$token" "approve(address,uint256)" "$PERMIT2" "0" \
      --private-key "$PK0" --rpc-url "$rpc"
  run_cmd "ERC-20 approve $sym -> Permit2 ($rpc)" \
    cast send "$token" "approve(address,uint256)" "$PERMIT2" "$MAX_UINT" \
      --private-key "$PK0" --rpc-url "$rpc"
  run_cmd "Permit2 allowance $sym -> EscrowSrcFactory ($rpc)" \
    cast send "$PERMIT2" "approve(address,address,uint160,uint48)" \
      "$token" "$factory" "$MAX_UINT160" "9999999999" \
      --private-key "$PK0" --rpc-url "$rpc"
}

# fund_and_approve_swapper <rpc> <factory> — wrap WETH + fund/approve every
# SUPPORTED_TOKEN for the swapper against <factory> (this chain's
# EscrowSrcFactory), so any of these tokens can be used as inputToken on this chain.
fund_and_approve_swapper() {
  local rpc="$1" factory="$2"
  run_cmd "wrap 5 ETH -> WETH" \
    cast send "$WETH" "deposit()" --value 5ether --private-key "$PK0" --rpc-url "$rpc"
  approve_swapper_token "$rpc" "$factory" WETH
  for sym in USDC USDT DAI WBTC LINK UNI; do
    fund_swapper_token "$rpc" "$sym"
    approve_swapper_token "$rpc" "$factory" "$sym"
  done
}

log STEP "NeutronX Cross-Chain Setup (Escrow clone approach)"

# ── 1. Check services ─────────────────────────────────────────────────────────
log STEP "Step 1 — Checking services"

if ! cast block-number --rpc-url "$RPC_A" &>/dev/null; then
  log ERROR "Chain A not running at $RPC_A — start: bash chaina_anvil.sh"; exit 1
fi
log OK "Chain A — block $(cast block-number --rpc-url $RPC_A)"

if ! cast block-number --rpc-url "$RPC_B" &>/dev/null; then
  log ERROR "Chain B not running at $RPC_B — start: bash chainb_anvil.sh"; exit 1
fi
log OK "Chain B — block $(cast block-number --rpc-url $RPC_B)"

check_backend
sed -i 's/\r$//' "$PROJECT_ROOT/backend/.env" 2>/dev/null || true

# ── 2. Resolve the relayer's address from backend/.env ───────────────────────
# Model 2: no session/cosigner step — the relayer is a single, fixed backend-
# wide funded wallet (RELAYER_PRIVATE_KEY), not derived per-swapper.
log STEP "Step 2 — Resolving relayer address (backend/.env RELAYER_PRIVATE_KEY)"

RELAYER_PK=$(grep '^RELAYER_PRIVATE_KEY=' "$PROJECT_ROOT/backend/.env" | cut -d= -f2)
[ -z "$RELAYER_PK" ] && { log ERROR "RELAYER_PRIVATE_KEY not set in backend/.env"; exit 1; }
RELAYER=$(cast wallet address --private-key "$RELAYER_PK")
log OK "Relayer: $RELAYER"

# ── 3a. Deploy EscrowSrc impl + EscrowSrcFactory on Chain A ──────────────────
log STEP "Step 3a — Deploying EscrowSrc + EscrowSrcFactory on Chain A"

DEPLOY_A=$(cd "$PROJECT_ROOT/contract" && \
  forge script script/DeployCrossChain.s.sol:DeployCrossChain \
    --sig "runChainA()" --rpc-url "$RPC_A" --broadcast --legacy --private-key "$PK0" 2>&1)

echo "$DEPLOY_A" | tee -a "$LOG_FILE"
ESCROW_SRC_FACTORY=$(echo "$DEPLOY_A" | grep 'EscrowSrcFactory:' | grep -oP '0x[0-9a-fA-F]{40}' | head -1)
[ -z "$ESCROW_SRC_FACTORY" ] && { log ERROR "Could not parse EscrowSrcFactory address"; exit 1; }
log OK "EscrowSrcFactory on Chain A: $ESCROW_SRC_FACTORY"

# ── 3b. Deploy EscrowDst impl + EscrowDstFactory on Chain B ──────────────────
log STEP "Step 3b — Deploying EscrowDst + EscrowDstFactory on Chain B"

DEPLOY_B=$(cd "$PROJECT_ROOT/contract" && \
  forge script script/DeployCrossChain.s.sol:DeployCrossChain \
    --sig "runChainB()" --rpc-url "$RPC_B" --broadcast --legacy --private-key "$PK0" 2>&1)

echo "$DEPLOY_B" | tee -a "$LOG_FILE"
FACTORY=$(echo "$DEPLOY_B" | grep 'EscrowDstFactory:' | grep -oP '0x[0-9a-fA-F]{40}' | head -1)
[ -z "$FACTORY" ] && { log ERROR "Could not parse EscrowDstFactory address"; exit 1; }
log OK "EscrowDstFactory on Chain B: $FACTORY"

# ── 3c. Deploy EscrowSrc impl + EscrowSrcFactory on Chain B (for B→A swaps) ──
log STEP "Step 3c — Deploying EscrowSrc + EscrowSrcFactory on Chain B (for B→A swaps)"

DEPLOY_B_SRC=$(cd "$PROJECT_ROOT/contract" && \
  forge script script/DeployCrossChain.s.sol:DeployCrossChain \
    --sig "runChainB_Src()" --rpc-url "$RPC_B" --broadcast --legacy --private-key "$PK0" 2>&1)

echo "$DEPLOY_B_SRC" | tee -a "$LOG_FILE"
ESCROW_SRC_FACTORY_B=$(echo "$DEPLOY_B_SRC" | grep 'EscrowSrcFactory:' | grep -oP '0x[0-9a-fA-F]{40}' | head -1)
[ -z "$ESCROW_SRC_FACTORY_B" ] && { log ERROR "Could not parse EscrowSrcFactory (Chain B) address"; exit 1; }
log OK "EscrowSrcFactory on Chain B: $ESCROW_SRC_FACTORY_B"

# ── 3d. Deploy EscrowDst impl + EscrowDstFactory on Chain A (for B→A swaps) ──
log STEP "Step 3d — Deploying EscrowDst + EscrowDstFactory on Chain A (for B→A swaps)"

DEPLOY_A_DST=$(cd "$PROJECT_ROOT/contract" && \
  forge script script/DeployCrossChain.s.sol:DeployCrossChain \
    --sig "runChainA_Dst()" --rpc-url "$RPC_A" --broadcast --legacy --private-key "$PK0" 2>&1)

echo "$DEPLOY_A_DST" | tee -a "$LOG_FILE"
CHAIN_A_DST_FACTORY=$(echo "$DEPLOY_A_DST" | grep 'EscrowDstFactory:' | grep -oP '0x[0-9a-fA-F]{40}' | head -1)
[ -z "$CHAIN_A_DST_FACTORY" ] && { log ERROR "Could not parse EscrowDstFactory (Chain A) address"; exit 1; }
log OK "EscrowDstFactory on Chain A: $CHAIN_A_DST_FACTORY"

# Saved for manual `cast` debugging convenience.
cat > "$LOG_DIR/.cc_addresses" << EOF
ESCROW_SRC_FACTORY=$ESCROW_SRC_FACTORY
FACTORY=$FACTORY
ESCROW_SRC_FACTORY_B=$ESCROW_SRC_FACTORY_B
CHAIN_A_DST_FACTORY=$CHAIN_A_DST_FACTORY
RELAYER=$RELAYER
EOF
log OK "Saved addresses to $LOG_DIR/.cc_addresses"

# ── 3e. Clear stale cross-chain orders & watcher checkpoints ─────────────────
# Same reasoning as setup.sh's single-chain step: EscrowSrcFactory's
# DOMAIN_SEPARATOR is derived from address(this), so a redeploy above makes
# every previously-signed cc_orders row "invalid signature" against the new
# factory. Drop them, plus this CC pair's watcher checkpoints (indexer_state
# rows named escrow_src_*/escrow_dst_*) so escrowSrcWatcher/escrowDstWatcher
# don't try to resume from a block height that belongs to a now-replaced
# factory's history.
log STEP "Step 3e — clearing stale cross-chain orders & watcher checkpoints"

docker exec -e PGPASSWORD=neutronx backend-postgres-1 \
  psql -U neutronx -d neutronx -c "TRUNCATE cc_orders, cc_fills CASCADE;" >/dev/null 2>&1 \
  && log OK "cleared cc_orders/cc_fills from previous deployment" \
  || log WARN "could not clear cc_orders/cc_fills (db not running yet?)"

docker exec -e PGPASSWORD=neutronx backend-postgres-1 \
  psql -U neutronx -d neutronx -c "DELETE FROM indexer_state WHERE name LIKE 'escrow_src_%' OR name LIKE 'escrow_dst_%';" >/dev/null 2>&1 \
  && log OK "cleared escrow_src_*/escrow_dst_* watcher checkpoints" \
  || log WARN "could not clear watcher checkpoints (db not running yet?)"

# ── 4. Update backend .env ────────────────────────────────────────────────────
log STEP "Step 4 — Updating backend/.env and filler .env files"

# CROSS_CHAIN_REACTOR now holds the EscrowSrcFactory address (key name kept
# as-is — backend/src/routes/admin.ts still reads it for the admin UI's
# "crossChainReactor" display field).
update_env_var "$PROJECT_ROOT/backend/.env" "CROSS_CHAIN_REACTOR"   "$ESCROW_SRC_FACTORY"
update_env_var "$PROJECT_ROOT/backend/.env" "CHAIN_B_FACTORY"       "$FACTORY"
update_env_var "$PROJECT_ROOT/backend/.env" "CHAIN_B_RPC"           "$RPC_B"
update_env_var "$PROJECT_ROOT/backend/.env" "CHAIN_B_CONFIRMATIONS" "1"
log OK "backend/.env updated (CHAIN_B_FACTORY=$FACTORY)"

# B→A watcher: backend watches Chain A's EscrowDstFactory
update_env_var "$PROJECT_ROOT/backend/.env" "CHAIN_A_RPC"           "$RPC_A"
update_env_var "$PROJECT_ROOT/backend/.env" "CHAIN_A_DST_FACTORY"   "$CHAIN_A_DST_FACTORY"
update_env_var "$PROJECT_ROOT/backend/.env" "CHAIN_A_CONFIRMATIONS" "1"
log OK "backend/.env updated (CHAIN_A_DST_FACTORY=$CHAIN_A_DST_FACTORY)"

# Fillers need CC vars so their dev CLIs can show CC orders and fill them
for FILLER_DIR in "filler/WhaleFiller" "filler/CoWFiller"; do
  ENV_FILE="$PROJECT_ROOT/$FILLER_DIR/.env"
  if [ -f "$ENV_FILE" ]; then
    update_env_var "$ENV_FILE" "ESCROW_SRC_FACTORY"   "$ESCROW_SRC_FACTORY"
    update_env_var "$ENV_FILE" "CHAIN_B_RPC"          "$RPC_B"
    update_env_var "$ENV_FILE" "CHAIN_B_FACTORY"      "$FACTORY"
    update_env_var "$ENV_FILE" "ESCROW_SRC_FACTORY_B" "$ESCROW_SRC_FACTORY_B"
    update_env_var "$ENV_FILE" "CHAIN_A_DST_FACTORY"  "$CHAIN_A_DST_FACTORY"
    log OK "$FILLER_DIR/.env updated with CC vars"
  else
    log WARN "$ENV_FILE not found — skipping (run setup.sh first)"
  fi
done

# backend/config/chains.json is the ACTUAL source of truth for getChain() —
# it's what crosschainService.ts uses to build the EIP-712 domain separator
# when signing orders, and what /admin/config serves to the frontend. The
# .env vars above are legacy display-only fields; if this file isn't updated
# too, new orders get signed against a stale verifyingContract address and
# every fillSlot() reverts with "invalid signature" against the freshly
# deployed factory (contract's own domain separator uses address(this)).
CHAINS_JSON="$PROJECT_ROOT/backend/config/chains.json"
if [ -f "$CHAINS_JSON" ]; then
  TMP_JSON="$(mktemp)"
  jq --arg srcA "$ESCROW_SRC_FACTORY" --arg dstA "$CHAIN_A_DST_FACTORY" \
     --arg srcB "$ESCROW_SRC_FACTORY_B" --arg dstB "$FACTORY" '
    map(
      if .id == 31337 then .escrowSrcFactory = $srcA | .escrowDstFactory = $dstA
      elif .id == 31338 then .escrowSrcFactory = $srcB | .escrowDstFactory = $dstB
      else . end
    )
  ' "$CHAINS_JSON" > "$TMP_JSON" && mv "$TMP_JSON" "$CHAINS_JSON"
  log OK "backend/config/chains.json updated with fresh factory addresses"
else
  log WARN "$CHAINS_JSON not found — backend will use whatever it already has"
fi

# ── 5. Chain A — fund swapper with every supported token + Permit2 approvals ─
log STEP "Step 5 — Chain A: fund swapper with every supported token + Permit2 approvals (A→B src)"

fund_and_approve_swapper "$RPC_A" "$ESCROW_SRC_FACTORY"

WETH_BAL=$(cast call "$WETH" "balanceOf(address)(uint256)" "$ACCOUNT0" --rpc-url "$RPC_A")
log OK "Chain A — swapper WETH: $WETH_BAL wei"

# ── 5b. Chain A — wrap WETH for both fillers (for B→A EscrowDst deposits) ────
log STEP "Step 5b — Chain A: fund Filler A and Filler B with WETH (for B→A swaps)"

run_cmd "wrap 1 ETH → WETH (Filler A, Chain A)" \
  cast send "$WETH" "deposit()" --value 1ether --private-key "$PK1" --rpc-url "$RPC_A"

run_cmd "wrap 1 ETH → WETH (Filler B, Chain A)" \
  cast send "$WETH" "deposit()" --value 1ether --private-key "$PK2" --rpc-url "$RPC_A"

WETH_BAL1=$(cast call "$WETH" "balanceOf(address)(uint256)" "$ACCOUNT1" --rpc-url "$RPC_A")
WETH_BAL2=$(cast call "$WETH" "balanceOf(address)(uint256)" "$ACCOUNT2" --rpc-url "$RPC_A")
log OK "Chain A — Filler A WETH: $WETH_BAL1 wei"
log OK "Chain A — Filler B WETH: $WETH_BAL2 wei"

# ── 6. Chain B — fund both fillers with USDC ─────────────────────────────────
# NOTE: No approve step needed. Fillers transfer USDC directly to the precomputed
# escrow clone address — EscrowDst.initialize() verifies the balance.
log STEP "Step 6 — Chain B: fund Filler A (Account 1) and Filler B (Account 2) with USDC"
log INFO "No ERC-20 approval needed — fillers use direct transfer to escrow address"

# USDC_WHALE is Aave V3's aUSDC reserve — a protocol contract that holds deep
# USDC but no ETH (it never pays its own gas in normal operation), unlike a
# hot-wallet whale. Fund it the same way fund_swapper_token already does for
# WHALE_1/2/3, or impersonated cast send reverts with "out of gas: allowance 0".
run_cmd "fund USDC whale with ETH for gas" \
  cast rpc anvil_setBalance "$USDC_WHALE" "0xDE0B6B3A7640000" --rpc-url "$RPC_B"

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

# ── 6b. Chain B — fund swapper with every supported token + Permit2 approvals ─
log STEP "Step 6b — Chain B: fund swapper with every supported token + Permit2 approvals (B→A src)"

fund_and_approve_swapper "$RPC_B" "$ESCROW_SRC_FACTORY_B"

USDC_BAL0=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ACCOUNT0" --rpc-url "$RPC_B")
log OK "Chain B — swapper USDC: $USDC_BAL0"

# ── 7. Chain B — fund relayer with ETH (for claim() gas) ─────────────────────
log STEP "Step 7 — Chain B: fund relayer with ETH"

run_cmd "send 1 ETH to relayer on Chain B" \
  cast send "$RELAYER" --value 1ether --private-key "$PK0" --rpc-url "$RPC_B"

RELAYER_BAL=$(cast balance "$RELAYER" --rpc-url "$RPC_B")
log OK "Chain B — relayer ETH: $RELAYER_BAL wei"

# ── 7b. Chain A — fund relayer with ETH (for B→A claim() gas) ───────────────
log STEP "Step 7b — Chain A: fund relayer with ETH (for B→A swaps)"

run_cmd "send 1 ETH to relayer on Chain A" \
  cast send "$RELAYER" --value 1ether --private-key "$PK0" --rpc-url "$RPC_A"

RELAYER_BAL_A=$(cast balance "$RELAYER" --rpc-url "$RPC_A")
log OK "Chain A — relayer ETH: $RELAYER_BAL_A wei"

# ── Summary ───────────────────────────────────────────────────────────────────
log STEP "Setup complete"
log RAW ""
log RAW "  ┌─ Chain A (port 8545, chainId 31337) ────────────────────────"
log RAW "  │  EscrowSrcFactory  : $ESCROW_SRC_FACTORY    (A→B source)"
log RAW "  │  EscrowDstFactory  : $CHAIN_A_DST_FACTORY    (B→A destination)"
log RAW "  │  Swapper WETH      : $WETH_BAL wei"
log RAW "  │  Filler A WETH     : $WETH_BAL1 wei"
log RAW "  │  Filler B WETH     : $WETH_BAL2 wei"
log RAW "  │  Relayer ETH       : $RELAYER_BAL_A wei"
log RAW "  │"
log RAW "  ├─ Chain B (port 8546, chainId 31338) ────────────────────────"
log RAW "  │  EscrowDstFactory  : $FACTORY    (A→B destination)"
log RAW "  │  EscrowSrcFactory  : $ESCROW_SRC_FACTORY_B    (B→A source)"
log RAW "  │  Swapper USDC      : $USDC_BAL0"
log RAW "  │  Filler A USDC     : $USDC_BAL1 (no approval needed — direct transfer)"
log RAW "  │  Filler B USDC     : $USDC_BAL2 (no approval needed — direct transfer)"
log RAW "  │  Relayer ETH       : $RELAYER_BAL wei"
log RAW "  │"
log RAW "  └─ Relayer wallet    : $RELAYER"
log RAW ""
log RAW "  Swapper is funded + Permit2-approved for WETH, USDC, USDT, DAI, WBTC,"
log RAW "  LINK and UNI on BOTH chains — any inputToken works for A→B and B→A orders."
log RAW ""
log WARN "  ⚠  RESTART backend — needs CHAIN_B_FACTORY/CHAIN_B_RPC (A→B watcher) and"
log WARN "     CHAIN_A_DST_FACTORY/CHAIN_A_RPC (B→A watcher):"
log RAW "       Ctrl-C in backend terminal, then: cd backend && npm start"
log RAW ""
log RAW "  Then exercise the flow (Model 2 — no more run_cc.sh/run_cc_reverse.sh):"
log RAW "    1. POST /cc/orders (intent) + PATCH .../swapperSig — see routes/crosschain.ts"
log RAW "       (swapper signs with PK0 — the frontend does this once Phase 4 lands)"
log RAW "    2. cd filler/CoWFiller && npm start, then in its REPL/CLI:"
log RAW "         cc fill <orderHash> <pct>     — start a new fill"
log RAW "         cc resume <orderHash> <fillId> — resume after a crash/restart"
log RAW "  Log: $LOG_FILE"
