#!/usr/bin/env bash
# run_cc.sh — end-to-end cross-chain swap using EscrowSrc/EscrowDst clone pattern
# Two fillers concurrently fill two different slots of the same order.
#
# Chain A (port 8545): EscrowSrcFactory — swapper's WETH pulled per-slot via Permit2
# Chain B (port 8546): EscrowDstFactory — fillers deploy isolated escrow clones
#
# Chain A filler flow, run independently by EACH filler for its own slot:
#   1. factory.fillSlot(info, swapperSig, cosignerSig, slotIndex, H_i, proof)
#      with msg.value = safety deposit  (lazily registers the order on its
#      first call, verifies the Merkle proof, deploys an EscrowSrc clone, and
#      pulls slotAmount of WETH from the swapper via Permit2)
#   2. EscrowSrc(escrow).withdraw(S_i)  — once S_i is public on Chain B
#
# Chain B filler flow (unchanged, NO approve needed):
#   1. computeAddress(H_i, filler) → escrowAddr  (free, off-chain)
#   2. USDC.transfer(escrowAddr, amount)          (tokens land at future clone)
#   3. factory.deploy(H_i, swapper, USDC, ...)   (deploys clone, verifies balance)
#
# Prerequisites:
#   Chain A running:  bash tests/crosschain/chaina_anvil.sh
#   Chain B running:  bash tests/crosschain/chainb_anvil.sh
#   Backend running:  cd backend && npm start  (restarted after setup_cc.sh)
#   setup_cc.sh done: logs/.cc_addresses exists

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="/mnt/c/Users/vutie/Documents/DATN/dex-aggregator"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

source "$SCRIPT_DIR/_lib_cc.sh"
export LOG_FILE="$LOG_DIR/run_cc_$(date +%Y%m%d_%H%M%S).log"

RPC_A="http://127.0.0.1:8545"
RPC_B="http://127.0.0.1:8546"
BACKEND="http://localhost:3000"

ACCOUNT0="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"   # swapper
ACCOUNT1="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"   # Filler A — fills slot 0
ACCOUNT2="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"   # Filler B — fills slot 1
PK0="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
PK1="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
PK2="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"

WETH="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
USDC="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

# Two independent fillers, each filling a different slot of the same order
FILLER_NAMES=("Filler A" "Filler B")
FILLER_ADDRS=("$ACCOUNT1" "$ACCOUNT2")
FILLER_PKS=("$PK1"       "$PK2")
SLOTS=(0 1)

# ── 0. Guards ─────────────────────────────────────────────────────────────────
log STEP "Step 0 — Checking services"

if ! cast block-number --rpc-url "$RPC_A" &>/dev/null; then
  log ERROR "Chain A not running at $RPC_A"; exit 1
fi
log OK "Chain A — block $(cast block-number --rpc-url $RPC_A)"

if ! cast block-number --rpc-url "$RPC_B" &>/dev/null; then
  log ERROR "Chain B not running at $RPC_B — start: bash tests/crosschain/chainb_anvil.sh"; exit 1
fi
log OK "Chain B — block $(cast block-number --rpc-url $RPC_B)"

check_backend

# ── 1. Load addresses ─────────────────────────────────────────────────────────
log STEP "Step 1 — Loading CC contract addresses"

ADDR_FILE="$LOG_DIR/.cc_addresses"
[ ! -f "$ADDR_FILE" ] && { log ERROR "$ADDR_FILE not found — run setup_cc.sh first"; exit 1; }

source "$ADDR_FILE"   # ESCROW_SRC_FACTORY, FACTORY, COSIGNER
log OK "Chain A EscrowSrcFactory  : $ESCROW_SRC_FACTORY"
log OK "Chain B EscrowDstFactory  : $FACTORY"
log OK "Cosigner                  : $COSIGNER"

# ── 2. Snapshot balances ──────────────────────────────────────────────────────
log STEP "Step 2 — Snapshotting balances (both fillers + swapper)"

