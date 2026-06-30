# Sepolia deployment — single-chain stack

Deployed **2026-06-30** via `script/DeployTestnet.s.sol` (oracle-disabled mode).

| Contract | Address |
|---|---|
| **FillAuction** | `0x90a7b4d41434DfBeb019a6d05A589Eb650e55ebe` |
| **PartialFillReactor** | `0x70727323b3a45Bb1D081fBc78E481F357B49Fc8d` |
| FallbackExecutor | _not deployed_ (DeployTestnet skips it unless `FALLBACK_ROUTER` is set) |

- **Chain:** Ethereum Sepolia (`11155111`)
- **Deployer / owner / treasury:** `0xA4A83AF03b1a264d4D8CE211c71Fd1c07cE5e561`
- **Cosigner:** `0xA4A83AF03b1a264d4D8CE211c71Fd1c07cE5e561` (= deployer; bring-up default)
- **Permit2:** `0x000000000022D473030F116dDEE9F6B43aC78BA3` (canonical)
- **oracleDisabled:** `true` (raw amount = ETH notional; no Uniswap V3 dependency)
- **Etherscan:** https://sepolia.etherscan.io/address/0x90a7b4d41434DfBeb019a6d05A589Eb650e55ebe

## Verified on-chain
- `FillAuction.reactor()` == PartialFillReactor ✅
- `PartialFillReactor.fillAuction()` == FillAuction ✅
- `cosigner` == deployer, `permit2` == canonical, `oracleDisabled` == true ✅

## Backend integration note
The reactor's `cosigner` is the **deployer** address. For the backend to produce orders that
validate, its signing key must match — so the Sepolia backend config (`backend/.env.sepolia`) sets
`COSIGNER_PRIVATE_KEY` to the deployer key. (Alternative: redeploy with
`COSIGNER_ADDRESS=<backend cosigner>` to keep the local-anvil cosigner.)

## Cross-chain A→B (LIVE, deployed 2026-06-30)

Chain A = Sepolia (source / WETH), Chain B = Base Sepolia (destination / USDC).

| Role | Contract | Chain | Address |
|---|---|---|---|
| Chain A source factory | **EscrowSrcFactory** | Sepolia (11155111) | `0xa4b4aA4Efc8FD8BFa83Ecc7D05bA7C90943Be553` |
| Chain A EscrowSrc impl | EscrowSrc | Sepolia | `0xC096bFee6eeef3d098Cffafe60A00fB1442A1527` |
| Chain B dest factory | **EscrowDstFactory** | Base Sepolia (84532) | `0x70727323b3a45Bb1D081fBc78E481F357B49Fc8d` |
| Chain B EscrowDst impl | EscrowDst | Base Sepolia | `0x90a7b4d41434DfBeb019a6d05A589Eb650e55ebe` |

- EscrowSrcFactory cosigner = `0xA4A8…e561` (deployer), permit2 = canonical ✅ (verified)
- EscrowDstFactory implementation set ✅ (verified)
- Base Sepolia RPC: `https://sepolia.base.org`
- Env mapping: `CROSS_CHAIN_REACTOR`/filler `ESCROW_SRC_FACTORY` = Chain A factory;
  `CHAIN_B_FACTORY` = Chain B factory. (Wired into `*/.env.sepolia`.)

## Not yet on testnet
- `FallbackExecutor` (single-chain aggregator fallback path)
- **B→A mirror** (`runChainB_Src` on Base + `runChainA_Dst` on Sepolia) — only A→B is live
- Fillers need Sepolia- **and** Base-Sepolia-funded keys to actually run cross-chain fills
