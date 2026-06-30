# NeutronX — DEX Aggregator (Intent Solver Architecture)

Partial-fill Dutch-auction DEX aggregator with cross-chain HTLC escrow. Two competing fillers (CoWFiller, WhaleFiller) race to fill orders; a fallback executor handles anything they miss.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | https://nodejs.org |
| Foundry (forge / anvil / cast) | latest | `curl -L https://foundry.paradigm.xyz \| bash` |
| Docker Desktop | latest | https://www.docker.com (for Postgres) |
| jq | any | `apt install jq` or brew |
| WSL2 (Windows) | — | all `bash` commands below run in WSL |

---

## Repository Layout

```
contract/          Solidity contracts + Foundry tests
backend/           Node.js order-book + cosigner + watcher
filler/
  CoWFiller/       CoW-style filler bot (TypeScript)
  WhaleFiller/     Whale-style filler bot (TypeScript)
frontend/          Next.js UI
funding/           One-shot dev-account funder (TypeScript)
scripts/
  crosschain/      Cross-chain E2E scripts (setup_cc, run_cc, run_cc_reverse)
  race/            Filler-race E2E scripts (race_one_order, race_multi_order)
setup.sh           Single-chain devnet bootstrap (run this first)
chaina_anvil.sh    Chain A Anvil (port 8545, chainId 31337) — cross-chain only
chainb_anvil.sh    Chain B Anvil (port 8546, chainId 31338) — cross-chain only
ACCOUNTS.md        Dev account addresses and private keys
```

---

## Quick Start — Single Chain

This is the standard dev flow. Everything runs on one Anvil fork (mainnet fork, port 8545).

### 1. Start Postgres

```bash
docker start backend-postgres-1
# First time only — create the container:
# cd backend && docker compose up -d
```

### 2. Bootstrap the devnet

```bash
bash setup.sh
```

This does in one shot:
- Starts Chain A (port 8545) and a dummy Chain B (port 8546)
- Deploys `FillAuction`, `PartialFillReactor`, `FallbackExecutor` to Chain A
- Writes contract addresses into `backend/.env`, `filler/CoWFiller/.env`, `filler/WhaleFiller/.env`
- Runs `funding/` to give every dev account ETH + WETH + USDC

### 3. Install dependencies (first time only)

```bash
cd backend       && npm install && cd ..
cd filler/WhaleFiller && npm install && cd ../..
cd filler/CoWFiller   && npm install && cd ../..
cd frontend      && npm install && cd ..
```

### 4. Start the stack (each in its own terminal)

```bash
# Terminal 1 — backend
cd backend && npm start

# Terminal 2 — WhaleFiller
cd filler/WhaleFiller && npm start

# Terminal 3 — CoWFiller
cd filler/CoWFiller && npm start

# Terminal 4 — frontend
cd frontend && npm run dev
```

Frontend: http://localhost:3001  
Backend API: http://localhost:3000

### 5. Stop

```bash
bash setup.sh stop   # kills both Anvil forks
# Ctrl-C in backend / filler / frontend terminals
```

---

## Cross-Chain Setup (A → B and B → A)

Chain A = WETH source (port 8545, chainId 31337)  
Chain B = USDC destination (port 8546, chainId 31338)

### 1. Start Postgres + both chains (separate terminals)

```bash
# Terminal 1
docker start backend-postgres-1

# Terminal 2
bash chaina_anvil.sh

# Terminal 3
bash chainb_anvil.sh
```

### 2. Deploy cross-chain contracts + fund accounts

```bash
# Start backend first (setup_cc.sh calls /cc/session)
cd backend && npm start &

bash scripts/crosschain/setup_cc.sh
```

`setup_cc.sh` will:
- Deploy `EscrowSrcFactory` + `EscrowDstFactory` on both chains (4 factories total, for A→B and B→A)
- Update `backend/.env` and both filler `.env` files with the factory addresses
- Wrap WETH for the swapper + fillers on Chain A
- Distribute USDC to fillers on Chain B
- Fund the cosigner on both chains for gas

### 3. Restart backend (required — picks up new factory addresses)

```bash
# Ctrl-C the running backend, then:
cd backend && npm start
```

### 4. Run cross-chain E2E

```bash
# A → B (swapper sends WETH on Chain A, receives USDC on Chain B)
bash scripts/crosschain/run_cc.sh

# B → A (swapper sends USDC on Chain B, receives WETH on Chain A)
bash scripts/crosschain/run_cc_reverse.sh
```

---

## Filler Race Tests

Boots the full stack automatically (Anvil + Postgres + backend + both fillers), then submits big orders that force both fillers to cooperate.

```bash
# One order, two fillers race to fill cooperatively
bash scripts/race/race_one_order.sh

# Three orders simultaneously
bash scripts/race/race_multi_order.sh

# Smoke-test POST /suggest-params
bash scripts/race/suggest_smoke.sh
```

> These scripts start and stop their own Anvil — do NOT run them while `setup.sh` chains are running.

---

## Contract Tests

```bash
cd contract

# Run all 154 tests
forge test

# Run with gas report
forge test --gas-report

# Coverage
forge coverage
```

---

## Dev Accounts

See [ACCOUNTS.md](ACCOUNTS.md) for the full list. Quick reference:

| Role | Address | Private Key |
|------|---------|-------------|
| Deployer / Swapper | `0xf39F…2266` | `0xac097…ff80` |
| WhaleFiller | `0x7099…79C8` | `0x59c69…90d` |
| CoWFiller | `0x3C44…3BC` | `0x5de41…65a` |

These are standard Anvil dev keys — never use on mainnet.

---

## Environment Files

Each component reads its own `.env`. The files are gitignored; `setup.sh` writes contract addresses automatically. Copy the example if starting from scratch:

```bash
cp backend/.env.example        backend/.env
cp filler/WhaleFiller/.env.example  filler/WhaleFiller/.env
cp filler/CoWFiller/.env.example    filler/CoWFiller/.env
```

Key variables:

| Variable | Used by | Description |
|----------|---------|-------------|
| `FILL_AUCTION` | backend, fillers | FillAuction contract address |
| `PARTIAL_FILL_REACTOR` | backend, fillers | PartialFillReactor contract address |
| `FALLBACK_EXECUTOR` | backend | FallbackExecutor contract address |
| `DATABASE_URL` | backend | Postgres connection string |
| `COSIGNER_PRIVATE_KEY` | backend | Signs orders before fillers can fill |
| `PRIVATE_KEY` | fillers | Filler's wallet key |
| `ESCROW_SRC_FACTORY` | backend, fillers | Cross-chain: Chain A EscrowSrcFactory |
| `CHAIN_B_FACTORY` | backend, fillers | Cross-chain: Chain B EscrowDstFactory |
| `CHAIN_B_RPC` | backend, fillers | Chain B RPC URL |

---

## Sepolia Testnet Deployment

Live contracts are recorded in [contract/deployments/sepolia.md](contract/deployments/sepolia.md).  
To connect the backend/fillers to Sepolia, copy the `.env.sepolia` files:

```bash
cp backend/.env.sepolia           backend/.env
cp filler/WhaleFiller/.env.sepolia filler/WhaleFiller/.env
cp filler/CoWFiller/.env.sepolia   filler/CoWFiller/.env
```

> Sepolia has no real DEX liquidity — the partial-fill path works (oracle-disabled), but the fallback aggregator path will not find routes.
