# NeutronX — Smart-Contract Test Catalogue

Reference for the thesis: every Foundry test, what property it verifies, and how the
suite maps onto the security findings in `audit.md`.

## Totals

| | Count | Result |
|---|---|---|
| Total tests | **128** | 127 pass · 1 pre-existing failure |
| Non-fork tests | **122** | all pass |
| Fork tests (mainnet, need `ALCHEMY_RPC_URL`) | **6** | 5 pass · 1 pre-existing failure |

Beyond the Foundry tests above, **2 live filler-race E2E scenarios** (`tests/race/`,
shell-orchestrated, both passing) drive the real bots end-to-end — see §8.

> **Second-pass additions (this audit round):** 32 new tests across 5 files —
> double-settlement matrix (`FillAuctionTerminalState`, §2), completion-floor
> backstop (`CompletionFloor`, §2), the protective-shell guard batch
> (`CoreGuards`, §2), the cross-chain timelock PoC (`CrossChainTimelock`, §6),
> and the TWAP-manipulation PoC (`TwapManipulation`, §7). See the **Test coverage**
> note before the finding matrix.

The single failure — `test_fallback_swapsSuccessfully` — is **pre-existing and unrelated to
this work**: it forks live mainnet and hard-codes `amountOutMinimum: 2000e6` for a 1 WETH→USDC
swap, which the live pool price no longer satisfies, so Uniswap reverts at the router call
(before any NeutronX logic). It is not a regression.

## How to run

```bash
cd contract

# all non-fork tests (deterministic, no network)
forge test --no-match-path 'test/{FallbackExecutor,TwapCollateral,TwapManipulation}.t.sol'

# include the mainnet-fork tests (D-1 oracle + fallback)
export ALCHEMY_RPC_URL=<mainnet rpc>
forge test

# a single suite, verbose
forge test --match-path 'test/adversarial/*' -vvv
```

Test types: `test_*` = unit, `testFuzz_*` = property/fuzz (256 runs), `invariant_*` =
stateful invariant (256 runs × 100 calls).

---

## 1. Library unit tests (`test/libs/`)

Pure arithmetic of the staking / pricing / accounting primitives.

**`DecayCursorLib.t.sol`** — Dutch-auction price decay cursor (5 tests)
| Test | Verifies |
|---|---|
| `test_init_getCurrentPrice_sameBlock` | price == startPrice on the init block |
| `test_getCurrentPrice_afterNBlocks` | linear decay `startPrice − n·decay` |
| `test_getCurrentPrice_fullyDecayed` | clamps to 0, never underflows |
| `test_reset_resetsPrice` / `test_reset_keepsDecayPerBlock` | reset moves the anchor but keeps the slope |

**`DynamicStakeLib.t.sol`** — bucketing helpers (15 tests): `getFillRatioBucket` (buckets 0–4
+ full-fill + over-fill edges), `getOrderSizeBucket` (4 size tiers), `getTimeBucket`
(far / close / very-close / expired). Verifies every boundary classifies correctly.

**`DynamicStakeLibStake.t.sol`** — collateral/refund economics (9 tests, incl. fuzz)
| Test | Verifies |
|---|---|
| `testFuzz_computeCollateral_monotonicInFillAmount` | collateral never decreases as the ceiling grows (no "ceiling-shopping") |
| `testFuzz_computeRefund_monotonicAtBucketBoundaries` (+ live-table variant) | refund non-decreasing across every fill-ratio boundary |
| `testFuzz_computeRefund_fullFillReturnsFullStake` | a ≥70% fill always returns 100% |
| `test_computeCollateral_noCeilingShoppingDiscount` | cost scales exactly with the ceiling |
| `test_computeRefund_smallActualFill_forfeitsMostStake` | a small fill-ratio returns little (refund-table shape; lib is denominator-agnostic — caller keys it to commitment) |
| `test_refundTable_isMonotonicPerRow` / default-table variant / non-zero-rate | the deployed tables are well-shaped |

**`RemainingLib.t.sol`** (6) — the packed remaining-amount encoding (new-order / partial /
fully-filled sentinels, pack/unpack round-trip).

**`ScaledOutputLib.t.sol`** (5) — proportional vs last-fill output scaling and dust handling.

---

## 2. Core contract tests

**`FillAuction.t.sol`** (16) — staking lifecycle: `register` (success, excess refund, and
reverts for deadline/duplicate/insufficient-stake/only-reactor), `slash`
(success / too-early / already-filled), `withdraw`, `onFillSuccess` refund tiers
(D-2: full-commitment 100% / 40%-of-commitment 50% / 2.5%-of-commitment 10%), and `hasValidRegistration` ceiling semantics.

**`PartialFillReactor.t.sol`** (6) — fill flow: first fill success, multi-fill remaining
decrement, and reverts for not-registered / expired / fill-exceeds-remaining; `onFillSuccess`
is invoked.

