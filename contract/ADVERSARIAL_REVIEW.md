# Pre-emptive Adversarial Review — NeutronX Contracts

_Self-audit performed 2026-06-29, with an external-auditor mindset, to surface anything a
re-audit might raise that the 149 tests / Slither / Trufy did not already cover. Goal:
**no surprises at the defense.** Honesty over reassurance — every angle considered is listed,
including the ones that turned out fine._

## Method
Read every first-party contract end-to-end and probed, per contract: access control, value
flow & double-spend, reentrancy/CEI, integer/cast safety, economic incentives (slash/refund/
griefing), cross-contract trust, signature/replay, and the on-chain/off-chain trust boundary.

## Summary of findings

| ID | Area | Severity | Verdict |
|---|---|---|---|
| AR-1 | FillAuction.slash bounty self-capture | Low (economic) | Minor leak — accept or 1-line fix |
| AR-2 | Permit2 allowance drain across reopened cross-chain slots | Low (griefing) | Bounded by safety deposit |
| AR-3 | Compromised cosigner can drain swappers | High **trust** (KNOWN) | Documented centralization; mitigations |
| AR-4 | Non-first-fill skips signature re-validation | — | **Considered → SAFE** (hash-binding) |
| AR-5 | FallbackExecutor arbitrary router calldata | — | **Considered → SAFE** (output floor) |
| AR-6 | Fee-on-transfer **input** token | Low (KNOWN) | Reverts safely; FoT input unsupported |
| AR-7 | Cached EIP-712 domain separator (chain fork) | Low (standard) | Pin/recompute for mainnet |
| AR-8 | No pause; single-EOA immutable admin | Operational (KNOWN) | multisig/timelock = future work |
| AR-9 | Floating pragma `^0.8.20` (built 0.8.35) | Low (KNOWN) | Pin for reproducible bytecode |
| AR-10 | Multiple EscrowDst per hashlock on Chain B | — | **Considered → SAFE** (backend-resolved) |
| AR-11 | Slash timing vs. honest fillers | — | **Considered → SAFE** (window + terminal flags) |

**Bottom line: no new exploitable on-chain vulnerability** beyond the already-documented trust
model. Two minor economic observations (AR-1, AR-2), one sharpened statement of the known
cosigner risk (AR-3), and standard hardening items. The dominant risk remains cosigner trust.

---

## Detailed findings

### AR-1 — Slash bounty can be self-captured (Low, economic)
`FillAuction.slash()` pays `reward = stake/10` to `msg.sender` and the rest to the treasury, and
is permissionless. A filler who abandons their commitment can therefore call `slash()` **on
themselves** and recover the 10% bounty, so the effective penalty is ~90% of stake, not 100%.
- **Impact:** the slashing deterrent is 90% instead of 100%; treasury still receives 90%; the
  abandoner is still net-negative. No theft, no protocol loss.
- **Fix (optional):** when `msg.sender == filler`, route the full stake to the treasury (no
  self-bounty). One line.
- **Status:** minor economic leak; defensible to accept.

### AR-2 — Permit2 allowance erosion across reopened cross-chain slots (Low, griefing)
`EscrowSrcFactory.fillSlot()` pulls `slotAmount` from the swapper via Permit2 on every fill.
`EscrowSrc.cancel()` refunds the **tokens** to the swapper but does **not** restore the consumed
Permit2 **allowance**. Repeated fill → expire → `cancel` → `reopenSlot` → re-fill cycles
therefore monotonically consume the swapper's standing allowance, and can exhaust it so that
further legitimate fills revert until the swapper re-approves Permit2.
- **Impact:** liveness griefing on a single order; no fund loss (every cancel refunds the swapper).
- **Cost to attacker:** forfeits `MIN_SAFETY_DEPOSIT` (≥ 0.001 ETH) per cycle (the 3.7 floor),
  so sustained griefing is expensive.
- **Mitigation:** swapper re-approves Permit2 (one tx); the backend can also stop assigning a
  griefed slot. Accept as bounded.

### AR-3 — A compromised cosigner can drain swappers (KNOWN trust assumption, stated sharply)
The single-chain `PartialFillReactor` authenticates orders by the **cosigner** signature only;
the swapper's consent is their standing Permit2 allowance to the reactor. The cosigner also sets
`minOutputAmount`. Therefore a leaked cosigner key lets an attacker sign a self-serving order
with `minOutputAmount ≈ 0`, register+fill it themselves, and take the swapper's input for
near-zero output — up to each swapper's Permit2 allowance.
- **On the cross-chain path this is harder:** `EscrowSrcFactory` requires **two** signatures
  (swapper + cosigner), so a cosigner key alone cannot create an order.
