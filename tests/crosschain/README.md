# Cross-Chain Swap Test

End-to-end test across **two separate Anvil instances** using the **EscrowSrc / EscrowDst clone
pattern** — one isolated escrow contract per filler slot fill, on EACH chain, no shared state. The
E2E run exercises **two concurrent fillers** (`Filler A` → slot 0, `Filler B` → slot 1) filling the
same order.

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

Finally, run the E2E test (can be repeated — bump the `NONCE` variable near the top of
`run_cc.sh` if you see "slot already filled" or "invalid merkle proof" from a stale order hash):

```bash
bash tests/crosschain/run_cc.sh
```

Watch for `ALL CHECKS PASSED` at the end — it confirms both `Filler A` and `Filler B` gained
WETH (+ their safety deposit back) on Chain A, and the swapper received USDC on Chain B from
both EscrowDst clones.

> **Note on re-runs:** the order hash is derived from `(swapper, inputToken, inputAmount,
> outputToken, minOutput, deadline, nonce, merkleRoot, numSlots)`. Re-running the script with
> the same `NONCE` (and the script's auto-computed `deadline`, which only changes if the chain's
> block number changed) reproduces the *same* `orderHash` — `fillSlot()` will then revert with
> `"slot already filled"` for slots 0/1 since they're already filled from the previous run.
> Bump `NONCE` between runs.

## Architecture

```
Chain A  (port 8545, chainId 31337)        Chain B  (port 8546, chainId 31338)
────────────────────────────────           ─────────────────────────────────────
EscrowSrcFactory                           EscrowDstFactory
  fillSlot()      ← filler (deploys clone,   deploy()        ← filler (deploys clone)
                     pulls WETH via Permit2)  computeAddress()← filler (off-chain)
  computeAddress()← filler (off-chain)

EscrowSrc (one clone per filled slot)      EscrowDst (one clone per fill)
  withdraw() ← anyone, once S_i is public     claim()  ← backend watcher (auto)
  cancel()   ← anyone, after T1 (no claim)    refund() ← filler (after T2, no claim)

Backend (chainBWatcher)
  watches Chain B factory for EscrowCreated events
  re-derives S_i from stored rootSecret (never stored in DB)
  calls EscrowDst(escrowAddr).claim(S_i) → emits Claimed(claimer, S_i)
```

## Why escrow clones on BOTH chains instead of a shared HTLC?

| | Shared HTLC (old `CrossChainReactor`) | EscrowSrc / EscrowDst clones (current) |
|--|--|--|
| Isolation | All fills share one contract | Each fill = its own contract, on **both** chains |
| Bug impact | One bug drains all fillers | One clone fails, others unaffected |
| Swapper authorization | `inputAmount` pulled into the reactor up front via `createOrder()` | One-time Permit2 allowance only — `fillSlot()` pulls just `slotAmount`, lazily, per filled slot |
| Unfilled slots | Swapper's tokens for those slots sat in the reactor anyway | Swapper's tokens for unfilled slots never leave their wallet |
| Filler collateral | None | 0.01 ETH safety deposit per slot — refunded by `withdraw()`, forfeited to whoever calls `cancel()` after expiry |
| Auditability | One mapping, hard to inspect | Each clone is self-contained; `status()` reports `active` / `withdrawn` / `cancelled` / `expired` |

## Token flow (per slot, e.g. 0.25 WETH ↔ 500 USDC)

```
Swapper (Chain A)                                  Filler
─────────────────                                  ──────
  -0.25 WETH ← fillSlot() pulls via Permit2          Chain A: +0.25 WETH + 0.01 ETH ← EscrowSrc.withdraw()
                                                      Chain B: -500 USDC → EscrowDst clone
  +500 USDC  ← EscrowDst.claim() (backend)
```

## Secret hierarchy (never stored — re-derived on demand)

