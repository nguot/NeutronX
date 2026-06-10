giao dien => lam them giao dien cho cac filler cho tuong tac de hon 
lam them 1 nut mine cho trang admin (quan ly blockchain) => de tuong tac 
1 test case the hien he thong minh chong phan manh order boi MEV bot => chung minh stake hoat dong tot (loadtest)
1 giao dien de xem don minh dang duoc filler fill dan (1 do thi Oxy)
1 test case cross chain => chứng minh chia slot theo merkle tree (2 mũ) hoạt động tốt 

filler ban chat la mang tien minh di trade xong lay duoc tien >= so tien minh muon => filler an phan lai => van de la trade o dau 

design filler = strategy + source (nguon trade o dau = CoW la orderbook, Whale la vo han tien) + cong thuc tinh lai + 1 simulate (quoter) + danh sach contract (ABI)

còn cross chain thì sao nhỉ ? 

cd ~/Documents/DATN/dex-aggregator/frontend
npm run dev          # starts Vite on port 5173 by default
Then open the printed http://localhost:5173 URL from a WSL-side browser.

(Note: my memory had npx serve . -p 8080 recorded for the frontend — that's for serving a built static bundle, not for active development. npm run dev is the right command while you're iterating on pages like the ones I just added.)

For the full app (Swap / Cross-Chain tabs need these too)

docker start neutronx-db                 # 1. DB
cd ~/Documents/DATN/dex-aggregator/backend && npm start          # 2. backend (port 3000)
cd ~/Documents/DATN/dex-aggregator/frontend && npm run dev       # 4. frontend
The new Explore tab works standalone (static directory, no backend needed); Simulate needs the backend + filler services running to get real quotes back.


Test based on which page I'm doing 

For "Swap" tab (normal Dutch-auction swap) → use tests/demo/

bash tests/demo/v1_neutral_anvil.sh   # Terminal 1: Anvil fork
bash tests/demo/setup.sh              # Terminal 2: deploys + writes addresses
setup.sh deploys FillAuction / PartialFillReactor / FallbackExecutor and auto-writes them into backend/.env (and filler/*/.env, solver/.env) — that's the "copy to backend" part, fully automated. Addresses also land in tests/demo/logs/.addresses for reference.

For "Cross-Chain" tab → use tests/crosschain/

bash tests/crosschain/chaina_anvil.sh   # Terminal 1: Chain A
bash tests/crosschain/chainb_anvil.sh   # Terminal 2: Chain B
bash tests/crosschain/setup_cc.sh       # Terminal 3: deploys + writes addresses
setup_cc.sh deploys CrossChainReactor / EscrowDstFactory and auto-writes CROSS_CHAIN_REACTOR, CHAIN_B_FACTORY, CHAIN_B_RPC into backend/.env — same deal, automated. Addresses also land in tests/crosschain/logs/.cc_addresses.

"Copy to frontend" — there is no copy step

The frontend has no .env. Both DutchAuction.tsx and CrossChain.tsx take the reactor address as a manual text input field in the UI ("PartialFillReactor Address" / "CrossChainReactor (Chain A)"). After running setup, you paste the printed address into that field — that's by design (no build-time config needed, redeploy-friendly).

So: pick demo/ for Swap, crosschain/ for Cross-Chain — run their respective *_anvil.sh + setup*.sh, then (re)start the backend so it picks up the freshly-written .env, then paste the printed reactor address into the frontend's input field. Don't run both demo sets simultaneously — they reuse the same Anvil ports/chain IDs in places and will collide.