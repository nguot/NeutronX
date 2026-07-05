# Accounts & Token Addresses (Devnet Reference)

Single source of truth for the well-known Anvil accounts and token addresses
used across `tests/demo/`, `tests/crosschain/`, and the `filler/*` dev UIs.
All private keys below are Anvil's well-known default dev keys — public
knowledge for any local Anvil instance, safe only on local forks.

## Anvil dev accounts

| # | Role | Address | Private key |
|---|------|---------|-------------|
| 0 | Swapper / deployer | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| 1 | Filler A (CoWFiller)   — fills slot 0 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| 2 | Filler B (WhaleFiller) — fills slot 1 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |

- Account 0 is the dev "MetaMask" account — import its private key into
  MetaMask to act as the swapper on the frontend. It's also used as `PK0` in
  `tests/crosschain/run_cc.sh` to produce the swapper's signature headlessly.
  (The filler no longer holds any swapper key — it relays the swapper's
  signature from the backend via `order.swapperSig`.)
- All three are deployed/funded by `tests/demo/setup.sh` and
  `tests/crosschain/setup_cc.sh`.

## FillAuction roles (dynamic stake-config refactor, B1/B5)

`FillAuction` uses `AccessControl` instead of a single `owner` (see
`contract/DYNAMIC_STAKE_CONFIG_REFACTOR.md`). `script/Deploy.s.sol` grants 3
roles to 3 **separate** Anvil accounts (via `.env`, default = deployer if
unset) so the demo actually shows role separation instead of one EOA holding
everything:

