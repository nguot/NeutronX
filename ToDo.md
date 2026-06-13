làm gì đã ? chạy code và test => (không nghiên cứu thêm gì) => lên mục lục 

Both filler .envs already have DEV_MODE=true, the right ports (Whale 3001, CoW 3002), and deployed addresses — so seeding auto-runs on start and the UIs come up on those ports. Here's the full runbook (all in WSL, root ~/Documents/DATN/dex-aggregator):

Run it — step by step

1. Database (one terminal, or it stays running):
docker start neutronx-db

2. Anvil mainnet fork — terminal 1, leave running:
cd ~/Documents/DATN/dex-aggregator/contract
anvil --fork-url https://eth-mainnet.g.alchemy.com/v2/<YOUR_KEY>
# listens on http://127.0.0.1:8545

3. Deploy contracts — terminal 2:
cd ~/Documents/DATN/dex-aggregator/contract
source .env
forge script script/Deploy.s.sol:Deploy --rpc-url http://localhost:8545 --broadcast
The deploy addresses are deterministic (same deployer + nonce sequence on a fresh fork), so they should match what's already in your .env files. If they differ, update FILL_AUCTION / PARTIAL_FILL_REACTOR / FALLBACK_EXECUTOR in contract/.env, backend/.env, and both filler/*/.env.

4. Backend — terminal 3:
cd ~/Documents/DATN/dex-aggregator/backend
npm start          # port 3000

5. Fillers — terminals 4 & 5 (this is the part you changed):
cd ~/Documents/DATN/dex-aggregator/filler/WhaleFiller
npm start          # seeds inventory on startup → UI http://localhost:3001

cd ~/Documents/DATN/dex-aggregator/filler/CoWFiller
npm start          # seeds inventory on startup → UI http://localhost:3002
On start you'll see [Seed] … logs funding the wallet (100k ETH, 5k WETH, 20M USDC/USDT, 5M DAI). To re-fund without restarting:
npm run fund       # in either filler dir

6. Frontend (optional, to submit orders) — terminal 6:
cd ~/Documents/DATN/dex-aggregator/frontend

npx serve . -p 8080

See the new UI

Open http://localhost:3002/ (CoW, green) and http://localhost:3001/ (Whale, magenta) — you'll get the PowerShell-console look with the ASCII banner and progress bars. Submit
See the new UI

Open http://localhost:3002/ (CoW, green) and http://localhost:3001/ (Whale, magenta) — you'll get the PowerShell-console look with the ASCII banner and progress bars. Submit an order from the frontend (or your usual order-submit flow), then in a filler UI set the slider % and click [ fill ]. Watch the ASCII progress bar advance as the two fillers partial-fill it.

Notes

- Order of startup matters: anvil (2) → deploy (3) → backend (4) → fillers (5). The seed step in the fillers calls anvil RPCs, so anvil must be up first (it is, by step 2).
- Cross-chain section ("⛓ Cross-Chain Orders") needs a second anvil on 8546 + CC setup; without it the panel just shows "CC unavailable" — harmless for single-chain demos.
- Alternative one-shot: bash tests/race/race_one_order.sh orchestrates a full two-filler race (needs foundry, jq, Docker/Postgres, node_modules, fork RPC) — good for a scripted demo rather than clicking the UI.

If a filler errors on start with a contract-address or code=0x message, that means the .env addresses don't match the current deploy — re-run step 3 and sync the addresses.