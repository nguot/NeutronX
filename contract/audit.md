# Security Audit — `FillAuction.sol` & `PartialFillReactor.sol`

**Scope:** `contract/src/FillAuction.sol`, `contract/src/PartialFillReactor.sol`, and the
libraries they depend on (`DynamicStakeLib`, `ScaledOutputLib`, `RemainingLib`,
`DecayCursorLib`). `FallbackExecutor.sol` is referenced only where it couples to the
reactor's settlement accounting.

**Date:** 2026-06-11
**Status of prior fixes:** The registration-forgery exploit (`exploit.md`) is mitigated —
`orderTotal`/`deadline` passed to `FillAuction.register` are now taken from the order
struct rather than free caller input, and hash-equality at execute time binds them.

**Remediation note (2026-06-11):** The findings below were originally written pre-fix
("issues that still remain"). They have since been remediated — see **Remediation status**
immediately after the severity summary for the per-finding fixed/partial verdict, the new
findings the fix introduced, and the test verification. The descriptions below are kept as
the original write-up of each issue.

---

## Severity summary

| ID | Severity | Title |
|----|----------|-------|
| C-1 | 🔴 Critical | Price curve is unauthenticated and `minOutputAmount` is never enforced — first filler can steal swapper funds |
| C-2 | 🔴 Critical | Fallback and partial-fill settlement paths are not mutually exclusive — double-spend / corrupted accounting |
| H-1 | 🟠 High | Registrants who lose the fill race (or are cancelled out) lose 100% of stake; only path back is `slash` |
| H-2 | 🟠 High | Swapper can solicit stakes then `cancelOrder`, griefing fillers into a slash |
| M-1 | 🟡 Medium | Final-fill output computation underflows under price decay — partially-filled orders can brick |
| M-2 | 🟡 Medium | Owner can retroactively rewrite `refundTable`/`collateralRate` after fillers have staked |
| M-3 | 🟡 Medium | `PartialFillReactor.register` never verifies the cosigner signature |
| L-1 | ⚪ Low | Permit2 allowance is not bound to a specific order; full reliance on the cosigner key |
| L-2 | ⚪ Low | Unbounded/unsafe casts (`uint128`/`uint160`) and missing setter bounds |
| L-3 | ⚪ Info | No independent nonce invalidation; non-standard EIP-712 domain |
| D-1 | 🟠 High | `DynamicStakeLib` collateral is dimensionally broken — stake ≈ 0 for any non-WETH input |
| D-2 | 🟡 Medium | Refund schedule punishes honest partial fills (keyed to fill-vs-orderTotal ratio) |
| D-3 | ⚪ Low | Time-multiplier read only at registration → cheap-early-registration arbitrage |

---

## Remediation status (2026-06-11)

All fixes are implemented in `src/` and verified by `forge test`: **89 non-fork tests pass**
(including 6 `test/AuditFixes.t.sol` regression tests, a 10-test adversarial / MEV suite in
`test/adversarial/`, and the `FillAuctionInvariant` solvency invariant), plus **4 fork tests
pass** (2 D-1 TWAP tests in `test/TwapCollateral.t.sol` + the 2 `FallbackExecutor` revert
tests). The only failing test is the pre-existing, price-dependent
`test_fallback_swapsSuccessfully` (live Uniswap `amountOutMinimum` fragility — unrelated to
these changes). A full per-test catalogue is in **`testcase.md`**. Off-chain TypeScript
(backend cosigner, both fillers, solver) was updated to the new 11-field signed hash and the
`previewCollateral` stake API.