- **Bound:** each victim's exposure ≤ their Permit2 allowance & expiration to the reactor.
- **Mitigations (already partly in place / planned):** single immutable cosigner key in an HSM/
  server (Trufy 3.1 fix), swappers should set tight Permit2 allowances + short expirations, and
  the documented TEE-hardening / client-side-secret path is the route to reduce this trust.
- **Status:** this IS the system's central, deliberate centralization tradeoff. Pre-declare it.

### AR-4 — Non-first-fill skips signature re-validation → SAFE
`executePartialChunk` runs `_validateOrder` (cosigner sig) only on the first fill. Verified safe:
`orderHash = keccak(ORDER_TYPE_HASH, …all order.info fields…)`, and the remaining/cursor state is
keyed by `orderHash`. Any tampering of `order.info` changes the hash → lands on an empty slot →
`isFirstFill == true` → signature is checked and fails. So later fills can only proceed with the
authentic, hash-bound `order.info`. No re-validation needed; not a gap.

### AR-5 — FallbackExecutor executes arbitrary calldata on an allowlisted router → SAFE
`executeFallback` `router.call(routeCalldata)` runs solver-crafted calldata. Bounded because:
`nonReentrant`; router is owner-allowlisted; `forceApprove(router, rem)` then reset to 0; the
swapper's output is measured as a **balance delta** and must clear both the solver `minAmountOut`
and the swapper's signed pro-rata floor; the absolute `minOutputAmount` is enforced cumulatively;
and any unconsumed input is refunded to the swapper. The solver cannot redirect value to itself —
it must deliver ≥ floor to the swapper. (This is Slither ID-0, defended.)

### AR-6 — Fee-on-transfer INPUT token (Low, known limitation)
Cross-chain: the factory pulls via Permit2 into the clone, then `initialize` requires
`balanceOf >= amount`; a FoT input under-funds the clone → `initialize` reverts → the whole
`fillSlot` reverts atomically (no stuck state). Single-chain: the filler receives `fillAmount −
fee` (the filler's loss); the swapper is protected by the output balance-delta check. Net:
FoT **input** tokens are effectively unsupported and fail closed — no fund loss. (FoT **output**
tokens are handled — see `FeeOnTransfer.t.sol`.)

### AR-7 — Cached EIP-712 domain separator (Low, standard)
`DOMAIN_SEPARATOR` bakes in `block.chainid` at construction and is never recomputed. On a chain
split (e.g. a hard fork that keeps the chainid only on one side) signatures could be replayed on
the minority fork. Standard consideration; recompute-on-chainid-change for a mainnet deployment.

### AR-8 — No pause; single-EOA immutable admin (Operational, known)
No circuit breaker anywhere; escrow clones are immutable. `owner`/`treasury` are the deployer EOA,
set at construction with no transfer function; the owner controls collateral rates, the router
allowlist, and `minCollateral`. Centralized incident-response gap. For mainnet: multisig + timelock
on admin, and consider a pause on the reactor/fallback. Accepted for a testnet/thesis deployment.

### AR-9 — Floating pragma (Low, known)
All contracts are `pragma solidity ^0.8.20`; the build used 0.8.35. Different compilers → different
bytecode. Pin an exact version before a mainnet deploy for reproducibility.

### AR-10 — Multiple EscrowDst clones per hashlock on Chain B → SAFE
`EscrowDstFactory` salt = `keccak(hashlock, msg.sender)`, so different fillers can each deploy a
funded `EscrowDst` for the same hashlock. The backend reveals `S_i` (claims) only on the correct
filler's escrow (Trufy 3.2 filler-binding, off-chain); a duplicate filler recovers via `refund()`
after T2. No on-chain double-payment.

### AR-11 — Slash timing cannot hit an honest filler → SAFE
`slash` requires `block.number > deadline + SLASH_WINDOW`, but `executePartialChunk` requires
`block.number <= deadline`. So by the time a registration is slashable the order is already
unfillable — no honest, still-working filler can be slashed. The `filled/slashed/released`
terminal flags additionally prevent any double-settlement (see `FillAuctionTerminalState.t.sol`).

---

## Conclusion
The contracts hold up to an adversarial re-read. The on-chain invariants (custody, atomicity,
accounting, no double-spend, reentrancy, overflow) are sound and well-tested. The only items a
fresh audit is likely to raise are (a) the **known** cosigner/centralization trust model (AR-3,
AR-8) — which should be pre-declared, not defended — and (b) minor economic/standard-hardening
notes (AR-1, AR-2, AR-7, AR-9). None is a new exploit. See `DEFENSE_PACK.md` for how to answer
each category live.
