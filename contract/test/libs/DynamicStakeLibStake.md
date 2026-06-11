# DynamicStakeLib: collateral + refund (Layer 2)

## Why this test exists

The front-running fix in `FillAuction.sol` (see `FrontRunGriefing.md`) changed
`hasValidRegistration` from an **exact match** to a **ceiling**:

```solidity
reg.fillAmount >= uint128(fillAmount)
```

A filler now registers once for `fillAmount = X` and may later fill *any*
amount in `(0, X]`. That's correct and necessary for the front-running fix —
but it changes what "the right registration-time charge" means. Previously a
registration's stake only had to cover the *exact* commitment. Now it
implicitly has to cover the **cheapest possible commitment that the
registration's ceiling also permits**.

The original design (`computeStake`, now removed) was:

```
stake = fillAmount * stakeTable[sizeBucket][ratioBucket(fillAmount, total)] * timeMultiplier
```

`ratioBucket` is a step function of `fillAmount / orderTotal` (buckets 0-4 for
<2%, <10%, <30%, <70%, >=70%). The intent was for `stakeTable` to be
**decreasing** across ratio buckets — small-percentage fills (easy "sniper"
fills) cost a *multiple* of their value, pushing fillers toward large fills.

That intent is fundamentally incompatible with the `>=` ceiling:

- A filler choosing their registered ceiling will always find a cheaper
  bucket that still covers a small intended fill ("ceiling-shopping"), e.g.
  for a $1M order, registering for 71% (rate 0.2x) costs $142k vs registering
  for exactly 1% (rate 20x) costing $200k — yet `>=` lets the 71%
  registration cover a 1% fill anyway. The filler pays *less* for *more*
  flexibility.
- This is forced by the math: at any bucket boundary the fillAmount ratio ->
  1, so any *decrease* in the per-bucket rate is an exploitable discount. No
  arrangement of a decreasing-by-ratio table avoids it.

## The fix: split stake into collateral + refund

`stakeTable` is replaced by two independent mechanisms, each depending only on
a variable that *can't* be gamed in the wrong direction:

- **Registration-time collateral** (`computeCollateral`, paid in `register()`)
  depends on `fillAmount` (the ceiling) x order-size bucket x time bucket
  only — **no ratio dimension**:

  ```
  collateral = fillAmount * collateralRate[sizeBucket(orderTotal)] * timeMultiplier
  ```

  Linear in `fillAmount`, so a larger ceiling is *never* cheaper than a
  smaller one. There's no bucket boundary to dip across — ceiling-shopping is
  structurally impossible.

- **Settlement-time refund** (`computeRefund`, paid out in `onFillSuccess`)
  depends on the *actual* fill ratio:

  ```
  refund = stakeAmount * refundTable[sizeBucket(orderTotal)][ratioBucket(actualFillAmount, orderTotal)]
  ```

  A small actual fill returns only a small fraction of the collateral (the
  rest is forfeited to the treasury as a "sniping fee" via the new
  `StakeForfeited` event); filling >=70% of the order returns it in full.
  Refund non-decreasing in `actualFillAmount` is the *same direction* the
  monotonicity requirement needs — a filler can only get a bigger refund by
  *actually filling more*, so there's no exploit to find here.

`refundTable`'s default values are the per-column-normalized reciprocal of the
original `stakeTable`'s rates (each column divided by its own minimum, which
always sits at ratio bucket 4) — this preserves the original economic intent
(small-% fills are costly relative to their size) while fixing the
ceiling-shopping hole.

`slash()` is unchanged — a no-show (never calls fill) still loses the full
`stakeAmount` (90% treasury / 10% caller).

## Two issues carried over from the original design, still fixed

### 1. Tables must never default to all-zero

`script/Deploy.s.sol` deploys `FillAuction` and wires up the reactor without
calling any setter. `FillAuction`'s constructor seeds both `collateralRate`
and `refundTable` with non-zero, well-formed defaults — an all-zero
`collateralRate` would make registration free (zero collateral, same failure
mode as the old all-zero `stakeTable`); an all-zero `refundTable` would also
fail the "row ends at 10000" check below.

### 2. Boundary-adjacent sampling, not interior sampling

A small dip in a `refundTable` row only shows up for `actualFillAmount`s right
at a bucket transition — interior samples (1%, 5%, 20%, 50%, 100% of
`orderTotal`) can miss it entirely. The fuzz tests below pick, for each ratio
threshold (2%, 10%, 30%, 70%), the largest `actualFillAmount` just *below* the
threshold and the smallest at/above it — consecutive integers straddling the
bucket change, the tightest possible gap.

