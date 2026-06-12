# Cross-Chain HTLC — KeyDistributor Server & TEE Hardening Notes

## What the KeyDistributor Server Does

The `KeyDistributor` is a Node.js service that acts as the trusted intermediary in the cross-chain swap.  It holds the master secret `M` and is responsible for:

1. **Generating slot secrets** — derives `S_i = keccak256(M, i)` for each slot, computes `H_i = keccak256(S_i)`.
2. **Building the Merkle tree** — constructs the N-leaf tree and cosigns the swapper's `CrossChainOrder` with the server's private key (the `cosigner` key in `CrossChainReactor`).
3. **Assigning slots to fillers** — when a filler requests a slot, hands them `H_i` and the lock parameters (recipient, T2, minAmount).
4. **Watching Chain B** — listens for `EscrowDstFactory.EscrowCreated` events; once a deposit is confirmed to a safe depth (e.g. 12 blocks), verifies the amount and recipient are correct.
5. **Revealing secrets** — calls `EscrowDst.claim(S_i)` on the escrow clone, which transfers USDC to the swapper and emits `S_i` publicly.

The server is **where to find it**: inside the `key_distributor/` folder (to be built next — plain Node.js/TypeScript, no special infrastructure required).

---

## Current Trust Model

The server is a **trusted party**.  If it misbehaves, two bad things can happen:

| Misbehavior | Who gets hurt | How |
|---|---|---|
| Reveals `S_i` for an insufficient lock | Swapper | Filler claims WETH but delivered too little USDC |
| Refuses to reveal `S_i` for a valid lock | Filler | Filler's USDC is locked until T2, then refunded; swap fails for this slot |

In both cases, the swapper and filler can use the T1/T2 timeouts to exit without permanent loss of funds.  The swap just doesn't complete — no one is permanently rugged.

---

## TODO: TEE Hardening => Just run it client side 

Running the server inside a **Trusted Execution Environment (TEE)** removes the trust assumption by making the server's behavior *verifiable*.

### What TEE gives you
- The server's code is attested (you can prove on-chain that the correct binary is running).
- The master secret `M` is generated inside the enclave and never leaves it in plaintext.
- The reveal logic is enforced by hardware: `S_i` is only released if `lock.amount >= minOutputPerSlot && lock.recipient == swapper && confirmations >= threshold`.
- A remote attestation report (e.g. Intel SGX DCAP quote, or AWS Nitro attestation) can be verified on-chain or by anyone off-chain.

### Recommended stack options
| Option | Notes |
|---|---|
| **Intel SGX + Gramine** | Runs unmodified Node.js inside an SGX enclave; remote attestation via DCAP |
| **AWS Nitro Enclaves** | Simpler to operate on AWS; attestation document verifiable off-chain |
| **Phala Network / dStack** | On-chain attestation, EVM-compatible; easier integration for smart contracts |
| **Oasis Sapphire** | EVM-compatible confidential EVM; server logic moved directly into a confidential contract |

### Minimum changes needed for TEE
1. Move secret derivation and reveal logic into the enclave (or confidential contract).
2. Publish an attestation document (or on-chain proof) so fillers and swappers can verify the correct code is running before locking funds.
3. Store `M` only inside the enclave; the operator never sees it.
4. The `cosigner` key in `CrossChainReactor` should be the enclave's signing key (attestation proves it belongs to the correct enclave).

### Why we're skipping it now
For the thesis demo, the server runs as a plain Node.js process.  The correctness of the protocol is unaffected — TEE only removes the trust assumption about the operator.  The smart contracts (`CrossChainReactor`, `EscrowDst`/`EscrowDstFactory`) don't need to change when TEE is added; only the server implementation changes.

**Reminder: add TEE attestation before any production deployment.**