| ID | Status | How / why |
|----|--------|-----------|
| C-1 | ✅ **Completely fixed** | `startPrice`/`decayPerBlock`/`feeTier` added to `ORDER_TYPE_HASH` + `_hashOrder` (price now signed); `executePartialChunk` enforces a pro-rata `minOutputAmount` floor per chunk and the absolute floor on completion. Regression: `test_C1_tamperedStartPrice_rejected`, `test_C1_minOutputFloor_enforced`. |
| C-2 | ✅ **Completely fixed** | `executePartialChunk` reverts on `_fallbackInitiated`; `markFallbackInitiated` now zeroes `_remaining` atomically; `FallbackExecutor` authenticates via `reactor.verifyOrderSignature` and enforces the signed pro-rata min-output. Regression: `test_C2_fallbackBlocksPartialFill`. |
| H-1 | ✅ **Completely fixed** | New `releaseRegistration` returns full stake when remaining==0 / cancelled; `slash` now requires `remainingInput > 0`. Regression: `test_H1_loserReclaimsStake_andCannotBeSlashed`. |
| H-2 | ✅ **Completely fixed** | `slash` requires `!isCancelled`; cancelled-order stakes are reclaimable via `releaseRegistration`. Regression: `test_H2_cancelledOrder_notSlashable_reclaimable`. |
| M-1 | ✅ **Completely fixed** | Each chunk priced independently at the current decayed price (`fillAmount × price / 1e18`); the global "decayedTotal − alreadyPaid" reconciliation that underflowed is gone. |
| M-2 | ✅ **Completely fixed** | The refund row is snapshotted into the `Registration` at register time (`refundRow`); settlement no longer reads the mutable table. |
| M-3 | ✅ **Completely fixed** | `reactor.register` now calls `_validateOrder` (cosigner sig + deadline + nonce) before any stake is placed. |
| L-1 | 🟡 **Partial (by design)** | C-1 closes the *theft*; the cosigner remains the sole on-chain authority (no per-order swapper signature). Retained intentionally to preserve the backend-cosigner architecture. Residual: a compromised cosigner key can still author orders against standing Permit2 allowances. |
| L-2 | ✅ **Completely fixed** | Explicit `uint128`/`uint160` range guards in `register`/`executePartialChunk`; `setCollateralRate`/`setRefundTable` bounded (`MAX_COLLATERAL_RATE`, `MAX_REFUND_BPS`, bucket bounds). |
| L-3 | 🟡 **Partial** | Nonce invalidation **fixed** (`invalidateNonce`, checked on register + every fill; regression `test_L3_invalidateNonce_blocksFill`). EIP-712 domain `version` field **deferred** — purely cosmetic, and changing the domain separator would destabilize signing across the 5 on/off-chain sites for no security gain. |
| D-1 | ✅ **Completely fixed** | Collateral is now an ETH-denominated notional via a Uniswap V3 TWAP over the order's `feeTier` (WETH input short-circuits 1:1; `factory==0` = mock mode). `previewCollateral` view added for clients. Decimals/price are normalized away, so the stake is correct for any token. Verified for USDC on a mainnet fork (`test/TwapCollateral.t.sol`). |
| D-2 | ✅ **Completely fixed** | `onFillSuccess` now keys the refund to `actualFill ÷ committedFill` (the filler's own commitment), not the whole order — honouring any-size commitment returns the full stake; only under-delivery vs. what you promised forfeits. Fragmentation is now controlled by the order's `minFillBps` (the proper lever). Tests: `FillAuction::test_onFillSuccess_*`, `FrontRunGriefing`, `MevFiller::test_snipeSmallChunk_fullyRefunded` + `test_minFillBps_blocksDustFill`. |
| D-3 | 🟡 **Not fixed (tolerated)** | Low severity; the dominant deterrent is the refund forfeiture, not the time multiplier. Tolerable. |

## New findings introduced / surfaced by the remediation

| # | Finding | Verdict |
|---|---------|---------|
| N-1 | **Collateral now requires a `(inputToken, WETH)` V3 pool at the order's `feeTier`.** If none exists, `register`/`previewCollateral` revert `"no twap pool"`, so such a token cannot be registered against. | **Tolerable** — correct failure mode (a token with no WETH pool has no safe on-chain price). Restricts listings to WETH-paired tokens, acceptable for an ETH-centric aggregator. |
| N-2 | **`factory == 0` mock mode reinstates the old 1:1 (D-1) behaviour.** A production deploy misconfigured with a zero factory silently sizes collateral off raw token units again. | **Tolerable with discipline** — `Deploy.s.sol` sets the real factory; consider a deploy-time assertion. Not tolerable if a prod deploy ships with `factory==0`. |
| N-3 | **Short 60s TWAP window.** Chosen so a frozen anvil fork stays within the pool's inherited observations; a 60s window over a deep pool is reasonable but more manipulable than the 1800s typical of production. | **Tolerable on fork; tune for mainnet** — lengthen the window (and add a Chainlink cross-check / staleness guard) before any real-value deployment. **PoC:** `test/TwapManipulation.t.sol` (`test_manipulatedTwap_collapsesRequiredCollateral`, mainnet fork) dumps USDC into the priced `(USDC,WETH,0.05%)` pool and holds it across the 60s window, collapsing `previewCollateral` for a 3000-USDC order from ~0.905 ETH to ~4.6e-6 ETH (−100%; a smaller 60M-USDC dump already gives −34%). This re-opens the D-1 "stake ≈ 0, slashing toothless" failure mode — same class as Mango/Cream/Harvest. The real-world bound is capital + pool depth, which is precisely why the short window is the lever. |
| N-4 | **Per-fill pricing (M-1) makes the swapper's total output path-dependent** on when chunks land along the decay curve. | **Tolerable / by design** — the signed `minOutputAmount` floor (C-1) bounds the worst case; this is the intended Dutch-auction behaviour. |

---

## Test coverage

The full catalogue is in `testcase.md` (126 tests; 125 pass + 1 pre-existing fork-price
failure). Coverage relevant to this report:

- **`src/FillAuction.sol`** — 100% line / statement / function (forge coverage, non-fork run).
- **`src/PartialFillReactor.sol`** — 94% line / 96% statement; the uncovered lines are the
  fallback / `verifyOrderSignature` paths covered only by the mainnet-fork
  `FallbackExecutor.t.sol`.
- Each finding maps to at least one regression/PoC test — see the **Finding → test** matrix in
  `testcase.md`. Notably: **N-3** has a fork PoC (`TwapManipulation.t.sol`), the **C-1**
  absolute-floor backstop has a deterministic + fuzz test (`CompletionFloor.t.sol`), the
  double-settlement guard has a terminal-state matrix (`FillAuctionTerminalState.t.sol`), and
  the previously-unpinned **L-2** setter bounds are now covered (`CoreGuards.t.sol`).

> **Branch-coverage caveat:** `forge coverage`'s branch metric is intentionally not quoted as
> a headline. It under-counts `require(cond, "msg")` revert arms (the bulk of the guard
> tests), so it reads low (~24% on FillAuction) despite every revert line executing and being
> asserted by name. Line/statement/function coverage plus the explicit per-revert assertions
> are the faithful measure here.

---

## C-1 — Price parameters are unauthenticated and `minOutputAmount` is never enforced

**Location:** `PartialFillReactor.ORDER_TYPE_HASH` / `_hashOrder` (l.44–50, 177–184),
`executePartialChunk` (l.94–148), `_calcOutputAtPrice` (l.200–204).

**Two defects that compound:**

1. **The signed order hash omits the price curve.** `ORDER_TYPE_HASH` and `_hashOrder`
   cover only 8 fields (`swapper … minFillBps`). `startPrice`, `decayPerBlock`, and
   `feeTier` are part of `OrderInfo` but are **not** in the hash and therefore **not
   covered by the cosigner signature**. On the first fill the cursor is initialised
   directly from caller-supplied `order.info.startPrice` / `decayPerBlock`
   (l.126–127), which set the entire price path for the order.

2. **`minOutputAmount` is never checked.** It is in the struct and in the hash, but no
   line in `executePartialChunk` (or `ScaledOutputLib`) ever requires the paid
   `outputAmount` to be ≥ any function of `minOutputAmount`. The swapper's slippage
   floor does not exist on-chain.

**Exploit:** Any real, cosigned order can be filled by whoever wins the first-fill race.
That filler submits the genuine signature (valid over the 8 fields) but supplies
`startPrice = 1`. `_calcOutputAtPrice` then yields ~0 output; the filler fills 100%,
`permit2.transferFrom` pulls the swapper's full `inputAmount`, and the swapper receives
essentially nothing. There is no minimum-output revert to stop it. This is direct theft
of swapper funds on every order.

**Recommendation:**
- Add `startPrice`, `decayPerBlock`, and `feeTier` to `ORDER_TYPE_HASH` and `_hashOrder`
  so the price curve is authenticated by the cosigner signature.
- Independently enforce the swapper's floor: after computing `outputAmount`, require it
  to meet the pro-rata share of `minOutputAmount` (e.g. `outputAmount * inputAmount ≥
  minOutputAmount * fillAmount`), and require cumulative `_paidOutput ≥ minOutputAmount`
  once the order is fully filled. Defence in depth — keep this even after fixing the hash.

---

## C-2 — Fallback and partial-fill paths are not mutually exclusive

**Location:** `PartialFillReactor._fallbackInitiated` (l.55), `markFallbackInitiated`
(l.156–159), `executePartialChunk` (l.94–148); counterpart `FallbackExecutor.executeFallback`
(l.43–77).

**Problem:** `_fallbackInitiated[orderHash]` is **written but never read**.
`executePartialChunk` does not consult it, and `FallbackExecutor` never reduces the
reactor's `_remaining[orderHash]` (it cannot — the mapping is private and there is no
setter). So when the solver runs the Uniswap fallback for an order's remaining input:
- `FallbackExecutor` pulls `rem` of the swapper's input via Permit2 and swaps it, **but**
- `reactor._remaining[orderHash]` still reports `rem` outstanding, and
- a registered filler can still call `executePartialChunk` for that same `rem`.

