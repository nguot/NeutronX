# NeutronX contracts — a study & rebuild guide

A self-teaching map for the `contract/` folder. Two goals:

1. **Read it** — the right order to read the code *with its tests*, so each file makes sense
   before you open the next.
2. **Rebuild it** — an incremental from-scratch roadmap (M0 → M7). Re-implementing each piece
   yourself, test-first, is the fastest way to *deeply* understand it. You already have the
   reference implementation to check against.

Everything here points at real files and functions in this repo.

> **Mới bắt đầu / sát ngày bảo vệ?** Nhảy thẳng tới mục **★ BẮT ĐẦU TỪ ĐÂY** bên dưới — nó gộp thứ tự đọc (§2) và rebuild (§5) thành một lộ trình dẫn dắt có time-box, kèm đường tắt khi thiếu thời gian.

---

## 0. The one-paragraph mental model

NeutronX is an **intent-based DEX aggregator** in the family of UniswapX / CoW Protocol /
1inch Fusion(+). A **swapper** signs an *intent* off-chain ("sell X input for ≥ Y output"),
not a transaction. Independent **fillers** compete to execute it on-chain. To keep fillers
honest, a filler must **stake ETH collateral** (`FillAuction`) before it may fill; behave well
and the stake is refunded, misbehave (snipe a tiny chunk, reserve-then-vanish) and it's
**slashed/forfeited**. Orders fill in **partial chunks** along a **Dutch-auction decay price**
(`PartialFillReactor` + `DecayCursorLib`). If no filler completes in time, a **fallback** swaps
the remainder on Uniswap (`FallbackExecutor`). A separate **cross-chain** path
(`crosschain/`) settles swaps across two chains with **hash-time-locked escrows** (HTLC) and a
Merkle tree of per-slot secrets, à la Fusion+.

Four actors recur everywhere — keep them straight:
- **swapper** — signs the order, sells the input token, must be paid ≥ their floor.
- **filler** — executes chunks, pays the output token, stakes collateral.
- **cosigner** — a backend key that signs/authorizes orders (the trust anchor; see finding L-1).
- **treasury / slasher** — receive forfeited / slashed collateral.

---

## ★ BẮT ĐẦU TỪ ĐÂY — vòng lặp đọc → code lại (lộ trình dẫn dắt)

Mục tiêu: hiểu *sâu* để bảo vệ được và code thêm được tại chỗ. Cách nhanh nhất KHÔNG phải đọc tuần tự hết, mà là **vòng lặp 4 bước cho TỪNG mảnh**:

> **(1) Đọc cặp** `src/X.sol` + `test/X.t.sol` (test là spec chạy được) → **(2) Trace** hàm chính từng dòng theo CHECKS→EFFECTS→INTERACTIONS → **(3) Re-code test-first** ở repo nháp (`forge init`), viết test trước rồi implement tới xanh → **(4) Diff** với bản gốc — *chỗ bạn thiếu chính là bài học.*

Vì sao re-code chứ không chỉ đọc: đọc cho **nhận diện** ("nhìn đúng đấy"), re-code cho **tái tạo** ("tự viết lại được"). Live-code lúc bảo vệ cần tái tạo. Đừng nhìn bản gốc tới khi test xanh hoặc bí thật.

### Chẩn đoán trước (15 phút, làm NGAY)
Trả lời cold 6 câu ở **§7 Self-quiz**. Câu nào lắp bắp = đúng mảnh cần học. Đây là la bàn — học theo lỗ hổng, không học dàn trải.

### Lộ trình gộp (đọc §2 ⊕ rebuild §5), theo chặng có time-box
| Chặng | Đọc (§2) | Re-code (§5) | Thời gian | "Aha" cốt lõi |
|---|---|---|---|---|
| **A. Nền** | RemainingLib, DecayCursorLib | **M1 + M2** | ~nửa ngày | giá giảm tuyến tính clamp ≥0; "0 remaining ≠ chưa chạm" |
| **B. Trái tim** | PartialFillReactor → tập trung `executePartialChunk` | **M3 → M4** | ~1 ngày | EIP-712 digest; vì sao giá phải nằm TRONG struct ký (C-1); 2 tầng floor |
| **C. Kinh tế** | FillAuction + DynamicStakeLib | **M5** | ~1 ngày | 3 cờ terminal, "settle đúng một lần"; thua-đua ≠ slashable (H-1/H-2) |
| **D. Xuyên chuỗi** | EscrowDst→Src→Factories + `crosschain.md` | **M7 (MiniHTLC)** | ~1 ngày | atomic ⇔ T2<T1 + chung filler |

