# NeutronX — Smart-Contract Test Catalogue (Detailed)

> Verified against a full `forge test` run on **2026-06-29**. Supersedes `testcase.md`,
> whose headline numbers had drifted. Every test below is named exactly as it appears in
> the suite, with a one-line statement of the property it pins down. Where a test maps to a
> security finding in `audit.md` / `crosschain.md`, the finding tag is given.

---

## 0. Status at a glance

| | Count | Result |
|---|---|---|
| **Total tests** | **149** | all pass |
| Test suites (contracts) | **24** | — |
| Non-fork (deterministic, no network) | **137** | all pass |
| Fork (mainnet, need `ALCHEMY_RPC_URL`) | **12** | all pass on a healthy RPC; can be transiently flaky on live-pool drift / RPC timeout |

Fork suites: `FallbackExecutor.t.sol` (9), `TwapCollateral.t.sol` (2), `TwapManipulation.t.sol` (1).
All three call `vm.createSelectFork(vm.envString("ALCHEMY_RPC_URL"))`.

Test-type prefixes: `test_*` = unit · `testFuzz_*` = property/fuzz (256 runs) · `invariant_*` = stateful invariant (256 runs × 100 calls).

### What changed since `testcase.md`

| Item | `testcase.md` said | Actual now |
|---|---|---|
| Total | 145 | **149** |
| Non-fork / fork split | 133 / 12 | **137 / 12** |
| `FallbackExecutor` | 3 tests | **9** (rewritten around an allowlisted/mock router + signed-floor + cumulative-floor + refund-leftover + owner-gate) |
| `FeeOnTransfer.t.sol` | not present | **2 (new)** — Trufy 3.2 balance-delta accounting |
| `MinFillRemainder.t.sol` | not present | **2 (new)** — minFill tail-completion exemption |
| `EscrowSrcFactory` | 10 tests | **12** (adds the single-cosigner-key pair) |

---

## 1. How to run

```bash
cd contract
# Foundry lives in WSL (no forge on the Windows PATH):
wsl.exe bash -lc 'export PATH="$HOME/.foundry/bin:$PATH"; cd /mnt/c/Users/vutie/Documents/DATN/dex-aggregator/contract && forge test --summary'

# Deterministic suites only (no RPC needed):
forge test --no-match-path 'test/{FallbackExecutor,TwapCollateral,TwapManipulation}.t.sol'

# Include the mainnet-fork suites:
export ALCHEMY_RPC_URL=<mainnet rpc>
forge test

# One suite, verbose:
forge test --match-path 'test/adversarial/*' -vvv
```

---

## 2. Suites by category

### 2.1 Library unit tests — `test/libs/` (40 tests)

Pure arithmetic of the staking / pricing / accounting primitives. All deterministic.

**`DecayCursorLib.t.sol`** — Dutch-auction price-decay cursor (5)
| Test | Proves |
|---|---|
| `test_init_getCurrentPrice_sameBlock` | price == startPrice on the init block |
| `test_getCurrentPrice_afterNBlocks` | linear decay `startPrice − n·decay` |
| `test_getCurrentPrice_fullyDecayed` | clamps to 0, never underflows |
| `test_reset_resetsPrice` | reset moves the price anchor |
| `test_reset_keepsDecayPerBlock` | reset preserves the slope |

**`DynamicStakeLib.t.sol`** — bucketing helpers (15)
| Test group | Proves |
|---|---|
| `test_fillRatio_{edgeCase_fullFill, overFill, bucket0..bucket4}` (7) | every fill-ratio boundary (0–4 + full + over-fill) classifies into the right bucket |
| `test_orderSize_{bucket0..bucket3}` (4) | the 4 order-size tiers classify correctly |
| `test_timeBucket_{farFromDeadline, close, veryClose, expired}` (4) | the 4 time-to-deadline tiers classify correctly |

