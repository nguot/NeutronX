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
flow (`src/crosschain/CrossChainReactor.sol`) depends on:

1. [Signature standard](#1-signature-standard-eip-712) — how the server's "cosigner" authorizes an order
2. [Merkle tree](#2-merkle-tree--build-off-chain-verify-on-chain) — how N partial-fill slots are committed and verified cheaply
3. [Nonce](#3-nonce) — what the `nonce` field actually does (and doesn't do)

All on-chain code referenced below lives in `src/crosschain/CrossChainReactor.sol`.
The off-chain counterpart (tree building, signing) lives in
`backend/src/services/crosschainService.ts`.

## 1. Signature standard (EIP-712)

Every cross-chain order must be **cosigned by the server** (the "cosigner",
the KeyDistributor's signing key) before `createOrder()` will accept it. The
contract verifies this using [EIP-712](https://eips.ethereum.org/EIPS/eip-712)
typed structured-data signatures — the same scheme MetaMask renders as a
human-readable struct instead of an opaque hex blob.

### Why a cosigner signature at all?

The server is the only party that knows the swapper's `rootSecret` and is the
only party that builds the Merkle tree (see §2). The cosigner signature is how
the contract proves, on-chain, that:

- this *exact* order (every field, byte for byte) was seen and approved by the server, and
- the `merkleRoot` in the order was the one the server actually built for it.

Without it, anyone could call `createOrder()` with a forged `merkleRoot` —
e.g. a tree whose leaves they know secrets for — and drain the swapper's
locked tokens. The signature check happens in `createOrder()`:

```solidity
orderHash = _hashOrder(info);
require(!_created[orderHash], "order already exists");
_verifyCosignerSig(orderHash, cosignerSig);
_created[orderHash] = true;
```

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
and `block.chainid` are baked in, a signature minted for the Chain A reactor
can never be replayed against a different deployment or a different chain.

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
layout, and is recovered with OpenZeppelin's `ECDSA`:

```solidity
function _verifyCosignerSig(bytes32 orderHash, bytes calldata sig) internal view {
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, orderHash));
    address signer = ECDSA.recover(digest, sig);
    require(signer != address(0) && signer == cosigner, "invalid cosigner sig");
}
```

`cosigner` is an `immutable` set once at deploy time (see `constructor`), so
there's no key-rotation path on this contract — a new cosigner means a new
reactor deployment.

On the backend side, `crosschainService.ts` builds the identical digest —
`keccak256(solidityPack(['string','bytes32','bytes32'], ['\x19\x01', domainSeparator, structHash]))`
— and signs it with `cosignerWallet._signingKey().signDigest(digest)`,
producing the `cosignerSig` bytes that get submitted to `createOrder()`.

### Replay guard

Note that the *replay* protection for orders is **not** the EIP-712 signature
itself (a valid signature could in principle be resubmitted) — it's the
`_created` mapping keyed on the full `orderHash`:

```solidity
mapping(bytes32 => bool) private _created; // prevents replay of the same orderHash
...
require(!_created[orderHash], "order already exists");
...
_created[orderHash] = true;
```

Because `orderHash` is derived from *every* field of `OrderInfo` (including
`deadline` and `merkleRoot`, both of which the server varies per session), in
practice no two real orders ever collide — see §3 for why `nonce` doesn't need
to do this job by itself.

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

`SlotLib.getNumSlots(inputAmount)` picks `numSlots ∈ {2, 4, 8, 16, 32}` based
on order size (mirrored off-chain in `crosschainService.ts`'s `getNumSlots`),
and `createOrder()` enforces it:

```solidity
require(SlotLib.isPowerOfTwo(info.numSlots), "numSlots not power of 2");
require(info.numSlots <= 32,                 "numSlots too large");
```

A power-of-two leaf count keeps the tree perfectly balanced, so **every**
proof is exactly `log2(N)` hashes long (`SlotLib.proofLength`) — predictable
gas costs and no edge cases for unbalanced subtrees.

### Verifying a claim (on-chain)

`claimSlot()` reconstructs the leaf from data the filler reveals and checks it
against the stored root using OpenZeppelin's `MerkleProof`:

```solidity
// Step 1: derive H_i from the secret the filler provides
bytes32 hashlock = keccak256(abi.encodePacked(secret));
// Step 2: rebuild the leaf exactly as the server did off-chain
bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(hashlock, slotIndex))));
// Step 3: verify the proof against the order's stored root
require(
    MerkleProof.verify(merkleProof, order.merkleRoot, leaf),
    "invalid merkle proof"
);
```

If this passes, the contract knows: *"the server committed to a slot at index
`slotIndex` whose hashlock is `H_i`, and the caller has just revealed the
matching preimage `secret = S_i`."* That's sufficient to release
`order.slotAmount` (or `lastSlotAmount` for the final slot, which absorbs the
integer-division remainder) to the registered filler — see `slotFiller` /
`registerFiller()` for the anti-front-running step that happens *before* the
secret is revealed on Chain B.

A claimed slot is recorded in a `uint64 claimedBitmap` (one bit per slot, up
to 64 slots — though `numSlots` is capped at 32) rather than a separate
mapping, so the "already claimed?" check is a single `SLOAD` + bitmask.

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
time, producing a fresh `orderHash`. The *practical* failure mode you'll see
from a stale resubmission isn't `"order already exists"` but
`"invalid merkle proof"` — i.e. the secret tree on the backend has moved on
from the order the contract has stored under that (now stale) `orderHash`.

### Bottom line

Treat `nonce` as **one more input that diversifies the signed order and the
derived secret tree** — useful if the server ever needs to intentionally mint
two structurally-identical orders for the same swapper (e.g. retrying after a
failed `createOrder`) without colliding on `orderHash` or producing the same
`S_i`/`H_i` set. If you need a *hard* anti-replay guarantee independent of
`deadline`/`merkleRoot`, that would require adding an explicit
`usedNonce[swapper][nonce]` check in `createOrder` — it doesn't exist today.