### Đường tắt nếu SÁT bảo vệ (không đủ thời gian rebuild hết)
1. **Chẩn đoán §7** → khoanh lỗ hổng.
2. Đọc cold **§3 (life of an order)** + **§4 (bảng bất biến)** — đây là bộ xương trả lời mọi câu phản biện.
3. Re-code **chỉ 2 mảnh keystone**: **M1 DecayCursorLib** (~30p) + **M3 minimal reactor** (~1-2h). Đủ cơ bắp live-code cho ask khả năng cao nhất (Pausable/fee đụng reactor, contract mới đụng HTLC/decay).
4. Mỗi finding sẽ bị hỏi (3.1/3.2/3.3, C-1, C-2) → mở test ghim nó, đọc 1 lần.

→ Phần còn lại của tài liệu (§1-§7) là chi tiết cho từng bước trên. Bắt đầu bằng §7, rồi theo bảng chặng.

---

## 1. File map (what each file is, one line each)

```
src/
  PartialFillReactor.sol     ← the heart: validate intent, price the chunk, move funds, settle stake
  FillAuction.sol            ← staking economics: register / slash / release / refund / withdraw
  FallbackExecutor.sol       ← last resort: swap the remaining input on Uniswap V3
  interfaces/
    IFillAuction.sol         ← reactor → auction surface
    IPermit2.sol             ← how the swapper's input is pulled (no per-tx approval)
    IUniswapV3.sol           ← minimal factory + pool.observe() for the TWAP oracle
  libs/
    DecayCursorLib.sol       ← Dutch-auction price: startPrice − decay·blocks (clamped ≥ 0)
    DynamicStakeLib.sol      ← collateral & refund math + toEthNotional() TWAP pricing
    RemainingLib.sol         ← packs "remaining input" with new/partial/filled sentinels
    ScaledOutputLib.sol      ← proportional output scaling + last-fill dust
  crosschain/
    EscrowSrc.sol            ← chain-A HTLC: holds swapper input, withdraw(secret) / cancel()
    EscrowDst.sol            ← chain-B HTLC: holds filler output, claim(secret) / refund()
    EscrowSrcFactory.sol     ← deploys+funds Src clones per slot, verifies 2 sigs + Merkle proof
    EscrowDstFactory.sol     ← deploys+funds Dst clones per slot
    libs/SlotLib.sol         ← slot/power-of-two helpers
test/                        ← mirrors src/ one-to-one; read each test next to its contract
```

**Rule of thumb:** every `src/X.sol` has a `test/X.t.sol` (or a library test under
`test/libs/`). Read them as pairs — the test is the executable spec for the contract.

---

## 2. Reading order (code ↔ test, bottom-up)

Read leaves before the trees: the libraries are small and pure, and the core contracts are
just orchestration on top of them. For each step: read the contract, then *immediately* read
its test, then answer the "ask yourself" before moving on.

### Step 1 — the pure libraries (`src/libs/` + `test/libs/`)
Order: `RemainingLib` → `DecayCursorLib` → `ScaledOutputLib` → `DynamicStakeLib`.
- **RemainingLib** — why pack a sentinel for "new order" vs "fully filled" instead of a plain
  `uint256`? (Ask: how does the reactor tell "never touched" from "filled to exactly 0"?)
- **DecayCursorLib** — `init` / `getCurrentPrice` / `reset`. (Ask: what does `reset` re-anchor,
  and why must price clamp at 0 rather than underflow?)
