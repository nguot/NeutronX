#!/usr/bin/env bash
# Shared setup + helpers for the filler-race E2E scenarios.
#
# A "race" here is the two real filler bots (CoWFiller + WhaleFiller) competing
# to fill the same order(s) on a live Anvil mainnet fork. Orders are sized BIG so
# that neither filler can fill 100% in one chunk (each is capped at 50% of its
# USDC inventory per fill) — so the order is necessarily filled across both
# fillers in partial chunks, and the loser of any chunk reclaims its stake.
#
# Requires: foundry (anvil/cast/forge), jq, curl, docker (Postgres), node/npm.
set -euo pipefail

# ── repo layout ──────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CONTRACT="$ROOT/contract"
BACKEND="$ROOT/backend"
COW="$ROOT/filler/CoWFiller"
WHALE="$ROOT/filler/WhaleFiller"
LOGS="$HERE/logs"; mkdir -p "$LOGS"

export PATH="$HOME/.foundry/bin:$PATH"

# ── chain / accounts (Anvil defaults) ────────────────────────────────────────
RPC="${RPC:-http://127.0.0.1:8545}"
FORK_RPC="${FORK_RPC:-https://eth-mainnet.g.alchemy.com/v2/NqceSkD9a9GU5a-EbT9wp}"
FORK_BLOCK="${FORK_BLOCK:-20500000}"
CHAIN_ID=31337

PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # acct0: deployer + cosigner + swapper
A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
PK_WHALE=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d # acct1: WhaleFiller
A_WHALE=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
PK_COW=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a   # acct2: CoWFiller
A_COW=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

# ── mainnet token addresses (present on the fork) ────────────────────────────
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
# Aave V3 aUSDC reserve — Binance 14 (the old whale here) now only holds ~45K
# USDC (was much deeper when this was first pinned); a protocol reserve is far
# more stable. Re-verify with `cast call <USDC> "balanceOf(address)(uint256)"
# <whale> --rpc-url <RPC>` if this ever needs replacing again.
USDC_WHALE=0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c

# Filled in by deploy()
FILL_AUCTION=""; REACTOR=""; FALLBACK=""

PIDS=()
cleanup() {
  echo "[race] tearing down…"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  pkill -f "anvil --fork-url" 2>/dev/null || true
  pkill -f "anvil --port 8546" 2>/dev/null || true
}
trap cleanup EXIT

# ── stack ─────────────────────────────────────────────────────────────────────
start_anvil() {
  echo "[race] starting anvil fork @ block $FORK_BLOCK (block-time 2s)…"
  anvil --fork-url "$FORK_RPC" --fork-block-number "$FORK_BLOCK" \
        --chain-id "$CHAIN_ID" --block-time 2 >"$LOGS/anvil.log" 2>&1 &
  PIDS+=($!)
  until cast block-number --rpc-url "$RPC" >/dev/null 2>&1; do sleep 0.5; done
  # Chain B — a plain anvil so the backend's chainBWatcher can connect (it only
  # needs eth_chainId + an empty eth_getLogs). Without it the backend crashes on
  # boot with "could not detect network".
  echo "[race] starting Chain B anvil (port 8546)…"
  anvil --port 8546 --chain-id 31338 >"$LOGS/anvil_b.log" 2>&1 &
  PIDS+=($!)
  until cast block-number --rpc-url http://127.0.0.1:8546 >/dev/null 2>&1; do sleep 0.5; done
  echo "[race] anvil up (A + B)."
}

start_postgres() {
  echo "[race] ensuring Postgres (docker)…"
  ( cd "$BACKEND" && docker compose up -d 2>/dev/null ) || docker start backend-postgres-1 2>/dev/null || true
  sleep 3
}