declare -a WETH_A_BEFORE USDC_B_BEFORE
for i in 0 1; do
  WETH_A_BEFORE[$i]=$(cast call "$WETH" "balanceOf(address)(uint256)" "${FILLER_ADDRS[$i]}" --rpc-url "$RPC_A" | awk '{print $1}')
  USDC_B_BEFORE[$i]=$(cast call  "$USDC" "balanceOf(address)(uint256)" "${FILLER_ADDRS[$i]}" --rpc-url "$RPC_B" | awk '{print $1}')
  log INFO "${FILLER_NAMES[$i]} (${FILLER_ADDRS[$i]}) — WETH on A: ${WETH_A_BEFORE[$i]} | USDC on B: ${USDC_B_BEFORE[$i]}"
done

USDC_SWAPPER_B_BEFORE=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ACCOUNT0" --rpc-url "$RPC_B" | awk '{print $1}')
WETH_SWAPPER_A_BEFORE=$(cast call "$WETH" "balanceOf(address)(uint256)" "$ACCOUNT0" --rpc-url "$RPC_A" | awk '{print $1}')
log INFO "Swapper USDC on Chain B : $USDC_SWAPPER_B_BEFORE"
log INFO "Swapper WETH on Chain A : $WETH_SWAPPER_A_BEFORE"

# ── 3. Create order via backend ───────────────────────────────────────────────
log STEP "Step 3 — Creating cross-chain order (1 WETH → 2000 USDC, 2 of 4 slots will be filled)"

CURRENT_BLOCK_A=$(cast block-number --rpc-url "$RPC_A")
DEADLINE=$((CURRENT_BLOCK_A + 300))
T2_BUFFER=50

INPUT_AMOUNT="1000000000000000000"  # 1 WETH  → SlotLib: 4 slots
MIN_OUTPUT="2000000000"            # 2000 USDC (6 decimals) → 500 USDC per slot
NONCE="1"                          # bump if you re-run with the same swapper/amounts

ORDER_RESP=$(curl -sf -X POST "$BACKEND/cc/orders" \
  -H "Content-Type: application/json" \
  -d "{
    \"swapper\":     \"$ACCOUNT0\",
    \"inputToken\":  \"$WETH\",
    \"inputAmount\": \"$INPUT_AMOUNT\",
    \"outputToken\": \"$USDC\",
    \"minOutput\":   \"$MIN_OUTPUT\",
    \"deadline\":    $DEADLINE,
    \"nonce\":       \"$NONCE\",
    \"chainAId\":    31337,
    \"dstChainId\":  31338,
    \"t2Buffer\":    $T2_BUFFER
  }")

[ -z "$ORDER_RESP" ] && { log ERROR "Empty response from POST /cc/orders"; exit 1; }

ORDER_HASH=$(echo  "$ORDER_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['orderHash'])")
MERKLE_ROOT=$(echo "$ORDER_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['merkleRoot'])")
NUM_SLOTS=$(echo   "$ORDER_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['numSlots'])")
COSIGNER_SIG=$(echo "$ORDER_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['cosignerSig'])")

log OK "orderHash  : $ORDER_HASH"
log OK "merkleRoot : $MERKLE_ROOT"
log OK "numSlots   : $NUM_SLOTS"
log INFO "T1 = block $DEADLINE | T2 = block $((DEADLINE - T2_BUFFER))"

# ── 4. Fetch hashlocks + Merkle proofs for both fillers' slots ───────────────
log STEP "Step 4 — Fetching hashlock + proof for slots ${SLOTS[*]}"

ORDER_DETAIL=$(curl -sf "$BACKEND/cc/orders/$ORDER_HASH")