**Impact:**
- If the swapper holds further balance and a standing Permit2 allowance (e.g. an
  "infinite" approval), the filler's `permit2.transferFrom` **double-spends** — pulling
  input the fallback already consumed, beyond what the order authorised.
- If the swapper does not, the second pull reverts, but the order's accounting is now
  permanently inconsistent: `_remaining` is never zeroed, `_paidOutput` diverges from
  reality, and stakes for that order can never settle cleanly.

(Related, in `FallbackExecutor`: it also does not verify the cosigner signature and takes
`minAmountOut`/`routeCalldata` from the caller, so the same mutual-exclusion and
authentication weaknesses extend to that contract. Fixing C-2 should treat both sides.)

**Recommendation:**
- Make the two paths mutually exclusive: have `executePartialChunk` `require(!_fallbackInitiated[orderHash])`,
  and have the fallback path drive `_remaining` to fully-filled (a reactor-only,
  `onlyFallbackExecutor` settlement entry that both marks fallback and zeroes remaining
  in one atomic step).
- Conversely block `markFallbackInitiated`/fallback once any partial fill or cancellation
  has occurred for the order, and reconcile `_remaining`/`_paidOutput` against the amount
  the fallback actually consumed.

---

## H-1 — Losing or blocked registrants forfeit their entire stake

