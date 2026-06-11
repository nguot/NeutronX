# Front-Running Griefing Fix — `FillAuction`

## The vulnerability

To call `PartialFillReactor.executePartialChunk(order, fillAmount)`, a filler
must first `register()` with `FillAuction` and post a stake sized by
`DynamicStakeLib` (bigger fill ratio / order size / urgency → bigger stake).

Two checks used to make registration **brittle**:

- `FillAuction.hasValidRegistration()` required an **exact match**:
  `reg.fillAmount == fillAmount`.
- `FillAuction.onFillSuccess()` required the actual fill to be **at least
  90%** of the registered amount, or it reverted `"filled too little"`.

### Attack

1. Filler **A** registers to fill **100%** of a 1000 USDC order, paying the
   large "70-100% fill ratio" stake, and broadcasts
   `executePartialChunk(order, 1000 USDC)`.
2. A bot sees this, registers a **cheap small-bucket stake** for an 11%
   fill, and front-runs A with `executePartialChunk(order, 110 USDC)`.
3. The order's `remaining` drops to 890 USDC (89%). A's transaction now
   needs `fillAmount == 890`, but A is registered for `1000` —
   `hasValidRegistration` returns `false` → **A's tx reverts forever**
   (`remaining` only ever decreases, so `1000` can never match again).
4. A is stuck: already registered (can't re-register), can never
   successfully fill. After `deadline + SLASH_WINDOW`, **anyone** calls
   `slash()`: A loses their *entire* 100%-bucket stake — 10% goes to the
   caller (the bot), 90% to the treasury.

The bot risked a tiny stake for a tiny fill and collected a slashing reward
funded by A's much larger stake. Note this isn't fixed by making the
`stakeTable` more granular — the bug is that `1000 != 890`, regardless of
how the buckets are sized.

## The fix

Two edits in `contract/src/FillAuction.sol`:

1. **`hasValidRegistration`**: `reg.fillAmount == uint128(fillAmount)` →
   `reg.fillAmount >= uint128(fillAmount)`. The registered amount becomes a
   **ceiling**: a filler can complete for whatever `remaining` actually is,
   as long as it's no more than what they registered for.
2. **`onFillSuccess`**: removed the 90%-of-registration `minAcceptable`
   check that used to revert `"filled too little"`. `executePartialChunk`
   already guarantees `fillAmount > 0` via its own `_minFill` check, so any
   successful fill fully resolves the registration — but the **refund** it
   returns now scales with how much was actually filled
   (`computeRefund(stakeAmount, actualFillAmount, orderTotal, refundTable)`,
   see `test/libs/DynamicStakeLibStake.md`): >=70% actual fill returns the
   full collateral, smaller fills return progressively less, with the rest
   forfeited to the treasury via `StakeForfeited`.

After the fix, a filler whose registration's ceiling no longer matches
`remaining` (because someone else front-ran part of the order) can still
resolve their registration instead of being stuck and eventually slashed.
Slashing now applies to fillers who register and then **never attempt a fill
at all** before `deadline + SLASH_WINDOW` (fake-liquidity signaling) *or* who
only manage a small actual fill (most of their collateral is forfeited as a
"sniping fee" rather than slashed outright).

## The test — `FrontRunGriefing.t.sol`

- **`test_frontRun_11pct_concreteExample`**: replays the exact scenario
  above (A registers 100%, bot front-runs 11%, A completes the remaining
  89%). A's 89% actual fill is >=70% -> full refund, so A recovers their
  entire `1 ether` deposit. The bot's 11% actual fill lands in the 10-30%
  refund bucket -> only a partial refund, with the rest forfeited to the
  treasury. Also asserts `slash(A)` now reverts with `"invalid state"`.
- **`testFuzz_frontRun_fillerRefundMatchesActualFillRatio`**: same scenario,
  fuzzing the bot's front-run size across 1%-99% of the order. For every
  size, A completes for whatever remains (no "not registered" /
  "filled too little" revert) and A's `pendingReturns` matches
  `(1 ether - stakeA) + refund(stakeA, remainingAmount, INPUT_AMOUNT)` — a
  full refund when the remainder is >=70% of the order, a partial one
  otherwise.

### Proving it actually catches the bug

Both tests were run against the **pre-fix** code (exact-match
`hasValidRegistration` + 90% `onFillSuccess` check) and both fail with
`"not registered"` for every front-run size — confirming the tests exercise
the fixed code paths, not just the existing happy path.

### Running it

```bash
cd contract
forge test --match-path "test/FrontRunGriefing.t.sol" -vv
```
