## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```

---

# Cross-Chain Swap — Cryptographic Design Notes

This section explains three pieces of cryptography that the cross-chain swap
flow depends on:

1. [Signature standard](#1-signature-standard-eip-712) — how the swapper and the server's "cosigner" jointly authorize an order
2. [Merkle tree](#2-merkle-tree--build-off-chain-verify-on-chain) — how N partial-fill slots are committed and verified cheaply
3. [Nonce](#3-nonce) — what the `nonce` field actually does (and doesn't do)

All on-chain code referenced below lives in `src/crosschain/EscrowSrcFactory.sol`
(Chain A — lazy order registration, both signature checks, Merkle
verification, per-slot `EscrowSrc` clones via `EscrowSrc.sol`) and
`src/crosschain/EscrowDstFactory.sol` / `EscrowDst.sol` (Chain B — per-slot
output-token escrows). These replace the old, now-deleted
`CrossChainReactor.sol`, which pulled the swapper's entire `inputAmount` into
one shared contract up front; see the header comment in `EscrowSrcFactory.sol`
for the full rationale behind the per-slot-clone redesign.

The off-chain counterpart (tree building, signing) lives in
`backend/src/services/crosschainService.ts`.

## 1. Signature standard (EIP-712)

Every cross-chain order must be authorized by **both the swapper and the
server's "cosigner"** (the KeyDistributor's signing key) before the first
`fillSlot()` for it will succeed. The contract verifies both using
[EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed structured-data
signatures — the same scheme MetaMask renders as a human-readable struct
instead of an opaque hex blob.

### Why two signatures, not one?

The old `CrossChainReactor` only needed a cosigner signature, checked inside
an explicit `createOrder()` that the swapper called themselves — so the
swapper's own transaction was proof enough that *they* approved the order.
The current design has **no `createOrder()`**: the order is registered
*lazily*, inside the first `fillSlot()` call by whichever filler claims a
slot first. Since the swapper isn't the caller anymore, the contract needs an
explicit signature from them too:

- **`swapperSig`** — proves the swapper authorized *this exact* order (every
  field: amounts, deadline, `merkleRoot`, `numSlots`). Without it, a filler
  could submit any `OrderInfo` naming a victim as `swapper` and pull from
  their standing Permit2 allowance.
- **`cosignerSig`** — proves the backend's KeyDistributor built *this exact*
  Merkle tree and holds the secrets `S_i` for every `H_i` in it (same role as
  the old cosigner check). Without it, a filler could submit a `merkleRoot`
  whose leaves they know the secrets to themselves, with no `S_i` ever needing
  to be revealed on Chain B.

Both checks happen inside `fillSlot()`, on the first call for a given
`orderHash` only:

```solidity
bytes32 orderHash = _hashOrder(info);
OrderState storage order = _orders[orderHash];

if (!_created[orderHash]) {
    // ... validate info: amount > 0, numSlots power of two,
    //     deadline in the future, merkleRoot != 0 ...

    _verifySig(orderHash, swapperSig,  info.swapper);
    _verifySig(orderHash, cosignerSig, cosigner);

    // ... store OrderState, mark _created[orderHash] = true ...
}
```

Every later `fillSlot()` for the same order hits `_created[orderHash] ==
true` and skips straight to the per-slot Merkle check + clone deployment
(see §2).

### Domain separator

`DOMAIN_SEPARATOR` is computed once in the constructor and pins the signature
to *this contract, on this chain*:

```solidity
DOMAIN_SEPARATOR = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
    keccak256("NeutronX CrossChain"),
    block.chainid,
    address(this)
));
```

The backend mirrors this exactly in `computeDomainSeparator(chainId, reactorAddr)`
so it can produce a digest the contract will accept. Because `address(this)`
and `block.chainid` are baked in, a signature minted for one
`EscrowSrcFactory` deployment can never be replayed against a different
deployment or a different chain.

**Practical consequence:** every time `EscrowSrcFactory` is redeployed (e.g.
re-running `tests/crosschain/setup_cc.sh` in dev), `address(this)` changes, so
`DOMAIN_SEPARATOR` changes, so the digest both `swapperSig` and `cosignerSig`
were computed over no longer matches what `_verifySig` recomputes against the
new deployment. **Any order created before the redeploy becomes unfillable**
— `fillSlot()` reverts `"invalid signature"` on its first call. There's no
"upgrade" path for an in-flight order; it has to be recreated (re-signed) from
the frontend after the new factory address has propagated to
`backend/.env` (`CROSS_CHAIN_REACTOR`) and both fillers' `.env`
(`ESCROW_SRC_FACTORY`), and all three services have been restarted.

### Struct hash

The signed payload is the `OrderInfo` struct, typed via `ORDER_TYPE_HASH`:

```solidity
bytes32 public constant ORDER_TYPE_HASH = keccak256(
    "CrossChainOrder("
    "address swapper,address inputToken,uint256 inputAmount,"
    "address outputToken,uint256 minOutput,"
    "uint256 deadline,uint256 nonce,bytes32 merkleRoot,uint8 numSlots"
    ")"
);
```

`_hashOrder` ABI-encodes the type hash followed by **every** `OrderInfo`
field, in struct order:

```solidity
function _hashOrder(OrderInfo calldata info) internal pure returns (bytes32) {
    return keccak256(abi.encode(
        ORDER_TYPE_HASH,
        info.swapper, info.inputToken, info.inputAmount,
        info.outputToken, info.minOutput,
        info.deadline, info.nonce, info.merkleRoot, info.numSlots
    ));
}
```

Including *every* field — especially `merkleRoot` — is what makes the
signature cover the whole order. If the server signed an order with root `R`
and someone tried to swap in a different root `R'`, `_hashOrder` would produce
a different `orderHash`, and the original signature would no longer recover to
the cosigner's address.

### Final digest and recovery

The EIP-712 digest follows the standard `"\x19\x01" ‖ domainSeparator ‖ structHash`
layout, and is recovered with OpenZeppelin's `ECDSA`. A single helper handles
*both* signatures — only `expectedSigner` differs:

```solidity
function _verifySig(bytes32 orderHash, bytes calldata sig, address expectedSigner) internal view {
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, orderHash));
    address signer = ECDSA.recover(digest, sig);
    require(signer != address(0) && signer == expectedSigner, "invalid signature");
}
```

`fillSlot()` calls this twice: once with `expectedSigner = info.swapper`
(checking `swapperSig`), once with `expectedSigner = cosigner` (checking
`cosignerSig`). `cosigner` is `immutable`, set once at deploy time — there's
no key-rotation path, so a new cosigner key means a new factory deployment
(and, per the note above, every existing order's signatures become invalid).

On the backend side:
- The order-creation path in `crosschainService.ts` builds the cosigner's
  digest the same way —
  `keccak256(solidityPack(['string','bytes32','bytes32'], ['\x19\x01',
  computeDomainSeparator(chainAId, reactorAddr), structHash]))` — and signs it
  with `cosignerWallet._signingKey().signDigest(digest)`, producing
  `cosignerSig`.
- `setSwapperSig()` recomputes the same digest and uses
  `ethers.utils.recoverAddress` to check the frontend-submitted `swapperSig`
  recovers to `order.swapper` *before* storing it — i.e. the backend
  validates the swapper's signature eagerly, even though the contract only
  checks it later, on the first `fillSlot()`.

### Replay guard

The *replay* protection for orders is the `_created` mapping keyed on the
full `orderHash` — but unlike the old `CrossChainReactor`, hitting it again is
**not a revert**. It's an idempotency guard around the lazy-registration
block:

```solidity
mapping(bytes32 => bool) private _created; // true once the first fillSlot() ran
...
if (!_created[orderHash]) {
    // validate + verify both signatures + store OrderState
    _created[orderHash] = true;
}
```

Any `fillSlot()` call after the first — for the same `orderHash`, *any* slot —
skips registration entirely and falls straight through to the per-slot Merkle
check (§2). That's by design: re-submitting the same `(info, swapperSig,
cosignerSig)` for a *different* `slotIndex` is the normal path for a second
filler claiming another slot of the same order. The actual per-slot replay
guard — "this specific slot, once" — is `order.filledBitmap` (§2).

Because `orderHash` is derived from *every* field of `OrderInfo` (including
`deadline` and `merkleRoot`, both of which the server varies per session), in
practice no two distinct sessions ever produce the same `orderHash` — see §3
for why `nonce` doesn't need to do this job by itself.

## 2. Merkle tree — build off-chain, verify on-chain

### Why a tree at all?

A cross-chain order can be **partially filled** by up to `numSlots` different
fillers, each claiming a fixed fraction of the order (see `SlotLib`). The
naive way to support this would be to deploy `numSlots` independent HTLCs —
but that's `O(N)` storage and `O(N)` deploy gas. Instead, the server commits
to all `N` slots with a **single 32-byte Merkle root**, stored once on-chain,
and each claim only needs to prove inclusion of its own leaf:

> *O(1) storage, O(log₂ N) verification per claim* — see `SlotLib`'s doc
> comment for the full rationale.

### Secret hierarchy (off-chain, never persisted in full)

Each slot `i` gets its own one-time secret `S_i`, derived deterministically
from a single per-swapper `rootSecret` (stored once in `cc_sessions`) so that
nothing except `rootSecret` ever needs to be stored:

```
rootSecret                                    (per swapper, in backend DB)
  └─ masterSecret = keccak256(rootSecret, swapper, inputToken, inputAmount,
                              outputToken, minOutput, deadline, nonce)
       └─ S_i = keccak256(masterSecret, slotIndex_i)
            └─ H_i = keccak256(S_i)           (the "hashlock" for slot i)
```

This is implemented in `crosschainService.ts` as `deriveMasterSecret`,
`deriveSecret`, and `deriveHashlock`. Folding the *entire order* into
`masterSecret` (not just `rootSecret`) means a leaked `S_i` from one order
reveals nothing about secrets in any other order — each order gets an
unrelated secret tree.

### Building the tree (off-chain)

For each slot `i` the server computes a **leaf**:

```solidity
leaf_i = keccak256(bytes.concat(keccak256(abi.encode(hashlock_i, slotIndex_i))))
```

— implemented as `computeLeaf(hashlock, slotIndex)`. This is OpenZeppelin's
**double-hash leaf** convention (`keccak256(keccak256(...))`). The inner hash
binds the leaf to *both* the hashlock and its slot index (so leaves can't be
replayed at the wrong index); the outer hash makes leaves indistinguishable
from internal tree nodes in length/structure, which is what prevents
**second-preimage attacks** — an attacker can't take two adjacent leaves and
claim their concatenation is itself a valid leaf, because real leaves are
always the *double* hash of a 64-byte preimage while internal nodes are a
*single* hash of two 32-byte children.

The tree is then built bottom-up with sorted-pair hashing:

```ts
hashPair(a, b) = keccak256(concat(sort(a, b)))   // lexicographic sort ⇒ order-independent
buildTree(leaves) → layers[0] = leaves, layers[k+1] = hashPair of each adjacent pair
getProof(layers, idx) → sibling hash at each layer from leaf to root
```

Sorting each pair before hashing means the proof-verification side doesn't
need to track "is this sibling on the left or right" — `MerkleProof.verify`
(and the backend's `getProof`) both rely on this convention.

### Why powers of two?

`SlotLib.getNumSlots(inputAmount)` picks `numSlots ∈ {4, 8, 16, 32, 64}` based
on order size (mirrored off-chain in `crosschainService.ts`'s `getNumSlots`),
and `fillSlot()` enforces both the power-of-two AND range constraints in a
single check, on the first call for an order:

```solidity
require(SlotLib.isPowerOfTwo(info.numSlots), "numSlots not power of 2");
```

```solidity
function isPowerOfTwo(uint8 n) internal pure returns (bool) {
    return n >= 2 && n <= 64 && (n & (n - 1)) == 0;
}
```

The upper bound (64) isn't arbitrary: `OrderState.filledBitmap` is a `uint64`,
exactly one bit per slot at the max `numSlots` — 64 is both the
crypto-balance sweet spot (tree depth `log2(64) = 6`) and the largest value
that still fits the bitmap.

A power-of-two leaf count keeps the tree perfectly balanced, so **every**
proof is exactly `log2(N)` hashes long (`SlotLib.proofLength`) — predictable
gas costs and no edge cases for unbalanced subtrees.

### Verifying a slot at fill-time (on-chain)

Unlike the old `CrossChainReactor` (where claiming and revealing the secret
happened in the same call), `fillSlot()` never sees the secret `S_i` at all —
only the **hashlock** `H_i` the backend assigned to this slot, plus its Merkle
proof:

```solidity
// "slot already filled" — checked + set BEFORE touching funds, so a revert
// here atomically undoes everything below (CREATE2, Permit2 pull, msg.value).
uint64 slotBit = uint64(1) << slotIndex;
require(order.filledBitmap & slotBit == 0, "slot already filled");
order.filledBitmap |= slotBit;

// Rebuild the leaf exactly as the server did off-chain and verify it
// against the order's stored root — BEFORE pulling any funds.
bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(hashlock, slotIndex))));
require(MerkleProof.verify(merkleProof, order.merkleRoot, leaf), "invalid merkle proof");
```

If this passes, the contract knows: *"the server committed to a slot at index
`slotIndex` whose hashlock is `H_i`, and this filler is the first to claim
it."* That's sufficient to deploy an `EscrowSrc` clone, redirect
`order.slotAmount` (or `lastSlotAmount` for the final slot, which absorbs the
integer-division remainder) into it via Permit2, and fund it with the
filler's safety deposit — **no secret has been revealed yet**.

`order.filledBitmap` (one bit per slot, up to 64 — see "Why powers of two?"
above) is both the "already filled?" check and the per-slot replay guard, in a
single `SLOAD` + bitmask.

### Revealing S_i — withdraw/claim happen later, on *both* chains

The hashlock preimage `S_i` only surfaces after the filler completes their
Chain B leg:

1. Filler funds the precomputed `EscrowDst` clone on Chain B and calls
   `EscrowDstFactory.deploy(H_i, swapper, outputToken, amount, T2)`.
2. The backend's `chainBWatcher` sees the new escrow, re-derives `S_i` (it was
   never stored — see "Secret hierarchy" above), and calls
   `EscrowDst.claim(S_i)`. This checks `keccak256(S_i) == H_i`, pays the
   swapper their output tokens, and **emits `S_i` in plaintext** via the
   `Claimed` event.
3. Anyone (normally the filler) reads `S_i` off Chain B and calls
   `EscrowSrc(escrowAddrA).withdraw(S_i)` on Chain A, which re-checks
   `keccak256(S_i) == hashlock` and pays the filler their input tokens plus
   their safety deposit.

The single Merkle-leaf hashlock `H_i` is therefore checked **twice**, by two
different contracts on two different chains, against the **same** `S_i` —
that symmetry is what makes the two legs atomic (see §4 for the timelock
ordering that makes it safe).

## 3. Nonce

`OrderInfo.nonce` is a plain `uint256` field that flows into two places:

1. **The EIP-712 struct hash** — it's one of the fields `_hashOrder` encodes
   under `ORDER_TYPE_HASH`, so the cosigner's signature covers it (see §1).
2. **The off-chain `masterSecret` derivation** — `deriveMasterSecret` includes
   `nonce` in its `abi.encode(...)` input, so changing `nonce` produces an
   entirely different secret tree (`S_i`, `H_i`, and hence `merkleRoot`) for
   what is otherwise the same order parameters.

### What it is *not*

The doc comment on the struct field currently reads:

```solidity
uint256 nonce;        // anti-replay: must be unique per swapper
```

…but **this is aspirational, not enforced**. There is no
`mapping(address => mapping(uint256 => bool)) usedNonce` (or similar) anywhere
in the contract. The actual replay guard is `_created[orderHash]` (checked in
`createOrder`), which is keyed on the **full EIP-712 struct hash** — a hash
that already depends on `deadline`, `merkleRoot`, `inputAmount`, etc. In
practice, two orders virtually never produce the same `orderHash` even with an
identical `nonce`, because `deadline` (a future block number) and
`merkleRoot` (derived from a fresh secret tree) differ on every session.

Concretely: `tests/crosschain/run_cc.sh` always submits `"nonce": "1"` and this
is harmless — repeated runs succeed because `deadline` moves forward each
time, producing a fresh `orderHash`, which `fillSlot()` registers
independently (see "Replay guard" in §1). There is no `"order already
exists"` revert to worry about any more — the lazy-registration check is a
silent no-op on a known `orderHash`. The failure mode you'd see from a truly
*stale* resubmission (same `orderHash`, but the backend's secret tree has
since moved on for that swapper) is `"invalid merkle proof"` on `fillSlot()` —
the `H_i`/proof the backend now hands out no longer matches the `merkleRoot`
baked into that old `orderHash`.