- **DynamicStakeLib** — the two halves: bucketing (`getOrderSizeBucketETH`, `getFillRatioBucket`,
  `getTimeBucket`) and the money (`computeCollateral`, `computeRefund`, `toEthNotional`).
  (Ask: why is collateral sized off an **ETH notional** and not raw token units? — that's
  finding D-1. Why does `toEthNotional` short-circuit for WETH and for `factory == 0`?)

### Step 2 — `FillAuction.sol` + `test/FillAuction.t.sol` (+ the new guard/terminal tests)
The staking state machine. Walk the `Registration` struct and its three terminal flags
(`filled` / `slashed` / `released`). Read in this order:
`register` → `onFillSuccess` → `slash` → `releaseRegistration` → `withdraw`.
- Then read `test/FillAuctionTerminalState.t.sol` — it's the clearest statement of the
  invariant: a stake settles **exactly once**.
- Ask: who may call `register` / `onFillSuccess`? (the `onlyReactor` modifier — why?) When is
  a filler *slashable* vs *entitled to release*? (H-1/H-2: lost-the-race ≠ misbehaved.)

### Step 3 — `PartialFillReactor.sol` + `test/PartialFillReactor.t.sol`
The orchestrator. Focus on `executePartialChunk` — it's the whole protocol in one function.
Trace its CHECKS → EFFECTS → INTERACTIONS blocks. Then read the regression tests that explain
*why* each line exists: `test/AuditFixes.t.sol` (C-1, C-2, H-1, H-2, L-3) and
`test/adversarial/MevFillerExploits.t.sol`.
- Ask: where is the swapper's price authenticated (C-1)? Where is `minOutputAmount` enforced —
  per chunk *and* on completion (C-1 + `test/CompletionFloor.t.sol`)? How are the
  fallback and partial-fill paths made mutually exclusive (C-2, `markFallbackInitiated`)?