**`DynamicStakeLibStake.t.sol`** — collateral/refund economics (9, incl. fuzz)
| Test | Proves |
|---|---|
| `testFuzz_computeCollateral_monotonicInFillAmount` | collateral never decreases as the ceiling grows — no "ceiling-shopping" discount |
| `testFuzz_computeRefund_monotonicAtBucketBoundaries` | refund non-decreasing across every fill-ratio boundary |
| `testFuzz_FillAuctionDefaultRefundTable_computeRefund_monotonicAtBucketBoundaries` | same, against the *deployed* default table |
| `testFuzz_computeRefund_fullFillReturnsFullStake` | a ≥70% fill always returns 100% of the stake |
| `test_computeCollateral_noCeilingShoppingDiscount` | cost scales exactly with the ceiling |
| `test_computeRefund_smallActualFill_forfeitsMostStake` | a small fill-ratio returns little (table shape; lib is denominator-agnostic) |
| `test_refundTable_isMonotonicPerRow` | a generic table is well-shaped per row |
| `test_FillAuctionDefaultRefundTable_isMonotonicPerRow` | the deployed default table is well-shaped |
| `test_FillAuctionDefaultCollateralRate_isNonZero` | the deployed default rates are non-zero |

**`RemainingLib.t.sol`** — packed remaining-amount encoding (6)
`test_remaining_{newOrder, fullyFilled, partial}`, `test_fullyFilled`, `test_isNewOrder`, `test_pack_unpack_roundtrip` — the new-order / partial / fully-filled sentinels and pack/unpack round-trip.

**`ScaledOutputLib.t.sol`** — proportional vs last-fill output scaling (5)
`test_nonLastFill_proportional`, `test_nonLastFill_partial`, `test_lastFill_returnsRemainder`, `test_lastFill_noRounding_dust`, `test_lastFill_alreadyPaidZero` — proportional scaling, last-fill remainder absorption, dust handling.

---

### 2.2 Core contract tests (27 tests)

**`FillAuction.t.sol`** — staking lifecycle (18)
| Test | Proves |
|---|---|
| `test_register_success` | happy-path registration records the stake |
| `test_register_refundsExcess` | `msg.value` above the required stake is credited back as `pendingReturns` |
| `test_register_revert_deadlinePassed` | registering past the order deadline reverts |
| `test_register_revert_alreadyRegistered` | a filler can't double-register the same order |
| `test_register_revert_insufficientStake` | `msg.value` below the required collateral reverts |
| `test_register_revert_onlyReactor` | only the reactor may call `register` (forgery guard) |
| `test_slash_success` | an abandoned registration past `deadline + SLASH_WINDOW` is slashable; 10% to caller, rest to treasury |
| `test_slash_revert_tooEarly` | slashing before the window closes reverts |
| `test_slash_revert_alreadyFilled` | a filled registration cannot be slashed |
| `test_withdraw_success` | `pendingReturns` is withdrawable |
| `test_withdraw_revert_nothingToWithdraw` | withdrawing a zero balance reverts |
| `test_onFillSuccess_fullCommitment_refundsFullStake` | **D-2** honouring the full commitment returns 100% |
| `test_onFillSuccess_underDelivery_refundsHalfStake` | **D-2** ~40% of commitment → ~50% refund |
| `test_onFillSuccess_tinyDelivery_forfeitsMostStake` | **D-2** ~2.5% of commitment → ~10% refund |
| `test_onFillSuccess_shrunkRemainder_fullRefund` | **Trufy 3.5** consuming the entire live remainder → full stake, even at a 2.5% raw fill |
| `test_onFillSuccess_underDelivery_withFullRemainder_stillPenalised` | **Trufy 3.5** when volume *was* available, under-delivery is still penalised (no sniping loophole) |
| `test_hasValidRegistration_allowsSmallerFillAmount` | a registration covers any fill ≤ its ceiling |
| `test_hasValidRegistration_revert_largerFillAmount` | a fill above the registered ceiling is rejected |

