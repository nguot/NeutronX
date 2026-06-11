# FillAuction Solvency Invariant

## What this proves

This is a **stateful invariant** test (Foundry's `invariant_*` fuzzing mode),
not a single-scenario test. Instead of one fixed call sequence, Foundry
generates *random sequences* of calls into `FillAuctionHandler` — random
actors, random orders, random amounts, random block rolls, in random order
and random length (up to `depth = 100`, repeated for `runs = 256` distinct
sequences, configured in `foundry.toml`). After **every** call in every
sequence, it checks:

```solidity
address(auction).balance == ghost_activeStake + Σ pendingReturns(everyone)
```

i.e. **FillAuction can never hold less ETH than it owes** (active stakes for
unresolved registrations + everyone's withdrawable `pendingReturns`,
including the treasury's cut of slashes) — and never holds *more* either
(no ETH silently stuck/unaccounted).

This is a **safety/bookkeeping** property: it doesn't say anything about
whether stake *sizes* are economically correct (that's the separate
profitability-bound question), only that the contract's accounting can never
be broken into insolvency by *any* sequence of `register` / `onFillSuccess`
/ `slash` / `withdraw` calls — including adversarial orderings an MEV bot
might try (e.g. registering and immediately trying to slash someone, racing
`withdraw` against `slash`, etc.).

## How it's wired up

- **`FillAuctionHandler.sol`** — the contract Foundry actually calls.
  It's set as `FillAuction`'s `reactor`, so `fill()` can call
  `onFillSuccess` directly without needing a real `PartialFillReactor` or
  signed orders. Each handler function:
  1. Picks an actor / order hash from small fixed pools (4 actors, 3 order
     hashes) — keeps the state space small enough that the fuzzer finds
     interesting *interleavings* rather than getting lost in huge numbers.
  2. Bounds its random inputs to values that satisfy `FillAuction`'s
     preconditions (e.g. `fillAmount <= orderTotal`, `deadline >
     block.number`).
  3. If the action isn't currently valid (e.g. already registered, not yet
     past the slash window), it just `return`s — a no-op call, not a
     revert. This keeps `fail_on_revert` meaningful: any *unexpected*
     revert is a real bug.
  4. Updates ghost state (`ghost_activeStake`, `registered`, `resolved`,
     ...) in lockstep with what `FillAuction` is doing internally.

- **`FillAuctionInvariant.t.sol`** — deploys `FillAuction` (using its
  constructor-default `collateralRate`/`refundTable`, see
  `test/libs/DynamicStakeLibStake.md`), registers the handler as
  `targetContract`, and asserts `invariant_solvency()`.

  Since the collateral/refund split (`onFillSuccess` now pays
  `pendingReturns[filler] += refund` and, if `refund < stakeAmount`,
  `pendingReturns[treasury] += forfeited`), `_stakeFor()` mirrors
  `computeCollateral` (registration-time, no ratio dimension) when sizing
  `register()`'s `msg.value`. The solvency invariant holds unchanged because
  `refund + forfeited == stakeAmount` always — the full registered stake
  still leaves `ghost_activeStake`, just split between two `pendingReturns`
  recipients instead of going entirely to the filler.

## Sanity-checked against a real bug

To make sure this invariant *would* catch a real issue (not just pass
trivially), `slash()`'s `pendingReturns[treasury] += toTreasury;` line was
temporarily removed — i.e. 90% of every slashed stake silently vanishes from
the accounting while staying locked in the contract.

Result: **immediate failure**, shrunk by Foundry to a 3-call repro
(`register` → `roll` past the slash window → `slash`):

```
[FAIL: assertion failed: 18791624115 != 14103084717]
```

Restoring the line makes all 256 runs (25,600 calls) pass again with zero
reverts.

## Running it

```bash
cd contract
forge test --match-path "test/invariant/*.sol" -vv
```