**Location:** `FillAuction.register` (l.102–139), `slash` (l.141–156), `onFillSuccess`
(l.166–186), `hasValidRegistration` (l.188–202).

**Problem:** A filler's stake is returned **only** through `onFillSuccess` (which fires
only if *that* filler executes a chunk). When several fillers register for the same order
and one wins the fill race, the order reaches `remaining == 0` and the losers can never
call `executePartialChunk` (it reverts `fill > remaining` / fully-filled). Their
registration stays `filled = false, slashed = false`. The **only** state transition left
for that stake is `slash`, which — after `deadline + SLASH_WINDOW` — sends 90% to the
treasury and 10% to the slasher. The honest-but-late filler recovers **nothing**.

This was observed live in the demo: both bots staked 12 ETH for the same order; the one
that lost the race has no refund path and will eventually be slashed.

**Impact:** Competition is actively disincentivised — rational fillers will not register
unless certain of winning, undermining the multi-filler partial-fill design. It also makes
the slash reward a standing bounty against honest losers.

**Recommendation:** Distinguish "registered but the order was satisfied by others / no
longer fillable" from "registered and culpably failed to fill." Add a permissionless
`releaseRegistration(orderHash, filler)` that returns the full stake (to `pendingReturns`)
when the order's remaining is 0 or the order is cancelled, and restrict `slash` to the case
where unfilled remaining still exists *and* the deadline+window has passed.