**`PartialFillReactor.t.sol`** — fill flow (6)
`test_firstFill_success`, `test_multipleFills_remainingDecreases`, `test_onFillSuccess_called`, and reverts `test_fill_revert_{notRegistered, expired, fillExceedsRemaining}` — first-fill init, remaining decrement, auction callback wiring, and the three fill guards.

**`RegistrationForgery.t.sol`** — the prior forgery exploit stays fixed (3)
| Test | Proves |
|---|---|
| `test_register_revert_onlyReactor` | `register` is reactor-gated |
| `test_reactorRegister_derivesOrderTotalAndDeadlineFromRealOrder` | orderTotal/deadline come from the hashed order, not caller input |
| `test_forgedOrderInfo_decouplesRegistrationFromRealOrder` | a tampered `OrderInfo` hashes to a different order and is unusable against the real one |

---

### 2.3 Guard / branch / edge-case batch (34 tests)

**`CoreGuards.t.sol`** — protective-shell revert arms (25). High-value because `forge coverage` under-counts `require(cond,"msg")` branches; these assert each revert string explicitly.
- FillAuction owner/one-time guards: `test_setReactor_revert_{notOwner, alreadySet, zero}`, `test_setCollateralRate_{revert_notOwner, revert_badBucket, revert_rateTooHigh, success}`, `test_setRefundTable_revert_{notOwner, badSizeBucket, badRatioBucket, tooHigh}` (**L-2** bounds).
- `register` input guards: `test_register_revert_{zeroFill, fillExceedsTotal, fillTooLarge, totalTooLarge, stakeTooLarge}` (**L-2** uint128/width).
- Reactor guards: `test_setFallbackExecutor_revert_{alreadySet, zero}`, `test_markFallbackInitiated_revert_{notFallbackExecutor, cancelled}`, `test_cancelOrder_revert_{notSwapper, alreadyCancelled}`, `test_register_revert_cancelled`, `test_executePartialChunk_revert_{belowMinFill, cancelled}`.

**`FillAuctionTerminalState.t.sol`** — double-settlement matrix (3). The three terminal states (`filled`/`slashed`/`released`) are mutually exclusive and each credits `pendingReturns` exactly once.
| Test | Proves |
|---|---|
| `test_terminal_filled_blocksAllOtherSettlements` | after `onFillSuccess`, slash/release/refill revert; refund+forfeit == stake |
| `test_terminal_slashed_blocksAllOtherSettlements` | after `slash`, no second settlement; reward+treasury == stake |
| `test_terminal_released_blocksAllOtherSettlements` | after `releaseRegistration`, no second settlement; full stake returned once |

**`CompletionFloor.t.sol`** — absolute min-output backstop (2). **C-1.**
| Test | Proves |
|---|---|
| `test_completionBelowAbsoluteFloor_reverts` | per-chunk pro-rata floors can sum below the signed minimum; completion reverts `"min output total"` |
| `testFuzz_completedOrder_neverBelowSignedFloor` | for any split + non-decaying price, a *completed* order always paid ≥ `minOutputAmount` |

**`MinFillRemainder.t.sol`** — minFill tail exemption (2, **new**).
| Test | Proves |
|---|---|
| `test_tailBelowMinFill_completesOrder` | a tail smaller than `minFillBps` is allowed *iff* it fills the entire remainder (completing is always allowed) |
| `test_nonCompletingChunkBelowMinFill_stillReverts` | a sub-minFill chunk that does *not* complete still reverts `"fill < minimum"` |

**`FeeOnTransfer.t.sol`** — balance-delta output accounting (2, **new**). **Trufy 3.2.**
| Test | Proves |
|---|---|
| `test_feeOnTransferOutput_belowFloor_reverts` | a fee-on-transfer output token that nets the swapper below `minChunk` reverts — the floor is checked on *received*, not nominal |
| `test_feeOnTransferOutput_aboveFloor_creditsActualReceived` | when the post-fee receipt still clears the floor, accounting uses the measured balance delta |

