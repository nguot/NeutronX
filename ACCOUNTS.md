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
  MetaMask to act as the swapper on the frontend. It's also hardcoded as
  `DEV_SWAPPER_PK` in `filler/*/src/dev/ccFill.ts` and as `PK0` in
  `tests/crosschain/run_cc.sh`.
- All three are deployed/funded by `tests/demo/setup.sh` and
  `tests/crosschain/setup_cc.sh`.

## Chains

| Chain | chainId | RPC | Forked from |
|-------|---------|-----|-------------|
| Chain A | 31337 | http://127.0.0.1:8545 | Ethereum mainnet @ block 20,500,000 |
| Chain B | 31338 | http://127.0.0.1:8546 | Ethereum mainnet @ block 20,500,000 |

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
| USDC whale (Chain B) | `0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503` | `setup_cc.sh` impersonates this to fund Accounts 1/2 with USDC on Chain B |

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