declare -a HASHLOCK PROOF_CAST
for i in 0 1; do
  slot=${SLOTS[$i]}
  HASHLOCK[$i]=$(echo "$ORDER_DETAIL" | python3 -c "import sys,json; print(json.load(sys.stdin)['slots'][$slot]['hashlock'])")
  PROOF_CAST[$i]=$(echo "$ORDER_DETAIL" | python3 -c "
import sys,json
proof = json.load(sys.stdin)['slots'][$slot]['proof']
print('[' + ','.join(proof) + ']')
")
  log OK "Slot $slot — H_$slot  : ${HASHLOCK[$i]}"
  log OK "Slot $slot — proof   : ${PROOF_CAST[$i]}"
done

# ── 4b. Compute the swapper's EIP-712 signature over the order hash ─────────
# In production this is wallet_signTypedData_v4 in the swapper's browser. Here
# we sign locally with PK0 (the swapper's own dev key), reproducing the exact
# "\x19\x01" || DOMAIN_SEPARATOR || orderHash digest the contract verifies.
log STEP "Step 4b — Computing swapper EIP-712 signature over orderHash"

DOMAIN_SEPARATOR=$(cast call "$ESCROW_SRC_FACTORY" "DOMAIN_SEPARATOR()(bytes32)" --rpc-url "$RPC_A")
SWAPPER_DIGEST=$(cast keccak "$(cast concat-hex 0x1901 "$DOMAIN_SEPARATOR" "$ORDER_HASH")")
SWAPPER_SIG=$(cast wallet sign --no-hash "$SWAPPER_DIGEST" --private-key "$PK0")
log OK "swapperSig: $SWAPPER_SIG"

# ── 5. Each filler calls EscrowSrcFactory.fillSlot() on Chain A ──────────────
# fillSlot() lazily registers the order on its FIRST call (verifying both
# swapperSig and cosignerSig), then on every call: checks the Merkle proof,
# deploys an EscrowSrc clone via CREATE2, and redirects slotAmount of the
# swapper's WETH into it via Permit2. msg.value is the filler's safety deposit.
log STEP "Step 5 — Chain A: each filler calls fillSlot() (deploys EscrowSrc clone + pulls WETH via Permit2)"

SAFETY_DEPOSIT="10000000000000000"  # 0.01 ETH per slot

declare -a ESCROW_ADDR_A
for i in 0 1; do
  slot=${SLOTS[$i]}
  name=${FILLER_NAMES[$i]}
  pk=${FILLER_PKS[$i]}

  run_cmd "$name: fillSlot(info, swapperSig, cosignerSig, slot=$slot, H_$slot, proof)" \
    cast send "$ESCROW_SRC_FACTORY" \
      "fillSlot((address,address,uint256,address,uint256,uint256,uint256,bytes32,uint8),bytes,bytes,uint8,bytes32,bytes32[])" \
      "($ACCOUNT0,$WETH,$INPUT_AMOUNT,$USDC,$MIN_OUTPUT,$DEADLINE,$NONCE,$MERKLE_ROOT,$NUM_SLOTS)" \
      "$SWAPPER_SIG" "$COSIGNER_SIG" "$slot" "${HASHLOCK[$i]}" "${PROOF_CAST[$i]}" \
      --value "$SAFETY_DEPOSIT" --private-key "$pk" --rpc-url "$RPC_A"

  ESCROW_ADDR_A[$i]=$(cast call "$ESCROW_SRC_FACTORY" "computeAddress(bytes32,uint8)(address)" "$ORDER_HASH" "$slot" --rpc-url "$RPC_A")
  log OK "$name — EscrowSrc clone deployed at ${ESCROW_ADDR_A[$i]} (slot $slot) on Chain A"
done

# ── 6. Both fillers fill their slot via EscrowDstFactory on Chain B ──────────
log STEP "Step 6 — Chain B: each filler deploys its own escrow clone (no approve needed)"

SLOT_AMOUNT=$(python3 -c "print($MIN_OUTPUT // $NUM_SLOTS)")   # 500 USDC

CURRENT_BLOCK_B=$(cast block-number --rpc-url "$RPC_B")
T2_EXPIRY=$((CURRENT_BLOCK_B + DEADLINE - CURRENT_BLOCK_A - T2_BUFFER))
log INFO "Slot amount: $SLOT_AMOUNT USDC | T2 expiry (Chain B block): $T2_EXPIRY"

declare -a ESCROW_ADDR
for i in 0 1; do
  slot=${SLOTS[$i]}
  name=${FILLER_NAMES[$i]}
  addr=${FILLER_ADDRS[$i]}
  pk=${FILLER_PKS[$i]}
  H=${HASHLOCK[$i]}

  # Step 6a: compute the clone address (deterministic from H_i + filler address —
  # different hashlock AND different filler per slot ⇒ no collision between the two)
  ESCROW_ADDR[$i]=$(cast call "$FACTORY" \
    "computeAddress(bytes32,address)(address)" \
    "$H" "$addr" \
    --rpc-url "$RPC_B")
  log OK "$name — precomputed escrow address (slot $slot): ${ESCROW_ADDR[$i]}"

  # Step 6b: transfer USDC directly to the escrow address (no approve!)
  run_cmd "$name: USDC.transfer(escrowAddr, $SLOT_AMOUNT) — fund clone for slot $slot" \
    cast send "$USDC" "transfer(address,uint256)" \
      "${ESCROW_ADDR[$i]}" "$SLOT_AMOUNT" \
      --private-key "$pk" --rpc-url "$RPC_B"

  ESCROW_USDC=$(cast call "$USDC" "balanceOf(address)(uint256)" "${ESCROW_ADDR[$i]}" --rpc-url "$RPC_B")
  log OK "$name — escrow holds $ESCROW_USDC USDC (before deployment)"

  # Step 6c: deploy the clone — initialize() verifies balance, emits EscrowCreated
  run_cmd "$name: EscrowDstFactory.deploy() — deploy + initialize clone for slot $slot" \
    cast send "$FACTORY" \
      "deploy(bytes32,address,address,uint256,uint256)" \
      "$H" "$ACCOUNT0" "$USDC" "$SLOT_AMOUNT" "$T2_EXPIRY" \
      --private-key "$pk" --rpc-url "$RPC_B"

  log OK "$name — EscrowDst clone deployed at ${ESCROW_ADDR[$i]} (slot $slot) on Chain B"
done

# ── 7. Mine Chain B blocks for confirmation ───────────────────────────────────
log STEP "Step 7 — Mining Chain B blocks for confirmation"
for i in 1 2 3; do
  cast rpc anvil_mine 1 --rpc-url "$RPC_B" >> "$LOG_FILE" 2>&1
  log INFO "Mined block on Chain B — now at $(cast block-number --rpc-url $RPC_B)"
done

# ── 8. Wait for backend chainBWatcher to claim from BOTH escrows ──────────────
log STEP "Step 8 — Waiting for backend to claim from both EscrowDst clones"
log INFO "Watcher listens for EscrowCreated, re-derives S_i, calls escrow.claim(S_i) for each"

MAX_WAIT=120
WAITED=0
CLAIMED=false

while [ $WAITED -lt $MAX_WAIT ]; do
  ALL_CLAIMED=true
  POLL_DETAIL=$(curl -sf "$BACKEND/cc/orders/$ORDER_HASH" 2>/dev/null)

  for i in 0 1; do
    slot=${SLOTS[$i]}
    SLOT_STATUS=$(echo "$POLL_DETAIL" | python3 -c "
import sys,json
d = json.load(sys.stdin)
slots = d.get('slots',[])
print(slots[$slot].get('status','unknown') if len(slots) > $slot else 'unknown')
" 2>/dev/null || echo "unknown")

    log INFO "${FILLER_NAMES[$i]} — slot $slot status: $SLOT_STATUS  (${WAITED}s elapsed)"
    [ "$SLOT_STATUS" != "claimed" ] && ALL_CLAIMED=false
  done

  if [ "$ALL_CLAIMED" = "true" ]; then
    CLAIMED=true
    log OK "Both slots claimed by backend!"
    break
  fi

  cast rpc anvil_mine 1 --rpc-url "$RPC_B" >> "$LOG_FILE" 2>&1
  sleep 3
  WAITED=$((WAITED + 3))
done

if [ "$CLAIMED" != "true" ]; then
  log ERROR "Timed out after ${MAX_WAIT}s. Was backend restarted after setup_cc.sh?"
  log WARN  "Check backend logs for 'EscrowCreated' events from $RPC_B"
  exit 1
fi

# ── 9. Read S_i from each escrow's Claimed event on Chain B ──────────────────
log STEP "Step 9 — Reading S_i from each escrow's Claimed event on Chain B"
log INFO "event Claimed(address indexed claimer, bytes32 secret) — data field = S_i (now public)"

declare -a SECRET
for i in 0 1; do
  slot=${SLOTS[$i]}
  escrow=${ESCROW_ADDR[$i]}

  SECRET[$i]=$(python3 << PYEOF
import urllib.request, json, subprocess

escrow = "$escrow"
from_block = hex($CURRENT_BLOCK_B)

# topic0 = keccak256("Claimed(address,bytes32)")
topic0 = subprocess.check_output(
    ["cast", "keccak", "Claimed(address,bytes32)"],
    text=True).strip()
if not topic0.startswith("0x"):
    topic0 = "0x" + topic0

req = urllib.request.Request(
    "http://127.0.0.1:8546",
    data=json.dumps({
        "jsonrpc": "2.0", "method": "eth_getLogs", "id": 1,
        "params": [{"address": escrow, "topics": [topic0], "fromBlock": from_block, "toBlock": "latest"}]
    }).encode(),
    headers={"Content-Type": "application/json"}
)
resp = json.loads(urllib.request.urlopen(req).read())
logs = resp.get("result", [])
if not logs:
    print("ERROR:no_claimed_event")
    exit(1)
# data = bytes32 secret (non-indexed)
print(logs[-1]["data"])
PYEOF
)

  if [[ "${SECRET[$i]}" == ERROR* ]] || [ -z "${SECRET[$i]}" ]; then
    log ERROR "Could not read S_$slot from Claimed event: ${SECRET[$i]}"; exit 1
  fi
  log OK "S_$slot (public on Chain B) = ${SECRET[$i]}"
done

# ── 10. Each filler withdraws from its EscrowSrc clone on Chain A ────────────
# No Merkle proof needed here — (hashlock, slotIndex) was already verified
# against merkleRoot inside fillSlot(). withdraw() just checks
# keccak256(secret) == hashlock and pays out the WETH amount + safety deposit.
log STEP "Step 10 — Chain A: each filler withdraws WETH + safety deposit using its own secret"

for i in 0 1; do
  slot=${SLOTS[$i]}
  name=${FILLER_NAMES[$i]}
  pk=${FILLER_PKS[$i]}

  run_cmd "$name: EscrowSrc(${ESCROW_ADDR_A[$i]}).withdraw(S_$slot)" \
    cast send "${ESCROW_ADDR_A[$i]}" \
      "withdraw(bytes32)" \
      "${SECRET[$i]}" \
      --private-key "$pk" --rpc-url "$RPC_A"
done

# ── 11. Verify final balances on both chains ──────────────────────────────────
log STEP "Step 11 — Verifying final balances"

declare -a WETH_A_AFTER USDC_B_AFTER WETH_GAINED USDC_SPENT ESCROW_STATUS_A
for i in 0 1; do
  WETH_A_AFTER[$i]=$(cast call "$WETH" "balanceOf(address)(uint256)" "${FILLER_ADDRS[$i]}" --rpc-url "$RPC_A" | awk '{print $1}')
  USDC_B_AFTER[$i]=$(cast call  "$USDC" "balanceOf(address)(uint256)" "${FILLER_ADDRS[$i]}" --rpc-url "$RPC_B" | awk '{print $1}')
  WETH_GAINED[$i]=$(python3 -c "print(${WETH_A_AFTER[$i]} - ${WETH_A_BEFORE[$i]})")
  USDC_SPENT[$i]=$(python3  -c "print(${USDC_B_BEFORE[$i]} - ${USDC_B_AFTER[$i]})")
  ESCROW_STATUS_A[$i]=$(cast call "${ESCROW_ADDR_A[$i]}" "status()(string)" --rpc-url "$RPC_A" | tr -d '"')
done

USDC_SWAPPER_B_AFTER=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ACCOUNT0" --rpc-url "$RPC_B" | awk '{print $1}')
WETH_SWAPPER_A_AFTER=$(cast call "$WETH" "balanceOf(address)(uint256)" "$ACCOUNT0" --rpc-url "$RPC_A" | awk '{print $1}')

USDC_GAINED=$(python3 -c "print($USDC_SWAPPER_B_AFTER - $USDC_SWAPPER_B_BEFORE)")
WETH_SWAPPER_SPENT=$(python3 -c "print($WETH_SWAPPER_A_BEFORE - $WETH_SWAPPER_A_AFTER)")
SLOT_WETH=$(python3   -c "print($INPUT_AMOUNT // $NUM_SLOTS)")

log RAW ""
log RAW "  ╔══════════════════════════════════════════════════════════════════╗"
log RAW "  ║  Cross-Chain Swap Results — 2 fillers, slots ${SLOTS[0]} & ${SLOTS[1]} of $NUM_SLOTS                ║"
log RAW "  ╠══════════════════════════════════════════════════════════════════╣"
for i in 0 1; do
  log RAW "  ║  Chain A │ ${FILLER_NAMES[$i]} WETH : ${WETH_A_BEFORE[$i]} → ${WETH_A_AFTER[$i]}"
done
log RAW "  ║  Chain A │ Swapper  WETH  : $WETH_SWAPPER_A_BEFORE → $WETH_SWAPPER_A_AFTER"
log RAW "  ╠══════════════════════════════════════════════════════════════════╣"
log RAW "  ║  Chain B │ Swapper  USDC  : $USDC_SWAPPER_B_BEFORE → $USDC_SWAPPER_B_AFTER"
for i in 0 1; do
  log RAW "  ║  Chain B │ ${FILLER_NAMES[$i]} USDC : ${USDC_B_BEFORE[$i]} → ${USDC_B_AFTER[$i]}"
done
log RAW "  ╚══════════════════════════════════════════════════════════════════╝"
log RAW ""

PASS=true

for i in 0 1; do
  name=${FILLER_NAMES[$i]}

  if python3 -c "exit(0 if ${WETH_A_AFTER[$i]} > ${WETH_A_BEFORE[$i]} else 1)"; then
    log OK "✔ $name gained ${WETH_GAINED[$i]} WETH on Chain A (expected ~$SLOT_WETH)"
  else
    log ERROR "✖ $name WETH on Chain A did not increase"; PASS=false
  fi

  if python3 -c "exit(0 if ${USDC_B_BEFORE[$i]} > ${USDC_B_AFTER[$i]} else 1)"; then
    log OK "✔ $name spent ${USDC_SPENT[$i]} USDC on Chain B (locked in escrow clone)"
  else
    log ERROR "✖ $name USDC on Chain B did not decrease"; PASS=false
  fi

  if [ "${ESCROW_STATUS_A[$i]}" = "withdrawn" ]; then
    log OK "✔ $name's EscrowSrc clone (slot ${SLOTS[$i]}) status = withdrawn (safety deposit returned)"
  else
    log ERROR "✖ $name's EscrowSrc clone (slot ${SLOTS[$i]}) status = ${ESCROW_STATUS_A[$i]} (expected withdrawn)"; PASS=false
  fi
done

if python3 -c "exit(0 if $USDC_SWAPPER_B_AFTER > $USDC_SWAPPER_B_BEFORE else 1)"; then
  log OK "✔ Swapper gained $USDC_GAINED USDC on Chain B (both escrow.claim() calls sent it)"
else
  log ERROR "✖ Swapper USDC on Chain B did not increase"; PASS=false
fi

if python3 -c "exit(0 if $WETH_SWAPPER_A_AFTER < $WETH_SWAPPER_A_BEFORE else 1)"; then
  log OK "✔ Swapper spent $WETH_SWAPPER_SPENT WETH on Chain A (pulled via Permit2 into both EscrowSrc clones)"
else
  log ERROR "✖ Swapper WETH on Chain A did not decrease"; PASS=false
fi

[ "$PASS" != "true" ] && { log ERROR "Balance checks failed"; exit 1; }

log STEP "ALL CHECKS PASSED"
log RAW ""
log RAW "  EscrowSrc/EscrowDst clone flow confirmed across two Anvil instances with 2 concurrent fillers:"
log RAW ""
log RAW "  Chain A (port 8545):"
for i in 0 1; do
  log RAW "    ${FILLER_NAMES[$i]} fillSlot()'d slot ${SLOTS[$i]} → EscrowSrc ${ESCROW_ADDR_A[$i]} → withdrew ${WETH_GAINED[$i]} WETH + safety deposit"
done
log RAW ""
log RAW "  Chain B (port 8546):"
for i in 0 1; do
  log RAW "    ${FILLER_NAMES[$i]} deployed EscrowDst clone at ${ESCROW_ADDR[$i]}"
done
log RAW "    backend claimed both clones → revealed S_${SLOTS[0]}, S_${SLOTS[1]} → swapper received $USDC_GAINED USDC total"
log RAW ""
log RAW "  $((NUM_SLOTS - 2)) slot(s) remain — other fillers can fill them the same way"
log RAW "  Log: $LOG_FILE"
