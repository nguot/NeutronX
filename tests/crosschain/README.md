# Cross-Chain Swap Test

Watch out for concurrency/race bug (nounce)

End-to-end test across **two separate Anvil instances** using the **EscrowDst clone pattern** — one isolated escrow contract per filler fill, no shared state. The E2E run exercises **two concurrent fillers** (`Filler A` → slot 0, `Filler B` → slot 1) filling the same order.

## Quick start

Open 4 terminals (WSL), run one command in each, **in order**:

```bash
# Terminal 1 — Chain A (source / WETH chain)
bash tests/crosschain/chaina_anvil.sh

# Terminal 2 — Chain B (destination / USDC chain)
bash tests/crosschain/chainb_anvil.sh

# Terminal 3 — Backend
cd backend && npm start

# Terminal 4 — Deploy contracts + fund both fillers (run ONCE per session)
bash tests/crosschain/setup_cc.sh
```

Then, **restart the backend** (Ctrl-C in Terminal 3, then `cd backend && npm start` again) so
`chainBWatcher` picks up `CHAIN_B_FACTORY` from `setup_cc.sh`.

Finally, run the E2E test (can be repeated — bump the order `nonce` in `run_cc.sh` if you see
"invalid proof" from a stale order hash):

```bash
bash tests/crosschain/run_cc.sh
```

Watch for `ALL CHECKS PASSED` at the end — it confirms both `Filler A` and `Filler B` gained
WETH on Chain A and the swapper received USDC on Chain B from both escrow clones.

## Architecture

```
Chain A  (port 8545, chainId 31337)        Chain B  (port 8546, chainId 31338)
────────────────────────────────           ─────────────────────────────────────
CrossChainReactor                          EscrowDstFactory
  createOrder()  ← swapper locks WETH        deploy()       ← filler (deploys clone)
  claimSlot()    ← filler claims WETH        computeAddress()← filler (off-chain)

                                           EscrowDst (one clone per fill)
                                             claim()  ← backend watcher (auto)
                                             refund() ← filler (after T2, no claim)

Backend (chainBWatcher)
  watches Chain B factory for EscrowCreated events
  re-derives S_i from stored rootSecret (never stored in DB)
  calls EscrowDst(escrowAddr).claim(S_i) → emits Claimed(claimer, S_i)
```

## Why escrow clones instead of a shared HTLC?

| | Shared HTLC (old) | EscrowDst clone (current) |
|--|--|--|
| Isolation | All fills share one contract | Each fill = its own contract |
| Bug impact | One bug drains all fillers | One clone fails, others unaffected |
| ERC-20 approval | Required | **Not needed** — direct transfer |
| Gas per fill | ~165k (after approve) | ~220k (clone deploy, no approve tx) |
| Auditability | One mapping, hard to inspect | Each clone is self-contained |

## Token flow

```
Swapper (Chain A)                        Filler
─────────────────                        ──────
  -1 WETH locked → CrossChainReactor     Chain B: -500 USDC → EscrowDst clone
  +500 USDC received ← escrow.claim()   Chain A: +0.25 WETH ← claimSlot()
```

## Secret hierarchy (never stored — re-derived on demand)

```
rootSecret  (stored per swapper in backend DB)
  └─ masterSecret = keccak256(rootSecret ∥ orderParams)
       └─ S_i = keccak256(masterSecret ∥ i)
            └─ H_i = keccak256(S_i)  ← hashlock in EscrowDst clone + Merkle leaf
```

When backend calls `escrow.claim(S_i)`, S_i is emitted publicly in the `Claimed` event.
Filler reads it from Chain B, submits to `CrossChainReactor.claimSlot()` on Chain A.

## Filler flow detail (no approve step)

```bash
# 1. Compute clone address off-chain (deterministic from H_i + filler address)
escrowAddr = factory.computeAddress(H_i, fillerAddr)

# 2. Send output tokens directly to the future clone address
USDC.transfer(escrowAddr, amount)

# 3. Deploy the clone — initialize() verifies the balance it already holds
factory.deploy(H_i, swapper, USDC, amount, T2_expiry)
# ↑ emits EscrowCreated(escrowAddr, filler, H_i, ...)
```