## What the tests check now

`DynamicStakeLibStakeTest` keeps a hand-picked example `refundTable`/
`collateralRate` *and* a copy of `liveRefundTable`/`liveCollateralRate` — the
actual defaults a freshly-deployed `FillAuction` has. Every check below runs
against both where applicable.

- **`test_refundTable_isMonotonicPerRow` /
  `test_FillAuctionDefaultRefundTable_isMonotonicPerRow`**
  The sufficient, sampling-free property: `refundTable[s][r] <= refundTable[s][r+1]`
  for every size bucket `s` and adjacent ratio buckets `r, r+1`, and
  `refundTable[s][4] == 10000` (a >=70% actual fill always returns the full
  stake).

- **`test_FillAuctionDefaultCollateralRate_isNonZero`**
  Covers issue #1: a freshly-deployed `FillAuction`'s `collateralRate` must
  not be all-zero.

- **`testFuzz_computeRefund_monotonicAtBucketBoundaries` /
  `testFuzz_FillAuctionDefaultRefundTable_computeRefund_monotonicAtBucketBoundaries`**
  Fuzzes `stakeAmount` and `orderTotal`. For each of the 4 ratio thresholds
  (2%, 10%, 30%, 70%), computes the largest `actualFillAmount` just below the
  threshold and the smallest at/above it, and asserts `computeRefund` doesn't
  decrease across that pair. Because `computeRefund` is just
  `stakeAmount * refundTable[s][r] / 10000` for a fixed `stakeAmount`, this is
  a direct (and always-passing, given row-monotonicity) consequence of the
  table-shape check above — it's kept because it exercises the real function
  end-to-end, including `getFillRatioBucket`'s boundary handling.

- **`testFuzz_computeRefund_fullFillReturnsFullStake`**
  `computeRefund(stake, orderTotal, orderTotal, table) == stake` for any
  `stakeAmount`/`orderTotal` — filling 100% always returns everything.

- **`testFuzz_computeCollateral_monotonicInFillAmount`**
  For a fixed `(orderTotal, deadline)`, `computeCollateral` is non-decreasing
  in `fillAmount`. Trivially true for any `collateralRate` (no ratio
  dimension to dip across) — kept as a regression guard against accidentally
  reintroducing one.

- **`test_computeCollateral_noCeilingShoppingDiscount`**
  Replaces the old `test_computeStake_nonMonotonicTable_cheapCeilingLoophole`.
  For a >$1M order, registering for a 71% ceiling costs *exactly* 71x what
  registering for a 1% ceiling costs — never less. (Under the old
  `stakeTable`, 71% cost **less** than 1%: $142k vs $200k.)

- **`test_computeRefund_smallActualFill_forfeitsMostStake`**
  The "sniping fee" in action: filling only 1% of a >$1M order returns just
  1% of the collateral (`refundTable[3][0] == 100` bps); filling >=70% returns
  100%.

## Sanity-checked against a broken refund-table row

Introducing a small dip in `refundTable[0]` (`[1000, 2000, 4000, 3900, 10000]`
— a ~2.5% dip between the 10-30% and 30-70% buckets) makes both the raw-shape
check and the boundary fuzz fail immediately:

```
[FAIL: refund row must be non-decreasing across fill-ratio buckets: 4000 > 3900] test_refundTable_isMonotonicPerRow()
[FAIL: refund must not decrease across a fill-ratio bucket boundary: 3979 > 3880;
 counterexample: args=[9949, 30000]] testFuzz_computeRefund_monotonicAtBucketBoundaries(uint256,uint256)
```

Restoring the well-formed table makes all 9 tests pass again.

## Takeaway

This isn't a contract-logic bug — it's a configuration-time constraint, now
split across two tables with two different (and individually trivial)
shapes:

1. `collateralRate` must never be all-zero (now enforced by the constructor
   default) — it has no ratio dimension, so there's nothing else to check.
2. Every row `refundTable[sizeBucket][0..4]` must be non-decreasing and end at
   `10000` (checked directly, plus its consequence for `computeRefund` at
   every bucket boundary).

Anyone proposing new `collateralRate`/`refundTable` values via
`setCollateralRate`/`setRefundTable` should run this suite against the
proposed values first.

## Running it

```bash
cd contract
forge test --match-path "test/libs/DynamicStakeLibStake.t.sol" -vv
```