---

## H-2 — Swapper can grief stakers via cancellation

**Location:** `PartialFillReactor.cancelOrder` (l.169–175), `executePartialChunk` (l.101),
`FillAuction.slash` (l.141–156).

**Problem:** `cancelOrder` can be called by the swapper at any time, with no interaction
with `FillAuction`. Fillers who already staked can no longer execute (`require(!_cancelled…)`),
so their registrations sit un-fillable and become slashable after the window — forfeiting
90% to the treasury. A swapper who controls or colludes with the treasury/slasher can
solicit registrations and then cancel for profit; even without collusion it is free
griefing of fillers' capital. The same applies to a swapper front-running a pending
`executePartialChunk` with `cancelOrder`.

**Recommendation:** On cancellation, mark the order in a way that lets registrants reclaim
their stake (tie into the H-1 `releaseRegistration` path), and explicitly forbid `slash`
on cancelled orders. Consider requiring cancellation to settle/– or at least flag –
outstanding registrations atomically.

---

## M-1 — Final-fill output underflows under price decay

**Location:** `ScaledOutputLib.scaleOutput` (l.7–19), `executePartialChunk` output block
(l.133–139), `DecayCursorLib`.

**Problem:** For the last fill, `scaleOutput` returns `totalOutput - alreadyPaid`, where
`totalOutput = inputAmount * currentPrice / 1e18` at the (decayed) current price, and
`alreadyPaid` is the sum of earlier fills priced at their (higher) historical prices.
Because price decays monotonically, `totalOutput` at the final fill can be **smaller** than
`alreadyPaid`. The subtraction then underflows and reverts (checked arithmetic).

**Exploit / failure mode:** Take a large early chunk at a high price, let the price decay
toward zero, then the final remaining chunk can never be settled — the order is stuck
partially filled, its remaining input locked behind a reverting computation. This is a
liveness/DoS bug reachable in normal market conditions (steep decay + uneven fill sizes),
not just adversarially.

**Recommendation:** Do not reconcile the last fill against a *current-price* valuation of
the *whole* order. Price each fill independently at the price in effect when it executes
(as non-last fills already are), or clamp the last-fill output to `max(0, totalOutput -
alreadyPaid)` while guaranteeing the swapper's `minOutputAmount` floor (see C-1). Add a
fuzz/invariant test asserting that the sum of fills is always settleable for arbitrary
decay schedules and fill partitions.

---

## M-2 — Owner can retroactively change economic tables

**Location:** `FillAuction.setCollateralRate` (l.94–96), `setRefundTable` (l.98–100),
read points `computeCollateral` (register-time) and `computeRefund` (settlement-time).

**Problem:** `collateralRate` is read at registration and `refundTable` at settlement, but
both are mutable by the owner at any time with no bounds and no timelock. The owner can
lower `refundTable[s][r]` **after** a filler has registered but **before** they settle,
shrinking (even zeroing) the refund the filler was promised — a retroactive rug of staked
capital. There is also no upper bound on `collateralRate`.