```
rootSecret  (stored per swapper in backend DB)
  └─ masterSecret = keccak256(rootSecret ∥ orderParams)
       └─ S_i = keccak256(masterSecret ∥ i)
            └─ H_i = keccak256(S_i)  ← hashlock in EscrowSrc + EscrowDst clones + Merkle leaf
```

When backend calls `escrow.claim(S_i)` on Chain B, `S_i` is emitted publicly in the `Claimed`
event. The filler reads it from Chain B and calls `EscrowSrc(escrow).withdraw(S_i)` on Chain A —
**anyone** may call `withdraw()`, since funds always go to the `filler` address recorded at
`fillSlot()` time, not to `msg.sender`.

## Filler flow detail

### Chain A — `fillSlot()` then `withdraw()` (one-time Permit2 setup, no per-slot approve)

```bash
# 0. Swapper one-time setup (off-chain UX, done once ever):
ERC20.approve(Permit2, WETH, type(uint256).max)
Permit2.approve(EscrowSrcFactory, WETH, inputAmount, expiration)

# 0b. Swapper signs the order off-chain (EIP-712 over orderHash) → swapperSig
#     (run_cc.sh / ccFill.ts sign locally with the swapper's well-known Anvil
#     dev key — see "swapperSig" below)

# 1. Filler calls fillSlot() with msg.value = 0.01 ETH safety deposit.
#    On the FIRST call for this order: verifies swapperSig + cosignerSig,
#    stores OrderState. On EVERY call: verifies (H_i, slotIndex) against
#    merkleRoot, deploys an EscrowSrc clone via CREATE2, then redirects
#    slotAmount of WETH from swapper → clone via Permit2.
escrow = factory.fillSlot(info, swapperSig, cosignerSig, i, H_i, proof) { value: 0.01 ETH }
# ↑ emits SlotFilled(orderHash, i, filler, escrow, H_i, slotAmount, 0.01 ETH)

# 2. Once S_i is public (revealed on Chain B), ANYONE calls withdraw() —
#    slotAmount WETH + the 0.01 ETH safety deposit are sent to `filler`.
EscrowSrc(escrow).withdraw(S_i)
```

`swapperSig` is `ECDSA.recover`-able from `keccak256("\x19\x01" ‖ DOMAIN_SEPARATOR ‖ orderHash)`,
where `DOMAIN_SEPARATOR = factory.DOMAIN_SEPARATOR()`. In production this is
`wallet_signTypedData_v4` in the swapper's browser; the dev scripts sign locally with Anvil
Account 0's well-known private key.

### Chain B — `EscrowDst` (unchanged, still no approve step)

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
| `deadline` (T1) | Chain A block + 300 | Order expiry. Also each `EscrowSrc` clone's `expiry` — after T1, anyone may call `cancel()`: WETH refunded to swapper, 0.01 ETH safety deposit paid to the caller |
| `T2 expiry` | T1 − 50 blocks | Each `EscrowDst` clone's expiry — filler can `refund()` if the backend never calls `claim()` |

**Invariant: T2 < T1.** The filler's `EscrowDst` clone becomes refundable on Chain B *before*
their `EscrowSrc` clone becomes cancellable on Chain A — so a filler who funded Chain B but
never got `withdraw()`'d can always recover their USDC first.

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
| 3a | **Chain A** | Deploy `EscrowSrc` impl + `EscrowSrcFactory` (Permit2 + cosigner) |
| 3b | **Chain B** | Deploy `EscrowDst` impl + `EscrowDstFactory` |
| 4 | — | Write `CROSS_CHAIN_REACTOR` (= EscrowSrcFactory), `CHAIN_B_FACTORY`, `CHAIN_B_RPC` to `backend/.env`; write `ESCROW_SRC_FACTORY` / `CHAIN_B_RPC` / `CHAIN_B_FACTORY` to both filler `.env` files |
| 5 | **Chain A** | Wrap 5 ETH → WETH for swapper, `WETH.approve(Permit2, max)`, then `Permit2.approve(EscrowSrcFactory, WETH, ...)` |
| 6 | **Chain B** | Fund **Filler A** and **Filler B** with 10 000 USDC each (**no approval needed**) |
| 7 | **Chain B** | Fund cosigner with 1 ETH (gas for `claim()` — needs to claim 2 escrows now) |