**`FrontRunGriefing.t.sol`** — honest-filler protection (2, incl. fuzz). **Trufy 3.5.**
| Test | Proves |
|---|---|
| `test_frontRun_11pct_concreteExample` | a worked example: front-run remainder shrink, honest filler still keeps full stake |
| `testFuzz_frontRun_honestFillerKeepsFullStake` | for any front-run size, the honest filler is never griefed into forfeiture |

**`Settleability.t.sol`** — (1) `testFuzz_alwaysSettleable`: **M-1** for any decay curve + partition, the order always settles (no underflow / brick on the final fill).

---

### 2.4 Stateful invariant — `test/invariant/` (1)

**`FillAuctionInvariant.t.sol → invariant_solvency`** — across any random sequence of register / fill / slash / withdraw / roll, contract balance == `Σ active stakes + Σ pendingReturns`. Money is never created or destroyed.

---

### 2.5 Security-fix regression — `test/AuditFixes.t.sol` (8)

| Test | Finding |
|---|---|
| `test_C1_tamperedStartPrice_rejected` | **C-1** signed price curve — tampering reverts |
| `test_C1_minOutputFloor_enforced` | **C-1** swapper's min-output floor enforced |
| `test_C2_fallbackBlocksPartialFill` | **C-2** fallback ⇄ fill mutual exclusion + remaining zeroed |
| `test_H1_loserReclaimsStake_andCannotBeSlashed` | **H-1** race loser reclaims full stake; not slashable |
| `test_H2_cancelledOrder_notSlashable_reclaimable` | **H-2** cancelled-order stake reclaimable, not slashable |
| `test_L3_invalidateNonce_blocksFill` | **L-3** nonce invalidation stops fills |
| `test_33_invalidatedNonce_notSlashable_butReleasable` | **Trufy 3.3** nonce invalidation is terminal — can't be slashed, reclaims full stake |
| `test_34_setFallbackExecutor_onlyOwner` | **Trufy 3.4** `setFallbackExecutor` is owner-gated |

---

### 2.6 Adversarial / MEV — `test/adversarial/` (11). Thesis centrepiece; deterministic, no fork.

**`MevFillerExploits.t.sol`** — malicious filler call-sequences (10)
| Test | MEV filler tries → outcome |
|---|---|
| `test_tamperStartPrice_rejected` | rewrite signed price → **reverts** (`invalid sig`) |
| `test_fillBelowMinOutput_reverts` | pay swapper below floor → **reverts** (`min output`) |
| `test_lateFill_skimsDecaySpread_butStaysAboveFloor` | time the decay to underpay → **succeeds but bounded** ≥ floor |
| `test_lateFill_belowFloor_reverts` | wait past the floor → **reverts**, swapper protected |
| `test_frontRunRace_loserReclaimsFullStake` | win the chunk → legit; **loser reclaims 100%** |
| `test_snipeSmallChunk_fullyRefunded` | grab a 1% chunk, deliver fully → **full refund** (D-2) |
| `test_minFillBps_blocksDustFill` | dust fill below `minFillBps` → **reverts** |
| `test_registerThenAbandon_isSlashed_noProfit` | reserve then vanish → **slashed, recovers nothing** |
| `test_fillAfterFallback_reverts` | double-spend across fallback → **reverts** (`fallback initiated`) |
| `test_reentrantOutputToken_reverts` | re-enter via malicious output token → **reverts** (`nonReentrant`) |

**`MultiOrderScenario.t.sol`** — `test_population_honestAndMev_invariantsHold` (1): 3 swappers, 3 orders, 2 honest + 1 MEV filler over several blocks; asserts every swapper filled ≥ floor, token conservation, race-loser lost nothing, nothing wrongly forfeited, FillAuction solvency, funds withdrawable.

---

### 2.7 Cross-chain escrow — `test/crosschain/` (13)