| # | Role | Address | Private key | `.env` var |
|---|------|---------|-------------|------------|
| 0 | `DEFAULT_ADMIN_ROLE` (deployer) | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` | `PRIVATE_KEY` |
| 3 | `PARAM_ADMIN_ROLE` — calls `setStakeConfig` | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | `0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6` | `PARAM_ADMIN_ADDR` |
| 4 | `GUARDIAN_ROLE` — calls `rollback`/`cancelPendingConfig` | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` | `0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a` | `GUARDIAN_ADDR` |
| 5 | `KEEPER_ROLE` — reserved for B6 peg-giá keeper (not wired to any tx yet) | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` | `0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba` | `KEEPER_ADDR` |

`DEFAULT_ADMIN_ROLE` (account 0) is the only one that can `grantRole`/`revokeRole`
— it does NOT call `setStakeConfig` itself. Accounts 3/4/5 are otherwise unused
elsewhere in the demo, so they're free to dedicate to these roles.

## Chains

| Chain | chainId | RPC | Forked from |
|-------|---------|-----|-------------|
| Chain A | 31337 | http://127.0.0.1:8545 | Ethereum mainnet @ block 25,450,000 (~Jul 2026) |
| Chain B | 31338 | http://127.0.0.1:8546 | Ethereum mainnet @ block 25,450,000 (~Jul 2026) |

`FORK_BLOCK` is pinned in `setup.sh`/`chaina_anvil.sh`/`chainb_anvil.sh` (was
20,500,000 / ~Sep 2024 until 2026-07-05). Bump it every so often — a block
pinned too long ago starts failing `eth_feeHistory` ("pruned history
unavailable") on Alchemy's free tier, **and** the hardcoded whale addresses
below can drain over time (real balances, not fork-specific — see the Infra
table). Re-verify whale balances at the new block before bumping again:
`cast call <token> "balanceOf(address)(uint256)" <whale> --rpc-url <RPC> --block <N>`.

## Tokens

Both chains are mainnet forks, so these are the real mainnet token addresses
(and resolve to real contract code/state at the fork block).

| Symbol | Chain | Address | Decimals |
|--------|-------|---------|----------|
| WETH | A (31337) | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 18 |
| USDC | A (31337) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |
| USDT | A (31337) | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 |
| DAI  | A (31337) | `0x6B175474E89094C44Da98b954EedeAC495271d0F` | 18 |
| USDC | B (31338) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |

For the cross-chain swap, Chain A input = WETH, Chain B output = USDC.

## Infra

| Name | Address | Notes |
|------|---------|-------|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical address, same on both chains |

### Whale addresses (impersonated for dev funding — 2026-07-05 refresh)

Real mainnet balances, not fork snapshots — they drift over time (exchange hot
wallets move funds; protocol reserves are refilled by usage and drift far
less). The previous pin's whales had drained badly by 2026-07 (e.g. the old
Chain-B USDC whale went from ~543M USDC down to ~$0.01). Re-verify with `cast
call <token> "balanceOf(address)(uint256)" <whale> --rpc-url <RPC>` before
relying on these again after a long gap.

| Name | Address | Holds (≈ @ block 25,450,000) | Used by |
|------|---------|-------------------------------|---------|
| Binance 14 | `0x28C6c06298d514Db089934071355E5743bf21d60` | ~795M USDT, ~5.6M UNI, ~420K DAI, ~785K LINK, ~323 WBTC, ~45K USDC | `funding/`, `filler/*/src/funding/`, `scripts/crosschain/setup_cc.sh`, `scripts/race/common.sh` — primary whale, still deep for USDT/DAI/WBTC/LINK/UNI |
| Binance 8 | `0xF977814e90dA44bFA03b6295A0616a897441aceC` | ~$142 USDC (mostly depleted) | Same call sites — fallback, now weak; kept for compatibility |
| Curve 3pool | `0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7` | ~25.4M DAI, ~25.4M USDC, ~110M USDT | Stablecoin fallback (`funding/`, `filler/*/src/funding/`, `setup_cc.sh` as `WHALE_3`) |
| Aave V3 aUSDC reserve | `0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c` | ~256M USDC | USDC fallback everywhere, incl. dedicated `USDC_WHALE` in `setup_cc.sh` (Chain B) and `scripts/race/common.sh` |
| Deep LINK pool | `0xa6Cc3C2531FdaA6Ae1A3CA84c2855806728693e8` | ~1.2M LINK | LINK fallback in `filler/*/src/funding/seed.ts` (the 1M "infinite-ish" filler seed target exceeds Binance 14's current LINK balance) |

WBTC is deliberately NOT chased with a bigger whale — it's genuinely scarce
on-chain (~150K total supply), so `filler/*/src/funding/seed.ts`'s seed target
was lowered (500→100 WBTC) to fit comfortably under Binance 14's balance alone
instead.

**Why impersonate-a-whale-and-`transfer()` instead of just minting?** On a
mainnet fork, these are the REAL deployed token contracts — not a toy ERC20
with an open `mint()`. Each one gates issuance differently and none of it is
callable by an arbitrary address:
- **USDC** does have a real `mint()`, but it's gated behind `masterMinter()`
  (Circle's own address, `0xE982615d...` on real mainnet) — you'd have to
  impersonate THAT specific address instead, and that only works for USDC.
- **LINK** has no mint function at all — fixed supply since genesis.
- **DAI** "minting" is really opening a collateralized CDP/Vault, not a single call.
- **WBTC** minting goes through the custodian/merchant multisig system.

Impersonating a whale and calling the token's standard `transfer()` works
identically for all 7 tokens with one generic code path, instead of needing a
special case per token's actual issuance mechanism. **WETH is the one
exception that already IS "minted" directly** — `deposit()` is WETH's
permissionless wrap function, and `anvil_setBalance` gives unlimited free ETH
to wrap, so `fund.ts`/`seed.ts` call `deposit()` directly with no whale involved.

## Deployed contracts — re-deployed every run, check `backend/.env`

These addresses are CREATE-deterministic (deployer + nonce), so they change
whenever a fresh Anvil instance is redeployed. `backend/.env` always holds the
current values written by the setup scripts:

| Env var | Contract | Chain |
|---------|----------|-------|
| `FILL_AUCTION` | DutchAuctionReactor | A |
| `PARTIAL_FILL_REACTOR` | PartialFillReactor | A |
| `FALLBACK_EXECUTOR` | FallbackExecutor | A |
| `CROSS_CHAIN_REACTOR` | EscrowSrcFactory | A |
| `CHAIN_B_FACTORY` | EscrowDstFactory | B |

## Checking balances (cast)

```bash
wsl bash -lc 'export PATH="$PATH:/home/nguot/.foundry/bin" && cast call <TOKEN> "balanceOf(address)(uint256)" <ADDRESS> --rpc-url <RPC>'
```

Example — Account 0's USDC balance on Chain B:

```bash
wsl bash -lc 'export PATH="$PATH:/home/nguot/.foundry/bin" && cast call 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 "balanceOf(address)(uint256)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url http://127.0.0.1:8546'
```