**`RegistrationForgery.t.sol`** (3) — the **prior** exploit (`exploit.md`) stays fixed:
`register` is `onlyReactor`; orderTotal/deadline are derived from the real hashed order;
a forged `OrderInfo` decouples into a different hash and is unusable against the real order.

**`FrontRunGriefing.t.sol`** (2, incl. fuzz) — a front-running filler's refund matches its
*actual* fill ratio, so front-running cannot extract an undue refund.

**`FillAuctionTerminalState.t.sol`** (3) — **double-settlement matrix.** A registration has
three mutually-exclusive terminal states (`filled` / `slashed` / `released`), each crediting
`pendingReturns` once. From each terminal state, the test asserts every *other* settlement
path (including repeating the same one) reverts `"invalid state"` and credits nothing further,
with a stake-conservation check. This is the guard that stops a single staked deposit being
paid out twice — economic-safety logic, not a cosmetic require.
| Test | Verifies |
|---|---|
| `test_terminal_filled_blocksAllOtherSettlements` | after `onFillSuccess`, slash/release/refill all revert; refund+forfeit == stake |
| `test_terminal_slashed_blocksAllOtherSettlements` | after `slash`, no second settlement; reward+treasury == stake |
| `test_terminal_released_blocksAllOtherSettlements` | after `releaseRegistration`, no second settlement; full stake returned once |

**`CompletionFloor.t.sol`** (2, incl. fuzz) — **C-1 absolute min-output backstop.** Each chunk
clears a *pro-rata* floor, but integer flooring means the per-chunk floors can sum below the
signed `minOutputAmount`; the `"min output total"` check on completion is the backstop.
| Test | Verifies |
|---|---|
| `test_completionBelowAbsoluteFloor_reverts` | two chunks each clear their pro-rata floor, but completing would underpay → reverts `"min output total"`, order left partially filled |
| `testFuzz_completedOrder_neverBelowSignedFloor` | for any split + non-decaying price ≥ floor, a *completed* order always paid the swapper ≥ `minOutputAmount` |

**`CoreGuards.t.sol`** (25) — **protective-shell branch batch.** The revert arms high
line-coverage leaves untaken: FillAuction owner/one-time guards (`setReactor`,
`setCollateralRate`/`setRefundTable` **L-2 bounds** + bad-bucket + not-owner),
`register` input guards (`zero fill` / `fill > total` / uint128 truncation / stake-width),
and reactor guards (`setFallbackExecutor` already-set/zero, `markFallbackInitiated`
access + cancelled, `cancelOrder` not-swapper/already-cancelled, `register` on a cancelled
order, and the `minFillBps` floor `"fill < minimum"`). Several pin **L-2** fixes that
previously shipped without a regression test.

---

## 3. Stateful invariant (`test/invariant/`)

**`FillAuctionInvariant.t.sol` → `invariant_solvency`** — across any random sequence of
register / fill / slash / withdraw / roll, the contract balance always equals
`Σ active stakes + Σ pendingReturns`. Money is never created or destroyed.

---

## 4. Security-fix regression (`test/AuditFixes.t.sol`)

Proves each audit fix holds, wired against the real contracts (6 tests).

| Test | Finding |
|---|---|
| `test_C1_tamperedStartPrice_rejected` | **C-1** price curve is signed — tampering reverts |
| `test_C1_minOutputFloor_enforced` | **C-1** swapper's min-output floor is enforced |
| `test_C2_fallbackBlocksPartialFill` | **C-2** fallback ⇄ fill mutual exclusion + remaining zeroed |
| `test_H1_loserReclaimsStake_andCannotBeSlashed` | **H-1** race loser reclaims full stake; not slashable |
| `test_H2_cancelledOrder_notSlashable_reclaimable` | **H-2** cancelled-order stake is reclaimable, not slashable |
| `test_L3_invalidateNonce_blocksFill` | **L-3** nonce invalidation stops fills |

---

## 5. Adversarial / MEV suite (`test/adversarial/`) — thesis centrepiece

Models honest **and** malicious fillers as addresses making call sequences (no servers; a
test plays "the MEV bot won the ordering race"). All deterministic, no fork.