**`EscrowSrcFactory.t.sol`** — multi-slot source escrow (12)
| Test | Proves |
|---|---|
| `test_fillSlot_then_withdraw_paysFiller` | fill → withdraw(secret) pays the filler input + safety deposit |
| `test_fillSlot_secondTime_revertsSlotAlreadyFilled` | a slot can be filled once; the bitmap blocks a re-fill |
| `test_fillSlot_invalidProof_reverts` | a (hashlock, slotIndex) not in the Merkle root reverts *before* any funds move |
| `test_fillSlot_invalidSwapperSig_reverts` | a bad swapper signature reverts order creation |
| `test_fillSlot_perSessionCosignerKey_reverts` | **Trufy (final) 3.1** a per-session cosigner key is rejected — only the immutable server key is accepted |
| `test_fillSlot_singleCosigner_servesMultipleSwappers` | **Trufy (final) 3.1** one cosigner key validly serves many swappers/orders |
| `test_cancel_afterExpiry_refundsSwapper_andPaysSwapperDeposit` | cancel-after-expiry refunds the swapper *and* routes the safety deposit to the swapper (no self-cancel reclaim) |
| `test_fillSlot_zeroSafetyDeposit_reverts` | **Trufy 3.7** zero deposit reverts `"deposit below floor"` |
| `test_fillSlot_dustSafetyDeposit_reverts` | **Trufy 3.7** `MIN_SAFETY_DEPOSIT − 1` also reverts |
| `test_fillSlot_zeroSlotAmount_reverts` | **Trufy 3.8** `inputAmount < numSlots` reverts at creation, before funds move |
| `test_reopenSlot_beforeCancel_reverts` | **M-3** can't reopen a live slot |
| `test_reopenSlot_afterCancel_clearsBitmapAndBumpsAttempt` | **M-3** reopen after cancel clears the bit + bumps attempt → fresh clone address |

**`CrossChainTimelock.t.sol`** — `test_T2geqT1_swapperTakesBothLegs` (1): **PoC**, not a passing-guard. The `T2 < T1` invariant is *commented, not enforced on-chain*, and expressed in cross-chain-incomparable `block.number`. With `T2 ≥ T1` (both factories accept it), the swapper reclaims the source leg via `EscrowSrc.cancel()` **and** collects the destination leg via `EscrowDst.claim()`, while the filler recovers nothing. The PoC **passes by design** — the on-chain contracts are intentionally left as-is; **Trufy 3.1** is mitigated off-chain in `escrowDstWatcher` (refuses to reveal the secret for any destination escrow whose expiry exceeds `deadline − t2Buffer`). Trustless fix = timestamp expiries + enforced gap (future work).

---

### 2.8 Fork tests (mainnet — need `ALCHEMY_RPC_URL`) (12)

**`FallbackExecutor.t.sol`** — aggregator fallback path (9)
| Test | Proves |
|---|---|
| `test_fallback_swapsSuccessfully_viaArbitraryAllowlistedRouter` | happy path through an allowlisted aggregator; swapper paid, remaining zeroed |
| `test_fallback_revert_belowSignedFloor` | **C-1** output below the swapper's signed pro-rata floor reverts `"below signed min output"` |
| `test_fallback_revert_insufficientOutput` | output below the solver's own `minAmountOut` reverts `"insufficient output"` |
| `test_fallback_revert_tooEarly` | outside `FALLBACK_WINDOW` reverts `"too early"` |
| `test_fallback_revert_expired` | past deadline reverts (sig/expiry checked first) |
| `test_fallback_revert_routerNotAllowed` | a non-allowlisted router reverts `"router not allowed"` |
| `test_fallback_refundsUnconsumedInput` | **C-4** an exact-output route leaves leftover input → refunded to swapper |
| `test_fallback_revert_cumulativeBelowAbsoluteFloor` | **C-3** cumulative paid (partials + fallback) below absolute `minOutputAmount` reverts |
| `test_setRouterAllowed_onlyOwner` | the router allowlist is owner-gated |

