# Cross-chain testnet deploy — runbook

Two chains. **Chain A = Ethereum Sepolia** (source / WETH), **Chain B = Base Sepolia**
(destination / USDC). Both have Permit2 at the canonical address (verified). The deploy
scripts now take the key from `--private-key` (the env-key footgun is fixed).

- Deployer: `0xA4A83AF03b1a264d4D8CE211c71Fd1c07cE5e561`
- Cosigner (bring-up): same as deployer — matches `backend/.env.sepolia` `COSIGNER_PRIVATE_KEY`.
  For a real backend, set `COSIGNER_ADDRESS` to the backend's cosigner address.

| | Chain A — Sepolia | Chain B — Base Sepolia |
|---|---|---|
| chain id | 11155111 | 84532 |
| RPC | `https://eth-sepolia.g.alchemy.com/v2/<key>` | `https://sepolia.base.org` |
| deployer balance | 2.45 ETH ✅ | **0 — must fund** ⛽ |

## Step 0 — fund the deployer on Base Sepolia
`0xA4A8…e561` has 0 on Base. Get ~0.05 Base-Sepolia ETH:
- Base's own faucet (https://www.alchemy.com/faucets/base-sepolia or the Coinbase/QuickNode Base
  Sepolia faucets). pk910-style PoW faucets also exist for Base Sepolia.

Verify: `cast balance 0xA4A8…e561 --rpc-url https://sepolia.base.org`

## Step 1 — Chain A (Sepolia): EscrowSrc + EscrowSrcFactory
```bash
cd contract
COSIGNER_ADDRESS=0xA4A83AF03b1a264d4D8CE211c71Fd1c07cE5e561 \
forge script script/DeployCrossChain.s.sol --sig 'runChainA()' \
  --rpc-url "https://eth-sepolia.g.alchemy.com/v2/NqceSkD9a9GU5a-EbT9wp" \
  --private-key 0x<funded deployer key> --broadcast
```
Dry-run verified ✅ (deploys `EscrowSrc` impl + `EscrowSrcFactory`).

## Step 2 — Chain B (Base Sepolia): EscrowDst + EscrowDstFactory
```bash
cd contract
forge script script/DeployCrossChain.s.sol --sig 'runChainB()' \
  --rpc-url "https://sepolia.base.org" \
  --private-key 0x<funded deployer key> --broadcast
```
(No `COSIGNER_ADDRESS` needed — the destination factory takes none.)

## Step 3 (optional) — bidirectional (B→A swaps)
```bash
# Chain B source factory (USDC locked on Base):
COSIGNER_ADDRESS=0xA4A8…e561 forge script script/DeployCrossChain.s.sol --sig 'runChainB_Src()' \
  --rpc-url https://sepolia.base.org --private-key 0x<funded> --broadcast
# Chain A destination factory (WETH escrows on Sepolia):
forge script script/DeployCrossChain.s.sol --sig 'runChainA_Dst()' \
  --rpc-url https://eth-sepolia.g.alchemy.com/v2/<key> --private-key 0x<funded> --broadcast
```

## Step 4 — wire the factory addresses into `backend/.env.sepolia`
| Deploy step → contract | env var |
|---|---|
| runChainA → `EscrowSrcFactory` (Sepolia) | `ESCROW_SRC_FACTORY` (+ filler `ESCROW_SRC_FACTORY`) |
| runChainB → `EscrowDstFactory` (Base) | `CHAIN_B_FACTORY` |
| runChainB_Src → `EscrowSrcFactory` (Base) | `ESCROW_SRC_FACTORY_B` |
| runChainA_Dst → `EscrowDstFactory` (Sepolia) | `CHAIN_A_DST_FACTORY` |

Plus:
```
CHAIN_A_RPC=https://eth-sepolia.g.alchemy.com/v2/<key>
CHAIN_B_RPC=https://sepolia.base.org
CHAIN_A_CONFIRMATIONS=2
CHAIN_B_CONFIRMATIONS=2
```

## Notes
- The escrow `impl` addresses printed by each step are clone templates — the backend/fillers
  only need the **factory** addresses above.
- Fillers also need Base-Sepolia-funded keys to deploy/fund `EscrowDst` clones (Step 2's flow at
  fill time), in addition to their Sepolia keys.
- Token addresses: on testnet you'll use testnet WETH/USDC (or mocks). The escrows are
  token-agnostic (they take the token address per order), so no contract change is needed —
  just use whatever test tokens you fund the swapper/fillers with.