## Timing safety

| Variable | Default | Meaning |
|----------|---------|---------|
| `deadline` (T1) | Chain A block + 300 | Swapper reclaims unclaimed slots after this |
| `T2 expiry` | T1 − 50 blocks | Filler can refund clone if no claim before T2 |

**Invariant: T2 < T1.** Filler can always refund on Chain B before swapper reclaims on Chain A.

---

## Setup (run once per session)

```bash
# Terminal 1 — Chain A
bash tests/crosschain/chaina_anvil.sh

# Terminal 2 — Chain B
bash tests/crosschain/chainb_anvil.sh

# Terminal 3 — Backend
cd backend && npm start

# Terminal 4 — Deploy + fund (run once)
bash tests/crosschain/setup_cc.sh
```

> Crosschain no longer reuses `tests/demo/v1_neutral_anvil.sh` — `chaina_anvil.sh`
> starts Chain A with the same fork block (so token addresses/balances match
> Chain B) but without the demo's `--block-time`, since the E2E script drives
> blocks itself via `cast send`. It also doesn't start/need the `WhaleFiller`
> / `CoWFiller` bots — `run_cc.sh` simulates **two independent fillers**
> directly with scripted `cast send` calls from two EOAs (`ACCOUNT1`, `ACCOUNT2`),
> each filling its own slot of the same order.

### What setup_cc.sh does

| Step | Chain | Action |
|------|-------|--------|
| 1 | — | Check Chain A, Chain B, backend |
| 2 | — | `POST /cc/session` → get cosigner address |
| 3a | **Chain A** | Deploy `CrossChainReactor` (Permit2 + cosigner) |
| 3b | **Chain B** | Deploy `EscrowDst` impl + `EscrowDstFactory` |
| 4 | — | Write `CHAIN_B_FACTORY` + `CHAIN_B_RPC` to `backend/.env` |
| 5 | **Chain A** | Wrap WETH for swapper, set Permit2 approvals |
| 6 | **Chain B** | Fund **Filler A** and **Filler B** with 10 000 USDC each (**no approval needed**) |
| 7 | **Chain B** | Fund cosigner with 1 ETH (gas for `claim()` — needs to claim 2 escrows now) |

**After setup: restart backend** so `chainBWatcher` loads `CHAIN_B_FACTORY`.

---

## Run the E2E test

```bash
bash tests/crosschain/run_cc.sh
```

### What run_cc.sh does

Two independent fillers — **Filler A** (Account 1, slot 0) and **Filler B**
(Account 2, slot 1) — fill two different slots of the *same* order
concurrently, end to end.