**`TwapCollateral.t.sol`** — D-1 oracle works for any token (2)
| Test | Proves |
|---|---|
| `test_wethInput_isOneToOne` | WETH input short-circuits the oracle 1:1 |
| `test_usdcInput_pricedViaTwap` | USDC is priced via the V3 TWAP into ETH-scale collateral, growing with fill size |

**`TwapManipulation.t.sol`** — `test_manipulatedTwap_collapsesRequiredCollateral` (1): **PoC for N-3.** Dumps USDC into the same `(USDC,WETH,0.05%)` pool the oracle reads, holds price across the 60 s window; required stake for a 3000-USDC order collapses ~0.905 ETH → ~4.6e-6 ETH (−100%). Demonstrates the short-window collateral-collapse failure mode (same class as Mango/Cream/Harvest). Quantified further by Part C of `TESTING_NEXT_STEPS.md`.

---

## 3. Finding → test matrix

| Finding | Covered by |
|---|---|
| C-1 price auth + min-output | `AuditFixes::test_C1_*`, `MevFiller::test_tamperStartPrice_rejected` / `test_fillBelowMinOutput_reverts` / `test_lateFill_*`, `CompletionFloor::*`, `FallbackExecutor::test_fallback_revert_belowSignedFloor` |
| C-2 fallback / fill mutual exclusion | `AuditFixes::test_C2_*`, `MevFiller::test_fillAfterFallback_reverts`, `CoreGuards::test_markFallbackInitiated_*` |
| C-3 fallback cumulative floor | `FallbackExecutor::test_fallback_revert_cumulativeBelowAbsoluteFloor` |
| C-4 fallback leftover refund | `FallbackExecutor::test_fallback_refundsUnconsumedInput` |
| H-1 race-loser stake recovery | `AuditFixes::test_H1_*`, `MevFiller::test_frontRunRace_*`, `MultiOrderScenario`, `FillAuctionTerminalState::test_terminal_released_*` |
| H-2 cancel-grief protection | `AuditFixes::test_H2_*`, `CoreGuards::test_*cancelled*` |
| M-1 per-fill pricing (no underflow) | `PartialFillReactor::test_multipleFills_*`, `Settleability::testFuzz_alwaysSettleable` |
| M-2 refund snapshot | `FillAuction::test_onFillSuccess_*`, `DynamicStakeLibStake` |
| M-3 register validates sig / reopen lifecycle | `RegistrationForgery`, `EscrowSrcFactory::test_reopenSlot_*` |
| L-2 cast / setter bounds | `CoreGuards::test_setCollateralRate_*` / `test_setRefundTable_*` / `test_register_revert_{fillTooLarge,totalTooLarge,stakeTooLarge}` |
| L-3 nonce invalidation | `AuditFixes::test_L3_invalidateNonce_blocksFill` |
| D-1 ETH-denominated collateral | `TwapCollateral` (fork), `DynamicStakeLibStake` |
| D-2 refund keyed to committed | `MevFiller::test_snipeSmallChunk_fullyRefunded` / `test_minFillBps_blocksDustFill`, `FillAuction::test_onFillSuccess_*`, `FrontRunGriefing` |
| N-3 TWAP collateral manipulation | `TwapManipulation::*` (fork PoC) |
| Cross-chain timelock (`crosschain.md §4`) | `CrossChainTimelock::test_T2geqT1_swapperTakesBothLegs` (PoC); off-chain `escrowDstWatcher` |
| Trufy 3.1 timelock ordering | off-chain `escrowDstWatcher` expiry guard; PoC `CrossChainTimelock::*` |
| Trufy 3.2 fee-on-transfer / received accounting | `FeeOnTransfer::*` |
| Trufy 3.2 src/dst filler binding | off-chain `escrowDstWatcher` filler-match guard (no Foundry test) |
| Trufy 3.3 nonce-invalidation stranding | `AuditFixes::test_33_*` |
| Trufy 3.4 setFallbackExecutor takeover | `AuditFixes::test_34_*` |
| Trufy 3.5 honest-filler forfeiture | `FillAuction::test_onFillSuccess_shrunkRemainder_*` / `*_stillPenalised`, `FrontRunGriefing::testFuzz_*` |
| Trufy 3.6 last-slot output underfunding | off-chain `escrowDstWatcher` + `ccFill` (no Foundry test) |
| Trufy 3.7 dust safety deposit | `EscrowSrcFactory::test_fillSlot_{zeroSafetyDeposit,dustSafetyDeposit}_reverts` |
| Trufy 3.8 zero-amount non-final slots | `EscrowSrcFactory::test_fillSlot_zeroSlotAmount_reverts` |
| Trufy (final) 3.1 single cosigner key | `EscrowSrcFactory::test_fillSlot_perSessionCosignerKey_reverts` / `..._singleCosigner_servesMultipleSwappers` |
| minFill tail completion | `MinFillRemainder::*` |
| Double-settlement / terminal state | `FillAuctionTerminalState::*` |
| Solvency / conservation | `FillAuctionInvariant::invariant_solvency`, `MultiOrderScenario` |