**`MevFillerExploits.t.sol`** — Adversary A (10 tests)
| Test | What the MEV filler tries → outcome |
|---|---|
| `test_tamperStartPrice_rejected` | rewrite the signed price → **reverts** (`invalid sig`) |
| `test_fillBelowMinOutput_reverts` | pay the swapper below floor → **reverts** (`min output`) |
| `test_lateFill_skimsDecaySpread_butStaysAboveFloor` | time the decay to underpay → **succeeds but bounded** ≥ floor |
| `test_lateFill_belowFloor_reverts` | wait past the floor price → **reverts**, swapper protected |
| `test_frontRunRace_loserReclaimsFullStake` | win the chunk → legit; **loser reclaims 100% stake** |
| `test_snipeSmallChunk_fullyRefunded` | grab a 1% chunk, deliver it fully → **full refund** (D-2: honouring any-size commitment isn't penalised) |
| `test_minFillBps_blocksDustFill` | dust fill below the order's `minFillBps` → **reverts** (the proper anti-dust lever) |
| `test_registerThenAbandon_isSlashed_noProfit` | reserve then vanish → **slashed, recovers nothing** |
| `test_fillAfterFallback_reverts` | double-spend across fallback → **reverts** (`fallback initiated`) |
| `test_reentrantOutputToken_reverts` | re-enter via a malicious output token → **reverts** (nonReentrant) |

**`MultiOrderScenario.t.sol`** — `test_population_honestAndMev_invariantsHold` (1 test):
3 swappers, 3 orders, 2 honest fillers + 1 MEV filler run over several blocks, then global
invariants: (a) every swapper filled ≥ floor, (b) token conservation in & out,
(c) the race-loser lost nothing, (d) nothing wrongly forfeited to the treasury,
(e) FillAuction solvency, and funds are withdrawable.

**Take-away:** against the hardened contracts the MEV filler's only real edge is *timing the
decay curve*, and that is hard-capped by the signed min-output floor. Every direct
theft/grief vector reverts or leaves the attacker worse off.

---

## 6. Cross-chain escrow (`test/crosschain/`)

**`EscrowSrcFactory.t.sol`** (5) — multi-slot source escrow: fill→withdraw pays the filler,
cancel-after-expiry refunds the swapper and pays the canceller, and reverts on invalid
Merkle proof / invalid swapper signature / double-fill.

**`CrossChainTimelock.t.sol`** (1) — **PoC for `crosschain.md §4` (timelock ordering).**
`test_T2geqT1_swapperTakesBothLegs`: the `T2 < T1` invariant (destination expires before
source) is asserted only in a comment and never enforced on-chain, and is expressed in
cross-chain-incomparable `block.number`. With `T2 ≥ T1` (which both factories accept), the
swapper reclaims the source leg via `EscrowSrc.cancel()` **and** is paid the destination leg
via `EscrowDst.claim()` — collecting both while the filler, who funded the destination,
recovers nothing. Demonstrates the atomicity break; fix is timestamp-based expiries + an
enforced gap.

---

## 7. Fork tests (mainnet — need `ALCHEMY_RPC_URL`)

**`TwapCollateral.t.sol`** (2) — proves **D-1** works for *any* token:
| Test | Verifies |
|---|---|
| `test_wethInput_isOneToOne` | WETH input short-circuits the oracle 1:1 |
| `test_usdcInput_pricedViaTwap` | USDC is priced via the V3 TWAP into an **ETH-scale** collateral (not raw-unit nonsense), and grows with fill size |

**`FallbackExecutor.t.sol`** (3) — the Uniswap fallback path:
| Test | Result |
|---|---|
| `test_fallback_revert_tooEarly` | ✅ reverts outside the fallback window |
| `test_fallback_revert_expired` | ✅ reverts on an expired order (sig validation first) |
| `test_fallback_swapsSuccessfully` | ❌ **pre-existing** live-price failure (see Totals) |

**`TwapManipulation.t.sol`** (1) — **PoC for finding N-3 (TWAP collateral manipulation).**
`test_manipulatedTwap_collapsesRequiredCollateral`: dumps USDC into the same
`(USDC,WETH,0.05%)` pool the collateral oracle reads, then holds the price across the full
60 s window. The required stake for a 3000-USDC order collapses from ~0.905 ETH to ~4.6e-6 ETH
(−100%; a smaller 60M-USDC dump gives −34%), re-opening the D-1 "stake ≈ 0, slashing
toothless" failure mode. Same class as Mango/Cream/Harvest; the real-world bound is capital ×
pool depth, which is why the short window is the lever.

---

## 8. Live filler-race E2E (`tests/race/`, not Foundry)

Shell-orchestrated end-to-end tests where the **two real filler bots**
(CoWFiller + WhaleFiller) compete on a live Anvil mainnet fork — the actual
Node servers, backend, and Postgres, not simulated addresses. Where the Foundry
suite *proves* the mechanics deterministically, these *demonstrate* the real bots
under real concurrency. Orders are sized so **no single filler can fill 100% in
one chunk** (each risks ≤50% of its USDC inventory per fill), forcing cooperative
partial fills. Run with `bash tests/race/race_one_order.sh` (needs foundry, jq,
Docker/Postgres, node_modules, a fork RPC).

| Scenario | Setup | Verified result (live) |
|---|---|---|
| `race_one_order.sh` | one 20 WETH order; each filler funded 60k USDC (~12 WETH cap) | ✅ filled cooperatively — CoWFiller ~12 WETH, WhaleFiller ~8 WETH; swapper 50,000 USDC ≥ floor; neither did 100% |
| `race_multi_order.sh` | three 16 WETH orders; same caps | ✅ 2 fully filled + 1 partial (inventory depleted → fallback territory); both fillers contributed; any full fill required cooperation |

Assertions are **on-chain** (`remainingInput` + per-filler USDC spend), because the
backend indexer is asynchronous and lags the chain. These also exercise the
filler-side changes for the hardened contract: the **11-field signed hash**,
**`previewCollateral`** stake sizing, **capacity-capped** dev fills, and the
**`releaseRegistration`** stake-reclaim path (H-1) when a filler loses a chunk.

> Note: in these runs the backend indexer did not catch up within the test window
> (it reported `status=pending, fills=0` while the chain showed the fills) — an
> indexing-latency observation, independent of contract/filler correctness.

---

## Test coverage (forge coverage, non-fork run)

After the second pass, `src/FillAuction.sol` reaches **100% line / statement / function**
coverage; `src/PartialFillReactor.sol` is **94% line / 96% statement** (the 5 uncovered lines
are fallback / `verifyOrderSignature` paths exercised only by the excluded fork test
`FallbackExecutor.t.sol`).

> **On branch %:** `forge coverage`'s branch metric is deliberately **not** quoted as a
> headline here. It is known to under-count `require(cond, "msg")` revert arms — exactly what
> the `CoreGuards` batch exercises — so it barely moved (FillAuction ~24%) even though the
> revert lines are now all executed and individually asserted. The trustworthy evidence the
> guards work is the 25 passing `CoreGuards` tests, each asserting a specific revert string,
> plus FillAuction's 100% line/statement/function coverage. Quoting the tool's branch figure
> would understate the suite.

## Finding → test coverage matrix

| Finding (see `audit.md` / `crosschain.md`) | Covered by |
|---|---|
| C-1 price authentication + min-output | `AuditFixes::test_C1_*`, `MevFiller::test_tamperStartPrice_rejected`, `test_fillBelowMinOutput_reverts`, `test_lateFill_*`, **`CompletionFloor::*`** (absolute floor backstop) |
| C-2 fallback / fill mutual exclusion | `AuditFixes::test_C2_*`, `MevFiller::test_fillAfterFallback_reverts`, `CoreGuards::test_markFallbackInitiated_*` |
| H-1 race-loser stake recovery | `AuditFixes::test_H1_*`, `MevFiller::test_frontRunRace_*`, `MultiOrderScenario`, **`FillAuctionTerminalState::test_terminal_released_*`** |
| H-2 cancel-grief protection | `AuditFixes::test_H2_*`, `CoreGuards::test_*cancelled*` |
| M-1 per-fill pricing (no underflow) | `PartialFillReactor::test_multipleFills_*`, `MevFiller::test_lateFill_*`, `Settleability::testFuzz_alwaysSettleable` (fuzz: arbitrary decay/partition always settles) |
| M-2 refund snapshot | `FillAuction::test_onFillSuccess_*`, `DynamicStakeLibStake` |
| M-3 register validates signature | `AuditFixes::test_C1_tamperedStartPrice_rejected` (caught at register), `RegistrationForgery` |
| L-2 cast / setter bounds | **`CoreGuards::test_setCollateralRate_*`, `test_setRefundTable_*`, `test_register_revert_{fillTooLarge,totalTooLarge,stakeTooLarge}`** |
| L-3 nonce invalidation | `AuditFixes::test_L3_invalidateNonce_blocksFill` |
| D-1 ETH-denominated collateral | `TwapCollateral` (fork), `DynamicStakeLibStake` |
| N-3 TWAP collateral manipulation | **`TwapManipulation::test_manipulatedTwap_collapsesRequiredCollateral`** (fork PoC) |
| Cross-chain timelock (`crosschain.md §4`) | **`CrossChainTimelock::test_T2geqT1_swapperTakesBothLegs`** |
| Double-settlement / terminal state | **`FillAuctionTerminalState::*`** |
| D-2 refund keyed to committed (not order) | `MevFiller::test_snipeSmallChunk_fullyRefunded` / `test_minFillBps_blocksDustFill`, `FillAuction::test_onFillSuccess_*`, `FrontRunGriefing`, `FillAuctionTerminalState` |
| Solvency / conservation | `FillAuctionInvariant::invariant_solvency`, `MultiOrderScenario` |

## Out of scope (analysed in the thesis, not coded — fork-dependent)

- **Fallback sandwich MEV (Adversary B):** the fallback executes on public pools and so
  inherits standard sandwich exposure; bounded on-chain by the signed min-output floor, and
  mitigated off-chain by private-mempool submission. Not a Uniswap-router defect.