| Step | Chain | Actor | Action |
|------|-------|-------|--------|
| 0 | — | — | Check all services |
| 1 | — | — | Load addresses from `logs/.cc_addresses` |
| 2 | — | — | Snapshot balances (both fillers' WETH/A + USDC/B, swapper USDC/B) |
| 3 | — | swapper | `POST /cc/orders` → backend builds Merkle tree + cosigns (4 slots) |
| 4 | — | — | Fetch hashlock + Merkle proof for **slots 0 and 1** |
| 5 | **Chain A** | swapper | `CrossChainReactor.createOrder()` — locks 1 WETH via Permit2 |
| 5b | **Chain A** | A & B | each calls `registerFiller(orderHash, slot)` — reserves its own slot, prevents MEV |
| 6a | **Chain B** | A & B | each calls `factory.computeAddress(H_i, filler)` → its own escrowAddr |
| 6b | **Chain B** | A & B | each calls `USDC.transfer(escrowAddr, 500)` — funds its own future clone |
| 6c | **Chain B** | A & B | each calls `factory.deploy(H_i, swapper, USDC, 500, T2)` — deploys its own clone |
| 7 | **Chain B** | — | Mine 3 blocks for confirmation |
| 8 | **Chain B** | backend | `chainBWatcher` detects both `EscrowCreated` events, re-derives S_0 & S_1, calls `escrow.claim(S_i)` on each |
| 9 | **Chain B** | — | Read S_0 from clone A's `Claimed` event, S_1 from clone B's |
| 10 | **Chain A** | A & B | each calls `CrossChainReactor.claimSlot(orderHash, slot, S_i, proof)` with its own secret |
| 11 | both | — | Assert both fillers' WETH ↑ on Chain A; swapper USDC ↑ (×2) and both fillers' USDC ↓ on Chain B |

Because each escrow address is `computeAddress(H_i, fillerAddr)` — keyed on
*both* the slot's unique hashlock and the filler's own address — the two
clones can never collide, even though they're deployed in the same block
range on the same factory.

---

## Files

```
tests/crosschain/
├── README.md            ← this file
├── chaina_anvil.sh      ← starts Chain A Anvil (port 8545, chainId 31337)
├── chainb_anvil.sh      ← starts Chain B Anvil (port 8546, chainId 31338)
├── _lib_cc.sh           ← shared log/run_cmd/check_backend helpers (local copy of tests/demo/_lib.sh)
├── setup_cc.sh          ← deploy to both chains, fund accounts
├── run_cc.sh            ← full E2E test
└── logs/
    ├── .cc_addresses    ← CC_REACTOR, FACTORY, COSIGNER
    └── *.log

contract/src/crosschain/
├── CrossChainReactor.sol   ← Chain A — escrow + Merkle proof verification
├── EscrowDst.sol           ← Chain B — clone template (one per fill)
├── EscrowDstFactory.sol    ← Chain B — deploys EscrowDst clones via CREATE2
└── libs/SlotLib.sol

contract/script/
└── DeployCrossChain.s.sol  ← runChainA() / runChainB() entry points

backend/src/
├── chain/chainBWatcher.ts        ← listens to factory EscrowCreated, claims from clone
└── services/crosschainService.ts ← DB: escrow_addr column (was lock_id)
```

## backend/.env — what changed

```bash
# Removed
DEST_CHAIN_HTLC=0x...

# Added (one rename, everything else unchanged)
CHAIN_B_FACTORY=0x...    ← EscrowDstFactory address on Chain B
```

---

## Troubleshooting

**`run_cc.sh` Step 8 times out**  
→ Backend was not restarted after `setup_cc.sh`. The watcher reads `CHAIN_B_FACTORY` at startup.  
→ Confirm the backend log shows `EscrowDstFactory: 0x...` on start, not the old HTLC address.  
→ With 2 fillers, the log now reports each slot's status separately each poll — check whether
  *one* slot is stuck on `locked` (its `EscrowCreated` wasn't picked up) or *both* are.

**`factory.deploy()` reverts with "underfunded"**  
→ The USDC transfer (step 6b) failed or went to the wrong address.  
→ Check: `cast call $USDC "balanceOf(address)(uint256)" $ESCROW_ADDR --rpc-url $RPC_B` before deploying.

**`claimSlot()` reverts with "invalid proof"**  
→ Nonce mismatch. If you already ran the test with nonce `"1"`, change it to `"2"` in step 3 of `run_cc.sh`.

**Only 2 of 4 slots filled**  
→ Intentional — proves the full flow with 2 concurrent fillers (Account 1 → slot 0,
Account 2 → slot 1). For slots 2–3, repeat steps 5b–10 with the corresponding
hashlock from `GET /cc/orders/:hash`, using another funded account as a third filler
(remember to fund it with USDC on Chain B in `setup_cc.sh` first — no approval needed).

**`registerFiller` reverts with "slot already taken"**  
→ Two fillers tried to register the *same* slot index. `run_cc.sh` assigns Filler A → slot 0
and Filler B → slot 1 (see the `SLOTS=(0 1)` array) — if you change one, change the other too
so they don't collide.