start_backend() {
  # Reset persisted Postgres state BEFORE the backend boots:
  #  - orders/fills: stale rows from a prior run cause reused-nonce collisions
  #    and make the bots chase orders from an old deployment.
  #  - indexer_state: the fork resets to the same block each run, but this
  #    checkpoint persists — a stale (higher) checkpoint makes the indexer skip
  #    every new event, so fills/status are never written. Clearing it lets the
  #    indexer re-seed its checkpoint to the fresh fork on startup.
  # Done per-table so a not-yet-created table (first run) doesn't block the rest.
  echo "[race] resetting orders / fills / indexer_state…"
  for t in orders fills indexer_state; do
    docker exec -e PGPASSWORD=neutronx backend-postgres-1 \
      psql -U neutronx -d neutronx -c "TRUNCATE $t CASCADE;" >/dev/null 2>&1 || true
  done

  echo "[race] starting backend…"
  ( cd "$BACKEND" && npm start >"$LOGS/backend.log" 2>&1 & echo $! >"$LOGS/backend.pid" )
  PIDS+=("$(cat "$LOGS/backend.pid")")
  local tries=0
  until curl -s "http://localhost:3000/orders" >/dev/null 2>&1; do
    sleep 1; tries=$((tries+1))
    if [ "$tries" -gt 90 ]; then
      echo "[race] backend failed to start within 90s — last log:"; tail -25 "$LOGS/backend.log"; exit 1
    fi
  done
  echo "[race] backend up."
}

start_fillers() {
  echo "[race] starting CoWFiller + WhaleFiller…"
  ( cd "$WHALE" && npm start >"$LOGS/whale.log" 2>&1 & echo $! >"$LOGS/whale.pid" )
  ( cd "$COW"   && npm start >"$LOGS/cow.log"   2>&1 & echo $! >"$LOGS/cow.pid" )
  PIDS+=("$(cat "$LOGS/whale.pid")" "$(cat "$LOGS/cow.pid")")
  sleep 4
  echo "[race] fillers up."
}

# ── deploy + wire .env + fund ─────────────────────────────────────────────────
deploy() {
  echo "[race] deploying contracts…"
  ( cd "$CONTRACT" && PRIVATE_KEY="$PK0" forge script script/Deploy.s.sol:Deploy \
      --rpc-url "$RPC" --broadcast >"$LOGS/deploy.log" 2>&1 )
  local run="$CONTRACT/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
  FILL_AUCTION=$(jq -r '.transactions[] | select(.contractName=="FillAuction") | .contractAddress' "$run" | head -1)
  REACTOR=$(jq -r '.transactions[] | select(.contractName=="PartialFillReactor") | .contractAddress' "$run" | head -1)
  FALLBACK=$(jq -r '.transactions[] | select(.contractName=="FallbackExecutor") | .contractAddress' "$run" | head -1)
  echo "[race]   FillAuction        = $FILL_AUCTION"
  echo "[race]   PartialFillReactor = $REACTOR"
  echo "[race]   FallbackExecutor   = $FALLBACK"
  [ -n "$REACTOR" ] || { echo "[race] deploy parse failed"; cat "$LOGS/deploy.log"; exit 1; }
}

# rewrite the three address vars in a .env (keeps everything else intact)
_patch_env() {
  local f="$1"
  sed -i -E "s|^FILL_AUCTION=.*|FILL_AUCTION=$FILL_AUCTION|" "$f"
  sed -i -E "s|^PARTIAL_FILL_REACTOR=.*|PARTIAL_FILL_REACTOR=$REACTOR|" "$f"
  sed -i -E "s|^FALLBACK_EXECUTOR=.*|FALLBACK_EXECUTOR=$FALLBACK|" "$f"
}
wire_env() { _patch_env "$BACKEND/.env"; _patch_env "$COW/.env"; _patch_env "$WHALE/.env"; }