### Step 4 — `FallbackExecutor.sol` + `test/FallbackExecutor.t.sol`
The escape hatch. (Ask: why must it call `reactor.verifyOrderSignature` and drive `remaining`
to 0 atomically? — that's C-2 again, from the other side.)

### Step 5 — the invariant suite (`test/invariant/`)
`FillAuctionInvariant.t.sol` + `FillAuctionHandler.sol`. (Ask: what is "solvency" here, and how
does the handler generate random register/fill/slash/withdraw sequences?)

### Step 6 — cross-chain (`src/crosschain/` + `test/crosschain/`)
Order: `EscrowDst` → `EscrowSrc` → `EscrowDstFactory` → `EscrowSrcFactory`, then
`crosschain.md` (the design doc + findings). The escrows are tiny HTLCs; the factories add the
CREATE2-clone + Merkle-proof + signature machinery.
- Ask: why one clone *per slot* instead of a shared mapping? Why is the Merkle proof checked
  *before* funds move? What guarantees the `T2 < T1` timelock ordering — and what happens if it
  doesn't? (finding `crosschain.md §4` + `test/crosschain/CrossChainTimelock.t.sol`.)
- Then read the **Trufy cross-chain findings** (`crosschain.md §5`): which are fixed on-chain
  in `EscrowSrcFactory` (3.7 safety-deposit floor, 3.8 zero-slot guard — tests in
  `EscrowSrcFactory.t.sol`) and which are **cosigner-enforced in the backend watcher**
  (`backend/src/chain/escrowDstWatcher.ts`: 3.1 timelock, 3.2 same-filler binding, 3.6
  last-slot output). Ask: why can the filler-binding and timelock invariants *not* live in one
  escrow contract, and what trust assumption does the watcher mitigation rely on?

### Companion docs
`audit.md` (reactor/auction findings + remediation), `crosschain.md` (cross-chain design +
findings), `testcase.md` (every test and what it proves). Read a finding, then open the test
that pins it — that loop is how you internalize the *why*.

---

## 3. The life of an order (single-chain happy path)

Trace this end-to-end with the files open; it ties everything together.

1. **Off-chain:** swapper signs an `OrderInfo` (11 fields incl. `startPrice`, `decayPerBlock`,
   `feeTier` — all under the cosigner signature, post-C-1). Swapper has a standing **Permit2**
   allowance to the reactor.
2. **Register** — filler calls `PartialFillReactor.register(order, fillAmount)` with ETH stake.
   The reactor validates the cosigner signature (M-3) and forwards to
   `FillAuction.register`, which sizes the required stake via
   `DynamicStakeLib.toEthNotional` → `computeCollateral` and snapshots the refund row (M-2).
3. **Fill** — filler calls `executePartialChunk(order, fillAmount)`:
   - CHECKS: not cancelled / not fallback-initiated / nonce valid / has a valid registration /
     within deadline / `fillAmount ≤ remaining` and `≥ minFillBps` floor.
   - EFFECTS: decrement `remaining` (`RemainingLib`), advance the price cursor
     (`DecayCursorLib`), price the chunk `output = fill · price / 1e18`, enforce the per-chunk
     min-output floor, and the absolute floor on completion.
   - INTERACTIONS: pull input via Permit2 (swapper → filler), push output (filler → swapper),
     then `FillAuction.onFillSuccess` refunds part of the stake by fill-ratio.
4. **Settle stake** — refund lands in `pendingReturns`; filler calls `withdraw()`. If the
   filler lost the race (remaining hit 0 via others) it calls `releaseRegistration` for a full
   refund (H-1); if it reserved-and-vanished, after `deadline + SLASH_WINDOW` anyone may
   `slash` it (90% treasury, 10% slasher bounty).
5. **Fallback** (only if unfilled near deadline) — `FallbackExecutor.executeFallback` swaps the
   remainder on Uniswap and atomically zeroes `remaining`.

---

## 4. Mental model / invariant per file (the thing to actually remember)

| File | The one idea | The invariant it protects |
|---|---|---|
| `DecayCursorLib` | price = startPrice − decay·Δblocks, clamped ≥ 0 | monotonic, never underflows |
| `RemainingLib` | encode "untouched / partial / done" in one slot | "filled to 0" ≠ "never started" |
| `DynamicStakeLib` | value everything in **ETH notional** first | stake tracks real value for *any* token (D-1) |
| `FillAuction` | a stake has 3 terminal states, settles **once** | no double-payout; lost-race ≠ slashable |
| `PartialFillReactor` | the cosigner signs the price; floors are enforced | swapper never paid below their signed floor (C-1) |
| `FallbackExecutor` | fallback and partial-fill are mutually exclusive | the same `remaining` can't be spent twice (C-2) |
| `EscrowSrc/Dst` | reveal one secret on chain B → redeem on chain A | atomic swap *iff* `T2 < T1` holds + both legs share one filler (timelock & binding cosigner-enforced off-chain — Trufy 3.1/3.2) |
| `*Factory` | one isolated clone per slot, proof-gated funding | a bug in one fill can't drain another; a real safety deposit + nonzero slot size are required (Trufy 3.7/3.8) |

---

## 5. Rebuild from scratch (M0 → M7), test-first

The deepest understanding comes from re-implementing it. Do it in a scratch project
(`forge init neutronx-rebuild`), one milestone at a time. For each: write the **test first**
(copy the "ask yourself" into asserts), implement until green, then diff against this repo's
version and note what you missed. Don't peek at the reference until your test passes or you're
truly stuck.

**M0 — Tooling.** `forge init`, write a trivial `MockERC20` + a 1-line test, run `forge test`.
Goal: the loop (edit → `forge test`) is muscle memory.

**M1 — Decay price (`DecayCursorLib`).** Implement `init` / `getCurrentPrice` / `reset`.
Test: price at block 0 == startPrice; linear decay after N blocks; clamps to 0; `reset`
re-anchors. *Aha:* why store an anchor block instead of recomputing from order start.

**M2 — Remaining accounting (`RemainingLib`).** Implement the packed encoding.
Test: new-order sentinel, partial, fully-filled, pack/unpack round-trip (fuzz it).
*Aha:* the "0 remaining vs untouched" ambiguity you're designing around.

**M3 — A minimal reactor (no staking, no decay yet).** Just: verify a cosigner EIP-712
signature, pull input via a mock Permit2, push a fixed-price output, decrement remaining.
Test: happy fill; reverts on bad signature / expired / over-fill. *Aha:* EIP-712 digest
construction (`\x19\x01` ‖ domainSeparator ‖ structHash) and why the price must be *in* the
signed struct (C-1).

**M4 — Add decay + the two min-output floors.** Wire M1 in; price each chunk at the current
decayed price; enforce the per-chunk pro-rata floor and the absolute floor on completion.
Test: rebuild `CompletionFloor.t.sol` from scratch — two chunks each clear their pro-rata
floor but completion underpays → revert. *Aha:* why the absolute floor is **not** redundant
with the per-chunk one (integer flooring).

**M5 — Staking economics (`FillAuction` + `DynamicStakeLib`).** Implement `register` /
`onFillSuccess` / `slash` / `releaseRegistration` / `withdraw`, with bucketed collateral &
refund (start oracle-disabled: notional == fill). Test: rebuild the terminal-state matrix
(`FillAuctionTerminalState.t.sol`) and the L-2 guard batch (`CoreGuards.t.sol`). *Aha:* the
three terminal flags and "settle exactly once"; why lost-the-race must be releasable not
slashable (H-1/H-2).

**M6 — The TWAP oracle (`toEthNotional`).** Add Uniswap V3 `observe()` pricing so collateral
is ETH-denominated for any token. Test on a mainnet fork (rebuild `TwapCollateral.t.sol`), then
rebuild the manipulation PoC (`TwapManipulation.t.sol`). *Aha:* D-1 (dimensional bug) and N-3
(short window = cheap to manipulate).

**M7 — Cross-chain HTLC (`EscrowSrc/Dst` + factories).** Build the two escrows
(hashlock + timelock), then the CREATE2-clone factories with Merkle-proof-gated funding. Test:
happy claim/withdraw, cancel/refund after expiry, and rebuild `CrossChainTimelock.t.sol` to
*break* it with `T2 ≥ T1`. *Aha:* what makes an atomic swap atomic — and how the timelock
ordering is the load-bearing assumption.

By M7 you'll have re-derived every finding in `audit.md`/`crosschain.md` with your own hands.

---

## 6. Tooling & commands

This repo's Foundry runs under **WSL** on this machine (forge isn't on the Windows PATH):

