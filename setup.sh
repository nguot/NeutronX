#!/usr/bin/env bash
# setup.sh — one-shot devnet bootstrap.
#
#   1. Start Anvil forks for Chain A (:8545, chainId 31337) and
#      Chain B (:8546, chainId 31338) — see ACCOUNTS.md.
#   2. Deploy core contracts (FillAuction, PartialFillReactor, FallbackExecutor)
#      to Chain A via contract/script/Deploy.s.sol.
#   3. Write the deployed addresses into backend/.env, filler/CoWFiller/.env,
#      filler/WhaleFiller/.env (FILL_AUCTION / PARTIAL_FILL_REACTOR / FALLBACK_EXECUTOR).
#   4. Fund all standard dev accounts via funding/ (ETH + ERC20s on Chain A).
#
# Usage:
#   bash setup.sh          # start chains, deploy, wire .env files, fund accounts
#   bash setup.sh stop     # stop both Anvil forks
#
# After this: start backend (cd backend && npm start), then the fillers and frontend.
# For cross-chain (EscrowSrc/EscrowDst), run tests/crosschain/setup_cc.sh once the
# backend is up — see ACCOUNTS.md.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

export PATH="$HOME/.foundry/bin:$PATH"

ALCHEMY_URL="https://eth-mainnet.g.alchemy.com/v2/NqceSkD9a9GU5a-EbT9wp"
FORK_BLOCK="20500000"
RPC_A="http://127.0.0.1:8545"
RPC_B="http://127.0.0.1:8546"
CHAIN_A_ID=31337
CHAIN_B_ID=31338

PK0="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # Account 0 — deployer/swapper

# ── colours / logging ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
step() { printf "\n${CYAN}${BOLD}== %s ==${NC}\n" "$*"; }
ok()   { printf "${GREEN}  ✔ %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}  ⚠ %s${NC}\n" "$*"; }
err()  { printf "${RED}  ✖ %s${NC}\n" "$*"; }

# ── stop mode ─────────────────────────────────────────────────────────────────
if [ "${1:-}" = "stop" ]; then
  step "Stopping Anvil forks"
  pkill -f "anvil --fork-url.*--port 8545" 2>/dev/null && ok "stopped Chain A" || warn "Chain A not running"
  pkill -f "anvil --fork-url.*--port 8546" 2>/dev/null && ok "stopped Chain B" || warn "Chain B not running"
  exit 0
fi

for c in anvil cast forge jq npm; do
  command -v "$c" >/dev/null 2>&1 || { err "'$c' not found on PATH"; exit 1; }
done

# ── 1. start chains ──────────────────────────────────────────────────────────
step "Step 1 — starting Anvil forks"

start_chain() {
  local rpc="$1" port="$2" chainid="$3" label="$4" logf="$5"
  if cast block-number --rpc-url "$rpc" &>/dev/null; then
    ok "$label already running on :$port"
    return
  fi
  anvil --fork-url "$ALCHEMY_URL" --fork-block-number "$FORK_BLOCK" \
        --chain-id "$chainid" --port "$port" >"$logf" 2>&1 &
  until cast block-number --rpc-url "$rpc" &>/dev/null; do sleep 0.5; done
  ok "$label up on :$port (log: $logf)"
}

start_chain "$RPC_A" 8545 "$CHAIN_A_ID" "Chain A" "$LOG_DIR/anvil_a.log"
start_chain "$RPC_B" 8546 "$CHAIN_B_ID" "Chain B" "$LOG_DIR/anvil_b.log"

# ── 2. deploy core contracts to Chain A ─────────────────────────────────────
step "Step 2 — deploying core contracts to Chain A"

