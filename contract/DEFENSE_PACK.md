# Defense Pack — NeutronX Smart Contracts

_A one-page kit for the thesis defense: how to answer any audit-style finding, a residual-risk
register with proof for every item, and an opening statement. Prepared 2026-06-29._

---

## 0. Opening statement (say this first)

> "This system was assured in **layers**: 149 Foundry tests (unit, fuzz, stateful-invariant,
> adversarial/MEV, mainnet-fork), an AI audit (Trufy) with every finding fixed **and** pinned by a
> regression test, Slither static analysis with **zero exploitable findings**, mutation testing on
> the core libraries, and a quantified TWAP-manipulation experiment. I make **no claim of
> perfection** — no audited system is bug-free. I claim a rigorous, multi-method process and a
> documented residual-risk register. The trust model is **explicit**: custody, atomicity, and
> accounting are enforced on-chain; a single cosigner/relayer is trusted for cross-chain output
> correctness and reveal timing — a deliberate centralization tradeoff with a defined hardening
> path (TEE / client-side secrets)."

If a re-audit surfaces something new, that is the **process working**, not failing. Triage it live.

---

## 1. The live-triage script (run any new finding through these 4 questions)

1. **Real, or a false positive?** — e.g. Slither's `uninitialized-state` on `_cursors` is an FP:
   the cursor *is* written via a library storage-pointer Slither can't track.
2. **Exploitable, or defended?** — is it behind `nonReentrant` / access control / CEI? Is the
   value bounded by an on-chain floor?
3. **On-chain, or a trust-boundary I already documented?** — many findings live in the off-chain
   cosigner/relayer layer, which is an accepted design decision, not a code bug.
4. **Severity, fix, and does it matter on testnet?** — testnet is bug-tolerant by design; that's
   why it's the deployment target. State the fix and where it'd land.

If you can place a finding into this grid in ~60 seconds, you win the exchange regardless of what
it is.

---

## 2. Residual-risk / known-limitations register

Each row: what it is · why accepted / where fixed · the proof you can point to.

| # | Risk / limitation | Why accepted (or where fixed) | Proof / reference |
|---|---|---|---|
| R1 | **Single cosigner trust** — a leaked cosigner key can sign self-serving orders and drain swappers up to their Permit2 allowance | Deliberate centralization; mitigated by HSM/server key custody, tight Permit2 allowances/expirations, and 2-of-2 (swapper+cosigner) sigs on the cross-chain path; TEE/client-side is the hardening path | `AR-3`; `EscrowSrcFactory` double-sig; `CompletionFloor.t.sol` (on-chain minOutput floor bounds single-chain) |
| R2 | **Cross-chain `T2 < T1` not enforced on-chain** — two chains, incomparable clocks | Inherent to HTLC across chains; enforced off-chain by `escrowDstWatcher` (refuses reveal past `deadline − t2Buffer`); trustless fix = timestamp expiries + gap (future work) | `CrossChainTimelock.t.sol` (PoC, passes by design); Trufy 3.1 |
| R3 | **Cross-chain output correctness off-chain** (`outputToken`/`minOutput` not checked on Chain A) | Chain A can't observe Chain B; the server reveals `S_i` only after confirming the Chain-B leg | `EscrowSrcFactory.sol` security notes; Trufy 3.2/3.6 (backend) |
| R4 | **No pause / single-EOA immutable admin** | Trust-minimised by design; accepted for testnet/thesis; mainnet → multisig + timelock + pause | `AR-8` |
| R5 | **Short TWAP window is manipulable** | Quantified and bounded by the `minCollateral` floor; widen window for mainnet | `TwapManipulation.t.sol` + `TwapWindowComparison.t.sol` (measured: 60s −21%/−99.99% vs 1800s −1.5%/−81%) |
| R6 | **Slash bounty self-capture** — abandoner recovers the 10% bounty | Bounded; penalty still 90%; treasury still paid; optional 1-line fix | `AR-1` |
| R7 | **Permit2 allowance erosion on reopened slots** | Liveness-only; each griefing cycle forfeits a safety deposit; swapper re-approves | `AR-2`; `MIN_SAFETY_DEPOSIT` (Trufy 3.7) |
| R8 | **Fee-on-transfer INPUT token unsupported** | Fails closed (reverts), no fund loss; FoT output IS handled | `AR-6`; `FeeOnTransfer.t.sol` |
| R9 | **Cached EIP-712 domain separator** (chain-fork replay) | Standard; recompute-on-chainid for mainnet | `AR-7` |
| R10 | **Floating pragma `^0.8.20`** | Pin exact version for reproducible mainnet bytecode | `AR-9`; Slither |

---

## 3. Category playbook — "if the auditor says X, you say Y"

- **"Reentrancy in function X."** → "X is `nonReentrant` and follows checks-effects-interactions;
  the post-call write is the deliberate balance-delta / pull-payment pattern. Slither flagged it
  (ID-0, ID-4/5) and I triaged it as defended — here's the guard."
- **"State variable X is uninitialized."** → "False positive — it's written via a library through
  a `storage`-pointer parameter, which Slither's detector doesn't track. Verified in
  `DecayCursorLib.init`." (Slither ID-1.)
- **"This is too centralized / the cosigner is trusted."** → "Correct, and documented (R1, R3).
  It's a deliberate tradeoff for this thesis scope; the on-chain layer still enforces custody and
  the minOutput floor, and the cross-chain path needs the swapper's signature too. TEE / client-
  side secrets is the stated hardening path."
- **"Cross-chain atomicity can break (T2 ≥ T1)."** → "Yes — I built the PoC myself
  (`CrossChainTimelock.t.sol`). It's mitigated off-chain by the watcher's expiry buffer; the
  trustless fix is future work (R2)."
- **"An MEV filler can game the price / grief honest fillers."** → "Bounded by the signed
  min-output floor and the dynamic-stake refund; my adversarial suite plays exactly these
  attacks — `MevFillerExploits.t.sol`, `FrontRunGriefing.t.sol`, `MultiOrderScenario.t.sol`."
- **"TWAP collateral can be manipulated."** → "Demonstrated and **quantified** by me, not just
  claimed — see the window-vs-resistance table (R5). Mitigated by the `minCollateral` floor;
  widening the window is the mainnet recommendation."
- **"A brand-new finding I've never seen."** → run the Section-1 triage script out loud.

---

## 4. The four-sentence summary to memorise

1. Custody, atomicity, and accounting are enforced **on-chain** and covered by 149 tests +
   Slither (0 exploitable) + mutation testing.
2. Cross-chain output correctness and reveal timing are enforced by a **trusted cosigner/relayer**
   — a deliberate, documented centralization tradeoff.
3. Every known weakness is in a **residual-risk register** with a proof and a hardening path.
4. A new finding is the **process working**; I triage it by real-vs-FP, exploitable-vs-defended,
   on-chain-vs-trust-boundary, and severity-on-testnet.
