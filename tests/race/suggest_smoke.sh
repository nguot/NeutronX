#!/usr/bin/env bash
# Smoke test for POST /suggest-params — boots the full stack (reusing common.sh),
# funds both fillers so coverage is meaningful, then asks for suggested params on
# a big WETH→USDC order and prints the response.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

start_anvil
deploy
wire_env
# fund each filler 60k USDC → ~12 WETH single-fill cap; a 20 WETH order needs both.
fund_filler "$A_COW"   "$PK_COW"   60000000000
fund_filler "$A_WHALE" "$PK_WHALE" 60000000000
start_postgres
start_backend
start_fillers

echo "[suggest] waiting for filler quote servers (ports 3001 + 3002)…"
for port in 3001 3002; do
  tries=0
  until (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; do
    sleep 1; tries=$((tries+1))
    if [ $tries -gt 60 ]; then echo "[suggest] filler on $port never came up"; tail -15 "$LOGS/$( [ $port = 3001 ] && echo whale || echo cow ).log"; break; fi
  done
  echo "[suggest]   port $port up"
done
sleep 2

body=$(jq -nc --arg it "$WETH" --arg ot "$USDC" \
  '{inputToken:$it,outputToken:$ot,inputAmount:"20000000000000000000",
    inputDecimals:18,outputDecimals:6,inputSymbol:"WETH",outputSymbol:"USDC"}')

echo "[suggest] POST /suggest-params  (20 WETH → USDC):"
echo "$body" | jq .
echo "[suggest] ── response ──"
curl -s -X POST http://localhost:3000/suggest-params \
     -H 'Content-Type: application/json' -d "$body" | jq . || echo "(curl/jq failed)"
echo "[suggest] done"
