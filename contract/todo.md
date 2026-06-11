# TODO: split stake into registration collateral + fill-based refund

## Background

`DynamicStakeLibStake.t.sol` / `.md` showed that the original 2D
`base_multiplier` table (fill_ratio x order_size, decreasing across
fill-ratio buckets — small fill % = high multiplier) cannot be used as a
*registration-time* charge under the `>=` ceiling fix
(`hasValidRegistration`, see `FrontRunGriefing.md`):

- A filler choosing their registered ceiling will always find a cheaper
  bucket that still covers a small intended fill ("ceiling-shopping"), e.g.
  for a $1M order, registering for 71% (0.2x) costs $142k vs registering for
  exactly 1% (20x) costing $200k — yet `>=` lets the 71% registration cover a
  1% fill anyway.
- This is forced by the math: at any bucket boundary the fillAmount ratio
  -> 1, so any *decrease* in the per-bucket rate is an exploitable discount.
  No arrangement of a decreasing-by-ratio table avoids it.

Resolution: split the single `stakeTable` into two mechanisms that each only
depend on a variable that *can't* be gamed in the wrong direction:

- **Registration-time collateral** — depends on `fillAmount` (ceiling) x
  order-size bucket x time bucket only. No ratio dimension, so nothing to
  ceiling-shop (collateral is linear in the ceiling).
- **Settlement-time refund** (`onFillSuccess`) — depends on
  `actualFillAmount`'s ratio bucket. Small actual fill -> low refund (most of
  collateral forfeited to treasury as a "sniping fee"); fill >=70% -> full
  refund. Refund non-decreasing in `actualFillAmount` is the *same direction*
  the monotonicity requirement needs, so no exploit exists here.

`slash()` is unchanged — a no-show (never calls fill) still loses the full
`stakeAmount` (90% treasury / 10% caller), same as today.

## Derived numbers (done)

**Refund table** (`refundTable[sBucket][rBucket]`, bps of `stakeAmount`
returned) — per-column-normalized reciprocal of the original table, see chat
for derivation:

```solidity
refundTable[0] = [500,  1000, 2500, 5000, 10000]; // <$10k
refundTable[1] = [333,  1000, 2000, 5000, 10000]; // $10k-100k
refundTable[2] = [100,  333,  1000, 3333, 10000]; // $100k-1M
refundTable[3] = [100,  200,  667,  2000, 10000]; // >$1M
```

Each row is non-decreasing by construction (r4 == 10000 always). This
*replaces* the current `stakeTable` storage (same `uint32[5][4]` shape,
same setter signature) — just reinterpreted as "bps returned" instead of
"bps charged".

**Collateral rate** (`collateralRate[sBucket]`, bps) — PLACEHOLDER, taken
from the original table's "10-30%" row (a middle-of-the-road fill ratio) as
a starting point, needs calibration:

```solidity
collateralRate = [2000, 5000, 10000, 30000]; // <$10k, $10k-100k, $100k-1M, >$1M
```

`collateral = fillAmount(ceiling) * collateralRate[sBucket(orderTotal)] * timeMult(tBucket) / 1e8`

Open question: is this collateral big enough that a 99%-forfeiture (1%
actual fill on a >$1M order) is a meaningful absolute deterrent, or does it
need its own scaling pass? Worth a fuzz/back-of-envelope check before
finalizing.

## Contract changes

- [x] `src/libs/DynamicStakeLib.sol`
  - [x] Add `computeCollateral(fillAmount, orderTotal, deadline, collateralRate)`
        — like `computeStake` but indexes `collateralRate[sBucket]` only (no
        `rBucket`/`getFillRatioBucket` call).
  - [x] Add `computeRefund(stakeAmount, actualFillAmount, orderTotal, refundTable)`
        — `rBucket = getFillRatioBucket(actualFillAmount, orderTotal)`,
        return `stakeAmount * refundTable[sBucket][rBucket] / 10000`.
  - [x] Keep `getOrderSizeBucket`, `getFillRatioBucket`, `getTimeBucket`,
        `_getTimeMultiplier` as-is — all reused. (`computeStake` removed.)

- [x] `src/FillAuction.sol`
  - [x] `Registration` struct: add `uint128 orderTotal` (needed by
        `onFillSuccess` to compute `rBucket(actualFillAmount, orderTotal)` —
        currently not stored anywhere).
  - [x] Replace `uint32[5][4] public stakeTable` with `uint32[5][4] public
        refundTable` (reinterpreted as "bps returned") plus a new
        `uint32[4] public collateralRate` seeded with the placeholder above.
  - [x] `setStakeTable` -> `setRefundTable(sBucket, rBucket, bps)`; added
        `setCollateralRate(sBucket, bps)`, both `onlyOwner`.
  - [x] `register()`: `required = computeCollateral(fillAmount, orderTotal,
        deadline, collateralRate)` instead of `computeStake`. Stores
        `orderTotal` in the registration.
  - [x] `onFillSuccess(orderHash, filler, actualFillAmount)`: now uses
        `actualFillAmount` via `computeRefund`, splitting `stakeAmount`
        between `pendingReturns[filler]` (refund, `StakeReturned`) and
        `pendingReturns[treasury]` (forfeited, new `StakeForfeited` event,
        only emitted if `forfeited > 0`).
  - [x] Constructor seeds both `refundTable` (table above) and
        `collateralRate` (placeholder above) — keeps the "never deploy with
        an all-zero/free table" guarantee from the earlier fix.