**Recommendation:** Snapshot the relevant refund parameters into the `Registration` at
register time so settlement uses the rates in force when the filler committed. Add sane
bounds to the setters and gate changes behind a timelock / two-step process.

---

## M-3 — `register` does not verify the cosigner signature

**Location:** `PartialFillReactor.register` (l.87–92).

**Problem:** `register` hashes `order.info` and forwards `inputAmount`/`deadline` to
`FillAuction.register`, but never calls `_validateOrder`. The signature is only checked on
the first `executePartialChunk`. The in-code comment ("derived from the real signed order")
is therefore misleading: at registration these fields come from an **unverified** struct;
the binding only materialises later via hash-equality at execute.

**Impact:** Mostly self-harm today (a filler can stake against a hash for which no valid
signature exists and will never be able to execute), but it weakens defence in depth and
leaves stake-pollution / future-coupling risk. It also means `register` will happily lock
collateral against fabricated orders.

**Recommendation:** Validate the cosigner signature (and `block.number ≤ deadline`) inside
`register`, so a stake can only ever be placed against a genuinely authenticated order.

---

## L-1 — Permit2 allowance is not bound to an order; full trust in the cosigner

The swapper's authorisation to move funds is a standing Permit2 allowance to the reactor,
not a per-order signature — the **swapper never signs the order on-chain**; the cosigner
does. Any order the cosigner signs (or anything an attacker signs with a compromised
cosigner key) can drain up to a swapper's outstanding allowance. Combined with C-1 this is
catastrophic; even after C-1 it remains a single-key centralisation risk.
**Recommendation:** Require the swapper's own EIP-712 signature over the order (or a
per-order Permit2 witness), so on-chain authorisation is scoped to the exact terms the
swapper agreed to, and the cosigner becomes an additional approver rather than the sole one.

## L-2 — Unsafe casts and unbounded setters

`fillAmount`→`uint160` (reactor l.143) and `fillAmount`/`required`/`orderTotal`→`uint128`
(auction l.123–130) truncate silently for extreme values; `setReactor` is one-time but
`setCollateralRate`/`setRefundTable` accept out-of-range conceptual values (only array
bounds protect them). **Recommendation:** validate that amounts fit their target widths
(revert otherwise) and bound the rate/refund setters.

## L-3 — Nonce invalidation & EIP-712 domain (informational)

There is no way for a swapper to invalidate a `nonce` independently of `cancelOrder(hash)`,
and the EIP-712 domain omits a `version` field. Neither is exploitable on its own.
**Recommendation:** add a nonce-cancellation entry point and a domain `version` for
forward-compatibility.

---

## Suggested remediation order

1. **C-1** and **C-2** first — both are direct fund-loss paths reachable on ordinary orders.
2. **H-1 / H-2** — required for the staking model to be economically honest.
3. **M-1** — correctness/liveness of settlement.
4. **M-2 / M-3 / L-*** — hardening and trust-minimisation.

Each fix should ship with a targeted test: a malicious-first-filler price test (C-1), a
fallback-then-fill double-spend test (C-2), a lose-the-race stake-recovery test (H-1), a
cancel-then-slash test (H-2), and a decay/partition invariant for settleability (M-1).

#####
I read DynamicStakeLib as part of the original pass but didn't surface it separately — it deserves its own findings, and one of them is genuinely dangerous (currently masked only because you trade WETH). Re-reading contract/src/libs/DynamicStakeLib.sol:

D-1 — 🟠 High: collateral math is dimensionally broken (stake ≈ 0 for non-WETH inputs)

Location: getOrderSizeBucket (l.30–36, note the comment "Đơn vị USDC (6 decimals)"), computeCollateral (l.51–67), consumed at FillAuction.register:117-118.

computeCollateral returns fillAmount × rateBps/1e4 × timeMult/1e4. fillAmount is in the input token's smallest units, and the result is then required as ETH wei (require(msg.value >= required)). The two are only equated by reinterpreting "1 input-token unit" as "1 wei of ETH." Separately, getOrderSizeBucket compares orderTotal (= inputAmount, the input token) against thresholds written as 10_000e6 — i.e. USDC, 6 decimals.