### Bottom line

Treat `nonce` as **one more input that diversifies the signed order and the
derived secret tree** — useful if the server ever needs to intentionally mint
two structurally-identical orders for the same swapper (e.g. retrying after a
failed `createOrder`) without colliding on `orderHash` or producing the same
`S_i`/`H_i` set. If you need a *hard* anti-replay guarantee independent of
`deadline`/`merkleRoot`, that would require adding an explicit
`usedNonce[swapper][nonce]` check in `createOrder` — it doesn't exist today.

## 4. Cross-chain timelock ordering (`T2 < T1`) — 🟠 High, not enforced on-chain

**Location:** `EscrowDst.refund` (l.117–132, and the comment at l.121–122),
`EscrowDst.expiry` (filler-supplied via `EscrowDstFactory.deploy`),
`EscrowSrc.expiry` (= `order.deadline` = `T1`, set in
`EscrowSrcFactory.fillSlot` l.276).

`EscrowDst.sol` states the safety assumption the whole HTLC rests on:

```solidity
// T2 < T1 invariant guarantees this can always happen before the swapper
// reclaims on Chain A.
```

The protocol's atomicity depends on the **destination** escrow (Chain B, where
the secret is revealed first) expiring *before* the **source** escrow (Chain A,
where the filler then redeems with that secret). That window is what guarantees
the filler — who acts second — always has time to claim their input-token leg
after they've already paid out the output-token leg. **Two defects break it:**