- [x] `script/Deploy.s.sol` — no change needed; constructor defaults are
      sufficient (per the earlier all-zero-table fix pattern).

## Tests

- [x] `test/libs/DynamicStakeLibStake.t.sol` (rewritten, see updated
      `DynamicStakeLibStake.md`):
  - [x] `refundTable` row-monotonicity check (non-decreasing across
        `rBucket`, `r4 == 10000`), for both a hand-picked example and
        `FillAuction`'s live default.
  - [x] Boundary-adjacent fuzz: for fixed `stakeAmount`/`orderTotal`,
        `computeRefund(actualFillLo) <= computeRefund(actualFillHi)` across
        each ratio threshold (2/10/30/70%), for both tables.
  - [x] `computeCollateral` fuzz: monotonic in `fillAmount` for any
        `(fillAmount1, fillAmount2)` pair — no boundary cases needed (linear).
  - [x] Retired `test_computeStake_nonMonotonicTable_cheapCeilingLoophole`,
        replaced with `test_computeCollateral_noCeilingShoppingDiscount`
        (71% ceiling costs *exactly* 71x a 1% ceiling, never less) and
        `test_computeRefund_smallActualFill_forfeitsMostStake` (1% actual
        fill on a >$1M order keeps only 1% of collateral).
  - [x] `test_FillAuctionDefaultCollateralRate_isNonZero` — covers the
        all-zero-collateral failure mode.
- [x] `test/FillAuction.t.sol` — `STAKE` recomputed for the new
      `collateralRate` (80e6), `setStakeTable` loop removed,
      `onFillSuccess` tests rewritten for the refund/forfeiture split
      (50% refund at 40% actual fill, 5% refund at 1%, 100% refund at >=70%).
- [x] `test/FrontRunGriefing.t.sol`/`.md` — `setStakeTable` calls removed,
      added `_collateral`/`_refund` test helpers, both the concrete example
      and the fuzz test now assert `pendingReturns` against
      `(deposit - stake) + refund(...)`.
- [x] `test/invariant/FillAuctionHandler.sol` (`_stakeFor`) and
      `test/invariant/FillAuctionInvariant.t.sol`/`.md` — updated for
      `computeCollateral`/constructor defaults; `invariant_solvency` still
      passes (256 runs / 25,600 calls, 0 reverts).

## Consumers (filler/solver)

These used to read `stakeTable(sBucket, rBucket)` to predict `register()`'s
required `msg.value`, and called `FillAuction.register(...)` directly:
- [x] `filler/CoWFiller/src/contract/abis.ts`, `src/dev/devFill.ts`,
      `src/execution/executor.ts` — migrated to `collateralRate(sBucket)` +
      `reactor.register(order, fillAmount)`.
- [x] `filler/WhaleFiller/src/contract/abis.ts`, `src/dev/devFill.ts`,
      `src/execution/executor.ts` — same migration.
- `filler/solver/src/contract/abis.ts`, `src/execution/executor.ts` — **not
  migrated**. `solver` is example/demo code, never used in the real flow
  (per user); left on the old `stakeTable`/`FillAuction.register(...)` API
  and will revert on-chain (`"only reactor"`) if ever run against the current
  contracts.

- [x] Switch `CoWFiller`/`WhaleFiller` to `collateralRate(sBucket)` (no
      `rBucket` needed for registration prediction — simpler than before).
- [ ] Optional: surface `refundTable`/expected refund in profitability
      calcs (filler can estimate "if I only fill X%, I get Y% back").
- [x] **Registration forgery fix** (see `exploit.md`): `register()` is no
      longer callable on `FillAuction` directly — `CoWFiller`/`WhaleFiller`
      now call `PartialFillReactor.register(order, fillAmount)`, which
      derives `orderTotal`/`deadline` from `order.info` itself.

## Open questions for next session

- [ ] Calibrate `collateralRate` (placeholder = original table's 10-30% row)
      — is the absolute forfeiture amount (collateral x (1 - refundBps))
      a meaningful deterrent across order sizes?
- [ ] Should `collateralRate` also incorporate the time dimension at
      registration only (already planned via `timeMult`), or should refund
      *also* depend on time-since-registration somehow? (Original "Chiều 3"
      was registration-time only — keep as-is unless a reason emerges.)
- [ ] Decide on renaming `stakeTable` -> `refundTable` (storage slot /ABI
      change) vs. keeping the name for backwards compatibility with any
      already-deployed instances (likely fine to rename — nothing deployed
      to a real network yet per `Deploy.s.sol` review).