# fund the swapper (acct0) with WETH and set Permit2 allowances to the reactor
fund_swapper() {
  local weth_amt="$1"
  echo "[race] funding swapper with $weth_amt wei WETH + Permit2 approvals…"
  cast send "$WETH" "deposit()" --value "$weth_amt" --private-key "$PK0" --rpc-url "$RPC" >/dev/null
  cast send "$WETH" "approve(address,uint256)" "$PERMIT2" \
       0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
       --private-key "$PK0" --rpc-url "$RPC" >/dev/null
  # Permit2 AllowanceTransfer: approve(token, spender=reactor, amount(uint160), expiration(uint48))
  cast send "$PERMIT2" "approve(address,address,uint160,uint48)" \
       "$WETH" "$REACTOR" 1461501637330902918203684832716283019655932542975 281474976710655 \
       --private-key "$PK0" --rpc-url "$RPC" >/dev/null
}

# fund a filler with USDC (impersonate the whale) + approve the reactor
fund_filler() {
  local filler_addr="$1" filler_pk="$2" usdc_amt="$3"
  echo "[race] funding $filler_addr with $usdc_amt USDC…"
  cast rpc anvil_impersonateAccount "$USDC_WHALE" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$USDC_WHALE" 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null # 1 ETH for gas
  cast send "$USDC" "transfer(address,uint256)" "$filler_addr" "$usdc_amt" \
       --from "$USDC_WHALE" --unlocked --rpc-url "$RPC" >/dev/null
  cast rpc anvil_stopImpersonatingAccount "$USDC_WHALE" --rpc-url "$RPC" >/dev/null
  cast send "$USDC" "approve(address,uint256)" "$REACTOR" \
       0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
       --private-key "$filler_pk" --rpc-url "$RPC" >/dev/null
}

# ── orders ─────────────────────────────────────────────────────────────────────
# submit_order <inputWei> <minOutUsdc> <startPrice> <decayPerBlock> <minFillBps> <nonce> <deadlineBlocks>
# echoes the orderHash the backend returns.
submit_order() {
  local input="$1" minout="$2" price="$3" decay="$4" mfb="$5" nonce="$6" dl_off="$7"
  local now; now=$(cast block-number --rpc-url "$RPC")
  local deadline=$((now + dl_off))
  local body
  body=$(jq -nc --arg sw "$A0" --arg it "$WETH" --arg ot "$USDC" \
    --arg ia "$input" --arg mo "$minout" --arg sp "$price" \
    --argjson dl "$deadline" --argjson n "$nonce" --argjson mfb "$mfb" \
    --argjson dpb "$decay" --argjson ft 500 \
    '{order:{swapper:$sw,inputToken:$it,inputAmount:$ia,outputToken:$ot,
      minOutputAmount:$mo,deadline:$dl,nonce:$n,minFillBps:$mfb,
      startPrice:$sp,decayPerBlock:$dpb,feeTier:$ft},signature:"0x"}')
  curl -s -X POST "http://localhost:3000/orders" -H 'Content-Type: application/json' \
       -d "$body" | jq -r '.orderHash'
}

# ── queries ─────────────────────────────────────────────────────────────────────
onchain_remaining() { # <orderHash> <inputAmount>
  cast call "$REACTOR" "remainingInput(bytes32,uint256)(uint256)" "$1" "$2" --rpc-url "$RPC"
}
order_status() { curl -s "http://localhost:3000/orders/$1" | jq -r '.status'; }
fills_count()  { curl -s "http://localhost:3000/orders/$1" | jq '.fills | length'; }
usdc_bal()     { cast call "$USDC" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC"; }
weth_bal()     { cast call "$WETH" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC"; }
eth_bal()      { cast balance "$1" --rpc-url "$RPC"; }

# wait until remaining hits 0 or `maxsecs` elapse
wait_filled() { # <orderHash> <inputAmount> <maxsecs>
  local end=$(( $(date +%s) + ${3:-120} ))
  while [ "$(date +%s)" -lt "$end" ]; do
    local rem; rem=$(onchain_remaining "$1" "$2" | awk '{print $1}')
    echo "[race]   remaining=$rem"
    [ "$rem" = "0" ] && return 0
    sleep 3
  done
  return 1
}