1. **The invariant is never enforced.** `EscrowDst.expiry` (`T2`) is a free
   parameter the filler passes to `EscrowDstFactory.deploy`, validated only as
   `> block.number` (`EscrowDst.sol:85`). `EscrowSrc.expiry` (`T1`) is
   `order.deadline`. No code anywhere requires `T2 < T1` (it cannot live in one
   contract — the two escrows are on different chains — so it must be enforced
   at parameter-selection time and is currently left entirely to the off-chain
   server's discretion).

2. **`block.number` is not comparable across chains.** `T1` is a block height on
   Chain A; `T2` is a block height on Chain B. They are independent counters
   advancing at different block times (e.g. Ethereum ~12 s vs. an L2 at sub-second).
   A *safe gap* is a wall-clock quantity and cannot be expressed as a relationship
   between two heterogeneous chains' raw block numbers. This is exactly why
   production HTLC / Fusion+-style designs key their timelocks to **timestamps**
   plus an explicit finality-lock window, not block heights.

**Exploit / failure mode (atomicity break, "free option" for the swapper).**
Pick `T2 ≥ T1` — which the contracts happily accept:

- At `T1` the source escrow is past expiry, so the swapper calls
  `EscrowSrc.cancel()` and reclaims their input token (e.g. WETH).
- Because `T2 ≥ T1`, the destination escrow is *still active*, so the backend
  (or anyone) can still call `EscrowDst.claim(S_i)` and pay the output token
  (e.g. USDC) to the swapper.

The swapper walks away with **both legs**; the filler paid USDC on Chain B and
recovers nothing on Chain A. Even with the *intended* `T2 < T1` ordering, if the
gap is too small relative to the two chains' real block times, the same race
opens up near the boundary — the point is that nothing on-chain bounds it.

**Recommendation.**
- Switch both escrows' expiries to `block.timestamp` and have the server choose
  `T2` and `T1` with a conservative wall-clock gap that exceeds Chain A's
  finality + a redemption margin.
- Add a `minSrcExtraTime` to the source-side parameters and assert
  `T1 ≥ revealDeadline + margin` where it *can* be checked, and document the
  `T2 < T1` selection as a hard server-side invariant with a test.
- Defense in depth: have the source escrow refuse `cancel()` until a margin past
  `T1`, giving a late-revealed filler a guaranteed redemption window.

A reproduction is in `test/crosschain/CrossChainTimelock.t.sol`
(`test_T2geqT1_swapperTakesBothLegs`): with `T2 > T1` the swapper is refunded on
the source escrow *and* paid on the destination escrow in the same scenario,
while the filler loses the leg they funded.

### Bottom line

The single most load-bearing assumption in the cross-chain design (`T2 < T1`)
lives only in a code comment and in the off-chain server's parameter choices,
and is expressed in a unit (`block.number`) that isn't even meaningful across
two chains. Move the timelocks to timestamps and enforce the gap explicitly
before any real-value deployment.