DEPLOY_OUT=$(cd "$ROOT/contract" && PRIVATE_KEY="$PK0" \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_A" --broadcast 2>&1) || true
echo "$DEPLOY_OUT" > "$LOG_DIR/deploy.log"

RUN_JSON="$ROOT/contract/broadcast/Deploy.s.sol/$CHAIN_A_ID/run-latest.json"
FILL_AUCTION=$(jq -r '.transactions[] | select(.contractName=="FillAuction") | .contractAddress' "$RUN_JSON" | head -1)
PARTIAL_FILL_REACTOR=$(jq -r '.transactions[] | select(.contractName=="PartialFillReactor") | .contractAddress' "$RUN_JSON" | head -1)
FALLBACK_EXECUTOR=$(jq -r '.transactions[] | select(.contractName=="FallbackExecutor") | .contractAddress' "$RUN_JSON" | head -1)

if [ -z "$PARTIAL_FILL_REACTOR" ]; then
  err "deploy failed or parse failed — see $LOG_DIR/deploy.log"
  tail -30 "$LOG_DIR/deploy.log"
  exit 1
fi
ok "FillAuction        = $FILL_AUCTION"
ok "PartialFillReactor = $PARTIAL_FILL_REACTOR"
ok "FallbackExecutor   = $FALLBACK_EXECUTOR"

# ── 3. wire addresses into .env files ───────────────────────────────────────
step "Step 3 — writing addresses into .env files"

update_env_var() {
  local file="$1" key="$2" val="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

for f in "$ROOT/backend/.env" "$ROOT/filler/CoWFiller/.env" "$ROOT/filler/WhaleFiller/.env"; do
  if [ -f "$f" ]; then
    update_env_var "$f" "FILL_AUCTION" "$FILL_AUCTION"
    update_env_var "$f" "PARTIAL_FILL_REACTOR" "$PARTIAL_FILL_REACTOR"
    update_env_var "$f" "FALLBACK_EXECUTOR" "$FALLBACK_EXECUTOR"
    ok "wired ${f#$ROOT/}"
  else
    warn "${f#$ROOT/} not found — skipping"
  fi
  if [ "$f" = "$ROOT/backend/.env" ] && [ -f "$f" ]; then
    # Chain A's fork reports chainId $CHAIN_A_ID but forks real mainnet (1) —
    # the fallback aggregator routing layer needs mainnet's chainId.
    update_env_var "$f" "AGGREGATOR_CHAIN_ID" "1"
  fi
done

# ── 3b. reset stale orders & indexer checkpoints ────────────────────────────
step "Step 3b — clearing stale orders & indexer state"

# PartialFillReactor's DOMAIN_SEPARATOR is derived from address(this) at deploy
# time, so every redeploy above gives orders signed against the old reactor an
# unrecoverable "invalid sig". Drop them now so fillers don't choke on ghosts
# from the previous deployment. indexer_state is reset too — its last_block
# checkpoints reference the *previous* reactor/fork and, if higher than the
# new chain's height (e.g. after an Anvil restart), would permanently stall
# eventIndexer's `blockNumber > lastFillBlock` loop.
docker exec -e PGPASSWORD=neutronx backend-postgres-1 \
  psql -U neutronx -d neutronx -c "TRUNCATE orders, fills, indexer_state CASCADE;" >/dev/null 2>&1 \
  && ok "cleared orders/fills/indexer_state from previous deployment" \
  || warn "could not reset orders/fills/indexer_state (db not running yet?)"

# ── 4. fund dev accounts ─────────────────────────────────────────────────────
step "Step 4 — funding dev accounts (funding/)"

( cd "$ROOT/funding" \
  && { [ -d node_modules ] || npm install --silent; } \
  && npm run fund ) || warn "funding failed — run manually: cd funding && npm run fund"

# ── summary ───────────────────────────────────────────────────────────────────
step "Setup complete"
printf "  Chain A : %s (chainId %s)\n" "$RPC_A" "$CHAIN_A_ID"
printf "  Chain B : %s (chainId %s)\n" "$RPC_B" "$CHAIN_B_ID"
printf "  FillAuction        : %s\n" "$FILL_AUCTION"
printf "  PartialFillReactor : %s\n" "$PARTIAL_FILL_REACTOR"
printf "  FallbackExecutor   : %s\n" "$FALLBACK_EXECUTOR"
printf "\n  Next steps:\n"
printf "    cd backend && npm start\n"
printf "    cd filler/WhaleFiller && npm start\n"
printf "    cd filler/CoWFiller && npm start\n"
printf "    cd frontend && npm run dev\n"
printf "\n  Cross-chain (optional): bash tests/crosschain/setup_cc.sh (after backend is up)\n"
printf "  Stop chains: bash setup.sh stop\n"