---

## 4. Deliberately NOT covered on-chain (cosigner / off-chain enforced)

These are **architecture choices**, not missing tests. A reviewer will probe them, so state them plainly. The contracts enforce custody, atomicity, and accounting on-chain; the items below are enforced by the trusted cosigner/relayer because they cannot be seen from a single chain:

1. **Cross-chain output correctness** (`outputToken` / `minOutput`) — `EscrowSrcFactory` comments say so explicitly; the server only reveals `S_i` after confirming the Chain-B leg. No on-chain test can cover what the chain can't observe.
2. **T2 < T1 timelock ordering** — not enforced on-chain (two chains, incomparable clocks). `CrossChainTimelock::test_T2geqT1_swapperTakesBothLegs` *documents the break*; the buffer is enforced in `escrowDstWatcher`.
3. **Single-cosigner trust** — one immutable key authenticates everything; the cross-chain path adds the swapper's signature as defence-in-depth, but a leaked key / withholding server is a trust assumption, not a contract guard.
4. **Trufy 3.2 / 3.6 filler-binding & last-slot output** — verified in the backend watcher (`escrowDstWatcher.ts`), no Foundry coverage.

Live E2E (`tests/race/`, shell-orchestrated) exercises the real filler bots cooperatively on an Anvil fork but is **not** part of the 149 Foundry tests.

---

## 5. Coverage numbers & branch-% caveat

- `src/FillAuction.sol`: **100% line / statement / function** (non-fork run).
- `src/PartialFillReactor.sol`: **94% line / 96% statement** (the uncovered lines are fallback / `verifyOrderSignature` paths exercised only by the fork suite).
- **Do not headline `forge coverage`'s branch %.** It under-counts `require(cond,"msg")` revert arms — exactly what the 25 `CoreGuards` tests exercise — so it barely moves even though every revert line is executed and asserted. The trustworthy evidence is the per-revert-string assertions plus FillAuction's full line/statement/function coverage.

---

## 6. Recommended next steps (see `TESTING_NEXT_STEPS.md`)

Priority for the defense, with effort:
1. **Slither** (static analysis, ~hours) — run *before* testnet; triage into fix / justified / noise. The only step with pre-ship safety value.
2. **TWAP manipulation experiment** (Part C, ~1–2 days) — extend `TwapManipulation.t.sol` into a short-vs-long-window comparison table. Highest *contribution* value: quantifies Trufy 3.5 / N-3.
3. **Mutation testing** (~1–3 days), scoped to the pure libs (`DynamicStakeLib`, `DecayCursorLib`, `ScaledOutputLib`, `RemainingLib`, `SlotLib`). Best evidence that the 149 tests are meaningful; skip fork/cross-chain mutants.

Out of scope (future work): full formal verification, cross-chain testnet soak tests, agent-based economic simulation.