```bash
# from WSL, in the contract/ dir
forge build
forge test                                   # everything (fork tests need ALCHEMY_RPC_URL)
forge test --no-match-path 'test/{FallbackExecutor,TwapCollateral,TwapManipulation}.t.sol'  # fast, no network
forge test --match-path 'test/CompletionFloor.t.sol' -vvv   # one suite, traces
export ALCHEMY_RPC_URL=<mainnet rpc>         # required for the fork tests
forge coverage --ir-minimum --report summary # see the caveat below
```

- **Fork tests** (`TwapCollateral`, `TwapManipulation`, `FallbackExecutor`) need a mainnet RPC.
  They occasionally fail transiently on live pool price (`test_fallback_swapsSuccessfully`) or an
  Alchemy RPC timeout (`test_manipulatedTwap_*`) — environment artifacts, not regressions. The
  latest full run passed 143/143; see `testcase.md`.
- **Coverage `--ir-minimum`** is needed (the instrumented build hits "stack too deep"
  otherwise). Trust line/statement/function %, **not** branch % — forge under-counts `require`
  revert arms (see the coverage note in `audit.md`/`testcase.md`).
- Test name conventions: `test_*` unit, `testFuzz_*` property (256 runs), `invariant_*`
  stateful.

---

## 7. Self-quiz (if you can answer these, you understand it)

1. Where, exactly, is the swapper protected from being paid below their floor — name both
   enforcement points and explain why one isn't enough.
2. A filler registers, then another filler fills the whole order first. Walk the losing
   filler's stake from registration to withdrawal. Now repeat for a filler that reserved a
   chunk and vanished.
3. Why is collateral computed from an ETH notional rather than raw token units? Construct the
   failure if it weren't (D-1).
4. How are the fallback and partial-fill paths kept from spending the same `remaining` twice?
5. In the cross-chain swap, who reveals the secret, on which chain, and why must the
   destination escrow expire before the source one?
6. Why does `forge coverage` show ~24% branches on a contract whose every line is tested?
```