It works in the demo only by coincidence: input is WETH, which is 18-decimals and ~1:1 in value with ETH, so fillAmount in WETH-wei numerically equals its value in ETH-wei. That's why a 4 WETH fill produced exactly stake=12.0 ETH (bucket 3 → 300%). The moment the input token differs, it breaks:

- 6-decimal input (e.g. USDC→X): a $10,000 fill is 1e10 units → bucket 1 → required ≈ 1e10 × 0.5 = 5e9 wei ≈ 5 gwei of ETH. The stake is effectively zero, so slashing has no teeth — sniping/griefing becomes free. This silently nullifies the entire economic-security model for any non-WETH market.
- 18-decimal but low-value token: required balloons to absurd ETH amounts → no one can ever register (DoS for that market).
- Side effect: for WETH every realistic order (≥ ~1e12 wei) lands in bucket 3, so the size-tiering does nothing in practice — it's always the max bucket.

Since this is a general aggregator meant to list many tokens, this is a latent High: it's correct for exactly one pair and wrong for all others.

- Root-cause cure: normalize order size and collateral to a single canonical value unit — convert the order's notional to ETH (or USD) via the order's own signed price / an oracle, and compute the stake as a fraction of that ETH-denominated notional. Then the stake tracks real value regardless of token decimals/price.
- Workaround only: hard-restrict the protocol to WETH-input markets and document the assumption. That's a band-aid — it doesn't fix the math, it just fences off the one case where the bug cancels out, and it's exactly the trap waiting for the next listed token.

D-2 — 🟡 Medium: the refund schedule punishes the protocol's own core feature  ✅ FIXED

**Status (fixed):** the root-cause cure below was implemented — `onFillSuccess` keys the
refund to `actualFill ÷ committedFill`, so honouring any-size commitment returns the full
stake and only under-delivery forfeits. Fragmentation control moved to the order's
`minFillBps`. See the Remediation status table.

Location: computeRefund (l.74–84) + getFillRatioBucket (l.17–28); the bucket is keyed to actualFillAmount / orderTotal.

The refund is indexed by actual fill as a fraction of the whole order, not by how much of the filler's own commitment they honored. So a perfectly honest multi-filler split is penalized: five fillers each taking 20% all land in the 10–30% bucket and forfeit ~90% of their collateral (e.g. bucket-2 row gives 6.7–10% refund). Rational fillers therefore avoid partial fills and only take ≥70% — which defeats the entire "PartialFill" premise. The comment frames this as an intentional "sniping fee," but as written it cannot distinguish a sniper from a legitimate partial filler.

- Root-cause cure: key the refund to actualFill / committedFillAmount (did the filler deliver what they registered for?). Honest partial-fillers who honor their commitment get a full refund; only under-delivery vs. their own commitment is penalized. That aligns the incentive with the partial-fill design.
- Workaround only: flatten/soften the refund table. Reduces the pain but still mis-attributes "small fill" as "bad actor."

Lower-severity notes

- D-3 (Low): getTimeBucket is read only at registration, so registering early locks in the cheapest multiplier (1×) while retaining full fill rights until the deadline — a cheap-early-registration arbitrage. The real deterrent ends up being D-2's forfeiture, not the time multiplier.
- D-4 (Info): getFillRatioBucket/getOrderSizeBucket use floor division and strict < boundaries; no overflow risk (FullMath.mulDiv throughout, total>0 guaranteed by register), so these are calibration choices, not bugs.

Net: D-1 is the one that actually matters — it's a dimensional bug that quietly removes all collateral for any market that isn't WETH-input, and it belongs in the audit alongside C-1/C-2. Want me to add D-1–D-4 to audit.md (with the same cure-vs-backstop tagging)?