**After setup: restart backend** so `chainBWatcher` loads `CHAIN_B_FACTORY`, and restart any
running filler dev servers so they pick up `ESCROW_SRC_FACTORY`.

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
| 2 | — | — | Snapshot balances (both fillers' WETH/A + USDC/B, swapper WETH/A + USDC/B) |
| 3 | — | swapper | `POST /cc/orders` → backend builds Merkle tree + cosigns (4 slots) |
| 4 | — | — | Fetch hashlock + Merkle proof for **slots 0 and 1** |
| 4b | — | swapper | Sign `keccak256("\x19\x01" ‖ DOMAIN_SEPARATOR ‖ orderHash)` with `PK0` → `swapperSig` |
| 5 | **Chain A** | A & B | each calls `factory.fillSlot(info, swapperSig, cosignerSig, slot, H_i, proof)` with 0.01 ETH safety deposit — deploys its own `EscrowSrc` clone and pulls its WETH slot share via Permit2 |
| 6a | **Chain B** | A & B | each calls `factory.computeAddress(H_i, filler)` → its own escrowAddr |
| 6b | **Chain B** | A & B | each calls `USDC.transfer(escrowAddr, 500)` — funds its own future clone |
| 6c | **Chain B** | A & B | each calls `factory.deploy(H_i, swapper, USDC, 500, T2)` — deploys its own clone |
| 7 | **Chain B** | — | Mine 3 blocks for confirmation |
| 8 | **Chain B** | backend | `chainBWatcher` detects both `EscrowCreated` events, re-derives S_0 & S_1, calls `escrow.claim(S_i)` on each |
| 9 | **Chain B** | — | Read S_0 from clone A's `Claimed` event, S_1 from clone B's |
| 10 | **Chain A** | A & B | each calls `EscrowSrc(escrowA).withdraw(S_i)` — receives WETH + safety deposit back |
| 11 | both | — | Assert both fillers' WETH ↑ and `EscrowSrc` clones report `status()=="withdrawn"` on Chain A; swapper WETH ↓ and USDC ↑ (×2); both fillers' USDC ↓ on Chain B |

Each Chain A escrow address is `computeAddress(orderHash, slotIndex)` — keyed on the order hash
and slot index — and each Chain B escrow address is `computeAddress(H_i, fillerAddr)` — keyed
on the slot's hashlock and the filler's own address. Different keying schemes, same guarantee:
the two fillers' clones can never collide on either chain, even though they're deployed in the
same block range on the same factory.

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
    ├── .cc_addresses    ← ESCROW_SRC_FACTORY, FACTORY, COSIGNER
    └── *.log

contract/src/crosschain/
├── EscrowSrc.sol           ← Chain A — clone template, one per filled slot (Permit2-funded, safety deposit)
├── EscrowSrcFactory.sol    ← Chain A — verifies swapperSig+cosignerSig & Merkle proof, deploys EscrowSrc clones
├── EscrowDst.sol           ← Chain B — clone template, one per fill
├── EscrowDstFactory.sol    ← Chain B — deploys EscrowDst clones via CREATE2
└── libs/SlotLib.sol

contract/src/interfaces/
└── IPermit2.sol            ← minimal Permit2 AllowanceTransfer.transferFrom interface

contract/script/
└── DeployCrossChain.s.sol  ← runChainA() / runChainB() entry points

backend/src/
├── chain/chainBWatcher.ts        ← listens to factory EscrowCreated, claims from clone
└── services/crosschainService.ts ← DB: escrow_addr column, builds Merkle tree, signs cosignerSig

filler/{CoWFiller,WhaleFiller}/src/
├── config.ts          ← ESCROW_SRC_FACTORY, CHAIN_B_RPC, CHAIN_B_FACTORY (written by setup_cc.sh)
├── contract/abis.ts   ← ESCROW_SRC_FACTORY_ABI, ESCROW_SRC_ABI, ESCROW_FACTORY_ABI, ESCROW_DST_ABI
└── fill/crossChainFill.ts ← crossChainFill() / crossChainClaim() — drives fillSlot() → Chain B → withdraw()
```

## backend/.env — what changed

```bash
# CROSS_CHAIN_REACTOR now holds the EscrowSrcFactory address (key name kept
# as-is — backend/src/routes/admin.ts still reads it for the admin UI's
# "crossChainReactor" display field).
CROSS_CHAIN_REACTOR=0x...   ← EscrowSrcFactory address on Chain A
CHAIN_B_FACTORY=0x...       ← EscrowDstFactory address on Chain B
```

---

## Troubleshooting

**`run_cc.sh` Step 8 times out**  
→ Backend was not restarted after `setup_cc.sh`. The watcher reads `CHAIN_B_FACTORY` at startup.  
→ Confirm the backend log shows `EscrowDstFactory: 0x...` on start, not the old HTLC address.  
→ With 2 fillers, the log now reports each slot's status separately each poll — check whether
  *one* slot is stuck on `locked` (its `EscrowCreated` wasn't picked up) or *both* are.

**`factory.deploy()` reverts with "underfunded"** (Chain B)  
→ The USDC transfer (step 6b) failed or went to the wrong address.  
→ Check: `cast call $USDC "balanceOf(address)(uint256)" $ESCROW_ADDR --rpc-url $RPC_B` before deploying.

**`fillSlot()` reverts with "invalid signature"**  
→ `swapperSig` or `cosignerSig` doesn't match `factory.DOMAIN_SEPARATOR()` for the *currently
  deployed* `EscrowSrcFactory` — usually because `setup_cc.sh` redeployed the factory (new
  address → new `DOMAIN_SEPARATOR`) but `cosignerSig` came from an order created against the
  old one. Re-run `POST /cc/orders` (step 3) after the latest `setup_cc.sh`.

**`fillSlot()` reverts with "invalid merkle proof"**  
→ Nonce mismatch / stale order. The `(H_i, slotIndex)` pair came from a different order than
  the `info` tuple sent to `fillSlot()`. Bump `NONCE` in `run_cc.sh` and re-run from step 3.

**`fillSlot()` reverts with "slot already filled"**  
→ Re-running the script with the same `(swapper, nonce, amounts, deadline)` reproduces the same
  `orderHash`, and slots 0/1 are already filled from a previous run. Bump `NONCE` in `run_cc.sh`.  
→ Could also mean two fillers targeted the *same* slot index — `run_cc.sh` assigns Filler A →
  slot 0 and Filler B → slot 1 (see the `SLOTS=(0 1)` array); if you change one, change the
  other too so they don't collide.

**`EscrowSrc.withdraw()` reverts with "expired"**  
→ `block.number > expiry` (T1, the order `deadline`). The script ran too slowly relative to the
  300-block deadline. Increase the deadline buffer (`CURRENT_BLOCK_A + 300`) in `run_cc.sh`, or
  re-run from step 3 with a fresh `NONCE`.

**Only 2 of 4 slots filled**  
→ Intentional — proves the full flow with 2 concurrent fillers (Account 1 → slot 0,
Account 2 → slot 1). For slots 2–3, repeat steps 4b–10 with the corresponding hashlock and
proof from `GET /cc/orders/:hash`, using another funded account as a third filler (remember to
fund it with USDC on Chain B in `setup_cc.sh` first — no approval needed on Chain B; on Chain A
it only needs ETH for gas + the safety deposit, since Permit2 already covers the whole
`inputAmount` for the swapper).
