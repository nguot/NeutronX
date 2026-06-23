# Graph Report - dex-aggregator  (2026-06-23)

## Corpus Check
- 132 files · ~142,565 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1117 nodes · 1458 edges · 88 communities (72 shown, 16 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3da2f09f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]

## God Nodes (most connected - your core abstractions)
1. `useAppConfig()` - 24 edges
2. `Chuẩn bị phản biện — NeutronX (DEX aggregator intent-solver)` - 19 edges
3. `Security Audit — `FillAuction.sol` & `PartialFillReactor.sol`` - 16 edges
4. `createCrossChainOrder()` - 14 edges
5. `NeutronX — Smart-Contract Test Catalogue` - 14 edges
6. `Cross-Chain Swap Test` - 13 edges
7. `db` - 11 edges
8. `Commands` - 11 edges
9. `compilerOptions` - 10 edges
10. `NeutronX contracts — a study & rebuild guide` - 10 edges

## Surprising Connections (you probably didn't know these)
- `CrossChainOrders()` --calls--> `useAppConfig()`  [EXTRACTED]
  frontend/src/components/CrossChainOrders.tsx → frontend/src/context/AppConfig.tsx
- `AdminLogin()` --calls--> `useAppConfig()`  [EXTRACTED]
  frontend/src/pages/AdminLogin.tsx → frontend/src/context/AppConfig.tsx
- `Orders()` --calls--> `useAppConfig()`  [EXTRACTED]
  frontend/src/pages/Orders.tsx → frontend/src/context/AppConfig.tsx
- `Simulate()` --calls--> `toWei()`  [INFERRED]
  frontend/src/pages/Simulate.tsx → frontend/src/pages/CrossChain.tsx
- `handleEscrow()` --calls--> `deriveSecret()`  [EXTRACTED]
  backend/src/chain/escrowDstWatcher.ts → backend/src/services/crosschainService.ts

## Import Cycles
- None detected.

## Communities (88 total, 16 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.14
Nodes (20): ERC20_ABI, ESCROW_SRC_ABI, ESCROW_SRC_FACTORY_ABI, SAFETY_DEPOSIT, router, getCrossChainOrder(), getFillerFills(), getSessionWithOrders() (+12 more)

### Community 1 - "Community 1"
Cohesion: 0.11
Nodes (18): router, router, coverageAt(), MIN_FILL_CANDIDATES, router, FillerQuote, SimQuoteRequest, SimResult (+10 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (29): A1. Ask hay gặp (xếp khả năng), A2. Scaffold (copy mẫu từ `routes/suggest.ts`), A3. Ví dụ ask "GET /orders/:hash/fills", A4. Bẫy / nhớ, A. THÊM API BACKEND (Express + pg), B1. Ask hay gặp, B2. Scaffold (kế thừa AdversarialBase — đã có sẵn mọi helper), B3. Ví dụ revert: fill sau deadline (+21 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (26): author, dependencies, cors, dotenv, ethers, express, pg, @uniswap/sdk-core (+18 more)

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (36): getAggregator(), readEnvFile(), requireAdmin(), router, writeEnvFile(), router, getCredentials(), login() (+28 more)

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (29): author, bin, cowfiller, dependencies, axios, cli-table3, commander, dotenv (+21 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (29): author, bin, whalefiller, dependencies, axios, cli-table3, commander, dotenv (+21 more)

### Community 7 - "Community 7"
Cohesion: 0.10
Nodes (4): common.sh script, _patch_env(), PATH, wire_env()

### Community 8 - "Community 8"
Cohesion: 0.11
Nodes (16): CCOrder, CCTokenInfo, CrossChainOrders(), HashRow(), Slot, WalletState, CCTokenInfo, CHAIN_NAMES (+8 more)

### Community 9 - "Community 9"
Cohesion: 0.19
Nodes (11): useAppConfig(), AdminProps, AdminTab, ChainTab(), ConfigTab(), FillerInfo, FillersTab(), FillerFill (+3 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (17): BlockEta, Eta, formatDuration(), CCMode, CCOrderSummary, CCSlotSummary, CCTokenInfo, DirectQuote (+9 more)

### Community 11 - "Community 11"
Cohesion: 0.10
Nodes (19): module, dependencies, dotenv, ethers, description, devDependencies, ts-node, @types/node (+11 more)

### Community 12 - "Community 12"
Cohesion: 0.13
Nodes (21): bootstrap(), executor, listener, decide(), sym(), match(), MatchResult, BinanceDepth (+13 more)

### Community 13 - "Community 13"
Cohesion: 0.11
Nodes (17): Architecture, backend/.env — what changed, Chain A — `fillSlot()` then `withdraw()` (one-time Permit2 setup, no per-slot approve), Chain B — `EscrowDst` (unchanged, still no approve step), Cross-Chain Swap Test, Files, Filler flow detail, Quick start (+9 more)

### Community 14 - "Community 14"
Cohesion: 0.11
Nodes (17): dependencies, ethers, react, react-dom, devDependencies, @types/react, @types/react-dom, typescript (+9 more)

### Community 15 - "Community 15"
Cohesion: 0.12
Nodes (16): C-1 — Price parameters are unauthenticated and `minOutputAmount` is never enforced, C-2 — Fallback and partial-fill paths are not mutually exclusive, H-1 — Losing or blocked registrants forfeit their entire stake, H-2 — Swapper can grief stakers via cancellation, L-1 — Permit2 allowance is not bound to an order; full trust in the cosigner, L-2 — Unsafe casts and unbounded setters, L-3 — Nonce invalidation & EIP-712 domain (informational), M-1 — Final-fill output underflows under price decay (+8 more)

### Community 16 - "Community 16"
Cohesion: 0.10
Nodes (20): 0. The one-paragraph mental model, 1. File map (what each file is, one line each), 2. Reading order (code ↔ test, bottom-up), 3. The life of an order (single-chain happy path), 4. Mental model / invariant per file (the thing to actually remember), 5. Rebuild from scratch (M0 → M7), test-first, 6. Tooling & commands, 7. Self-quiz (if you can answer these, you understand it) (+12 more)

### Community 17 - "Community 17"
Cohesion: 0.12
Nodes (12): POOL_ABI, ERC20_ABI, ESCROW_DST_ABI, ESCROW_FACTORY_ABI, ESCROW_SRC_ABI, ESCROW_SRC_FACTORY_ABI, FILL_AUCTION_ABI, REACTOR_ABI (+4 more)

### Community 18 - "Community 18"
Cohesion: 0.13
Nodes (14): 1. Library unit tests (`test/libs/`), 2. Core contract tests, 3. Stateful invariant (`test/invariant/`), 4. Security-fix regression (`test/AuditFixes.t.sol`), 5. Adversarial / MEV suite (`test/adversarial/`) — thesis centrepiece, 6. Cross-chain escrow (`test/crosschain/`), 7. Fork tests (mainnet — need `ALCHEMY_RPC_URL`), 8. Live filler-race E2E (`tests/race/`, not Foundry) (+6 more)

### Community 19 - "Community 19"
Cohesion: 0.15
Nodes (13): compilerOptions, esModuleInterop, lib, module, outDir, resolveJsonModule, rootDir, strict (+5 more)

### Community 20 - "Community 20"
Cohesion: 0.21
Nodes (7): computeOrderHash(), computeRequiredStake(), ensureApproval(), Executor, ORDER_TYPE_HASH, Registration, toSignedOrder()

### Community 21 - "Community 21"
Cohesion: 0.21
Nodes (7): computeOrderHash(), computeRequiredStake(), ensureApproval(), Executor, ORDER_TYPE_HASH, Registration, toSignedOrder()

### Community 22 - "Community 22"
Cohesion: 0.15
Nodes (13): compilerOptions, esModuleInterop, lib, module, outDir, resolveJsonModule, rootDir, strict (+5 more)

### Community 23 - "Community 23"
Cohesion: 0.15
Nodes (13): compilerOptions, esModuleInterop, lib, module, outDir, resolveJsonModule, rootDir, strict (+5 more)

### Community 24 - "Community 24"
Cohesion: 0.17
Nodes (12): compilerOptions, esModuleInterop, module, outDir, resolveJsonModule, rootDir, strict, target (+4 more)

### Community 25 - "Community 25"
Cohesion: 0.23
Nodes (9): SuggestPanel(), requestSuggestion(), SuggestArgs, Suggestion, ActiveOrder, ERC_ABI, Fill, P2_ABI (+1 more)

### Community 26 - "Community 26"
Cohesion: 0.17
Nodes (11): compilerOptions, esModuleInterop, jsx, lib, module, moduleResolution, noEmit, skipLibCheck (+3 more)

### Community 27 - "Community 27"
Cohesion: 0.16
Nodes (10): ApprovalRow, CCTokenInfo, ERC_ABI, Explore(), ICON_COLORS, MAX_UINT160, MAX_UINT48, P2_ABI (+2 more)

### Community 28 - "Community 28"
Cohesion: 0.26
Nodes (10): DevAccount, getDevAccounts(), ERC20_ABI, fundAccount(), fundEth(), fundFromWhale(), main(), provider (+2 more)

### Community 29 - "Community 29"
Cohesion: 0.18
Nodes (10): 1. Tables must never default to all-zero, 2. Boundary-adjacent sampling, not interior sampling, DynamicStakeLib: collateral + refund (Layer 2), Running it, Sanity-checked against a broken refund-table row, Takeaway, The fix: split stake into collateral + refund, Two issues carried over from the original design, still fixed (+2 more)

### Community 30 - "Community 30"
Cohesion: 0.29
Nodes (4): cors(), json(), PORT, QuoteRequest

### Community 31 - "Community 31"
Cohesion: 0.29
Nodes (4): cors(), json(), PORT, QuoteRequest

### Community 32 - "Community 32"
Cohesion: 0.22
Nodes (7): CHAIN_RPCS, INITIAL, useWallet(), Window, Inner(), NAV, Tab

### Community 34 - "Community 34"
Cohesion: 0.22
Nodes (8): Consumers, Limitations / notes, Order parameter suggestion — `POST /suggest-params`, PRICE gate — anchored to the live market rate, Request / response, SIZE gate — `minFillBps` chosen by a coverage search, The model: a fill happens iff TWO independent gates pass, Why coverage is the constraint

### Community 35 - "Community 35"
Cohesion: 0.42
Nodes (8): setup.sh script, err(), ok(), PATH, start_chain(), step(), update_env_var(), warn()

### Community 36 - "Community 36"
Cohesion: 0.22
Nodes (8): Cross-Chain HTLC — KeyDistributor Server & TEE Hardening Notes, Current Trust Model, Minimum changes needed for TEE, Recommended stack options, TODO: TEE Hardening => Just run it client side, What TEE gives you, What the KeyDistributor Server Does, Why we're skipping it now

### Community 37 - "Community 37"
Cohesion: 0.07
Nodes (29): 0. "Đồ án chỉ là vài contract khớp lệnh từng phần thôi à?", 10. FillAuction — slash, cơ chế toán học, bảng tham số, hiệu chỉnh, 10a. Hàm `slash` — "ai cũng gọi được à?", 10b. Ba công thức, 10c. Vì sao chia 10^4, 10d. Vì sao bảng như vậy — KHÔNG cảm tính (suy từ mục đích), 10e. Hiệu chỉnh: code, độ khó, dữ liệu, 11. "Bridge giữ tài sản nên dễ bị tấn công — escrow của anh khác gì?" (+21 more)

### Community 38 - "Community 38"
Cohesion: 0.17
Nodes (16): EscrowSrcWatcherOpts, FACTORY_ABI, handleSlotFilled(), CHUNK_SIZE, DEV_REWIND_LAG, ensureIndexerStateTable(), getCheckpoint(), queryFilterChunked() (+8 more)

### Community 39 - "Community 39"
Cohesion: 0.25
Nodes (7): Accounts & Token Addresses (Devnet Reference), Anvil dev accounts, Chains, Checking balances (cast), Deployed contracts — re-deployed every run, check `backend/.env`, Infra, Tokens

### Community 40 - "Community 40"
Cohesion: 0.25
Nodes (7): ERC20_ABI, ESCROW_DST_ABI, ESCROW_FACTORY_ABI, ESCROW_SRC_ABI, ESCROW_SRC_FACTORY_ABI, FILL_AUCTION_ABI, REACTOR_ABI

### Community 41 - "Community 41"
Cohesion: 0.09
Nodes (21): A1. Cài, A2. Chạy, A3. Phân loại kết quả (việc chính, Claude hỗ trợ), A4. Báo cáo trong luận văn / phản biện, B1. Là gì (nhắc lại), B2. Công cụ (verify bản mới nhất đầu session), B3. ⚠ Vướng chính: tốc độ, B4. Quy trình (+13 more)

### Community 42 - "Community 42"
Cohesion: 0.16
Nodes (21): buildTree(), CCTokenInfo, computeDomainSeparator(), computeLeaf(), createCrossChainOrder(), CreateOrderParams, deriveHashlock(), deriveMasterSecret() (+13 more)

### Community 43 - "Community 43"
Cohesion: 0.12
Nodes (16): 3.2 — Token fee-on-transfer qua kế toán danh nghĩa (Cao), 3.3 — Watcher bỏ qua sự kiện lịch sử sau outage dài (Cao), Biến môi trường mới (đều có mặc định an toàn), Cách sửa, Cách sửa, Ghi chú sửa lỗi audit Trufy — 3.2 & 3.3, Kiểm chứng, Kiểm chứng (+8 more)

### Community 44 - "Community 44"
Cohesion: 0.33
Nodes (5): INVENTORY, SUPPORTED_TOKENS, decide(), sym(), REFERENCE_PRICES

### Community 45 - "Community 45"
Cohesion: 0.47
Nodes (4): _lib_cc.sh script, check_backend(), log(), run_cmd()

### Community 46 - "Community 46"
Cohesion: 0.33
Nodes (4): fillAuction, provider, reactor, wallet

### Community 47 - "Community 47"
Cohesion: 0.12
Nodes (15): `balances`, `cc claim <hash> <slot>`, `cc fill <hash> <slot>`, `cc list`, `cc reset <hash> <slot>`, Commands, `fill <hash> [--pct <n>]`, Filler CLI (+7 more)

### Community 49 - "Community 49"
Cohesion: 0.22
Nodes (12): startEscrowSrcWatcher(), ChainConfig, chainIds(), getChain(), loadChainRegistry(), otherChain(), initCrossChainSchema(), COMMON_TOKENS (+4 more)

### Community 51 - "Community 51"
Cohesion: 0.33
Nodes (5): Checkpointed polling (not `contract.on()`), Event Indexer, Handlers, Reconnection, What it watches

### Community 52 - "Community 52"
Cohesion: 0.33
Nodes (5): FillAuction Solvency Invariant, How it's wired up, Running it, Sanity-checked against a real bug, What this proves

### Community 53 - "Community 53"
Cohesion: 0.33
Nodes (5): Filler-race E2E scenarios, Notes, Prerequisites, Run, What is asserted (winner-agnostic)

### Community 54 - "Community 54"
Cohesion: 0.23
Nodes (6): dec(), human(), humanRaw(), priceHuman(), ratio(), TOKENS

### Community 55 - "Community 55"
Cohesion: 0.50
Nodes (3): FillDecision, FillSummary, OrderInfo

### Community 56 - "Community 56"
Cohesion: 0.18
Nodes (4): cc, orderView(), program, renderSim()

### Community 58 - "Community 58"
Cohesion: 0.50
Nodes (3): FillDecision, FillSummary, OrderInfo

### Community 61 - "Community 61"
Cohesion: 0.36
Nodes (7): setup_cc.sh script, approve_swapper_token(), fund_and_approve_swapper(), fund_swapper_token(), LOG_FILE, TOKEN_ADDR, TOKEN_AMOUNT

### Community 70 - "Community 70"
Cohesion: 0.29
Nodes (11): ChainLegs, crossChainClaim(), crossChainFill(), ensureDstEscrowDeployed(), fetchOrderAndSlot(), fillSlotOnSrc(), resolveLegs(), SAFETY_DEPOSIT (+3 more)

### Community 71 - "Community 71"
Cohesion: 0.23
Nodes (6): dec(), human(), humanRaw(), priceHuman(), ratio(), TOKENS

### Community 72 - "Community 72"
Cohesion: 0.18
Nodes (9): AppConfig, AppConfigCtx, AppConfigProvider(), ChainConfig, Ctx, DEFAULT, deriveLegacy(), RawConfig (+1 more)

### Community 73 - "Community 73"
Cohesion: 0.13
Nodes (16): AuctionChart(), AuctionChartProps, clamp(), colorForFiller(), FillDot, FILLER_COLORS, AggregatorCheckResult, FallbackCheckResult (+8 more)

### Community 74 - "Community 74"
Cohesion: 0.18
Nodes (4): cc, orderView(), program, renderSim()

### Community 75 - "Community 75"
Cohesion: 0.29
Nodes (11): ChainLegs, crossChainClaim(), crossChainFill(), ensureDstEscrowDeployed(), fetchOrderAndSlot(), fillSlotOnSrc(), resolveLegs(), SAFETY_DEPOSIT (+3 more)

### Community 76 - "Community 76"
Cohesion: 0.25
Nodes (10): claimQueues, ESCROW_DST_ABI, EscrowDstWatcherOpts, FACTORY_ABI, handleEscrow(), startEscrowDstWatcher(), waitConfirmations(), withCosignerQueue() (+2 more)

### Community 77 - "Community 77"
Cohesion: 0.09
Nodes (33): AGGREGATORS, availableAggregators(), resolveAggregatorChainId(), CHAIN_NAMES, KyberBuildResponse, KyberRouteResponse, kyberswapAdapter, oneInchAdapter (+25 more)

### Community 78 - "Community 78"
Cohesion: 0.24
Nodes (5): ChainBalances, fetchOpenOrders(), fetchOrders(), readBalances(), readChain()

### Community 79 - "Community 79"
Cohesion: 0.29
Nodes (9): ERC20_ABI, fundEth(), fundFromWhale(), seedChain(), seedInventory(), TARGETS, WETH_ABI, WHALES (+1 more)

### Community 80 - "Community 80"
Cohesion: 0.24
Nodes (5): ChainBalances, fetchOpenOrders(), fetchOrders(), readBalances(), readChain()

### Community 81 - "Community 81"
Cohesion: 0.29
Nodes (9): ERC20_ABI, fundEth(), fundFromWhale(), seedChain(), seedInventory(), TARGETS, WETH_ABI, WHALES (+1 more)

### Community 82 - "Community 82"
Cohesion: 0.47
Nodes (4): computeOrderHash(), fill(), getContracts(), ORDER_TYPE_HASH

### Community 83 - "Community 83"
Cohesion: 0.47
Nodes (4): computeOrderHash(), fill(), getContracts(), ORDER_TYPE_HASH

## Knowledge Gaps
- **554 isolated node(s):** `name`, `version`, `description`, `main`, `start` (+549 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `db` connect `Community 38` to `Community 0`, `Community 4`, `Community 42`, `Community 76`, `Community 77`, `Community 49`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `useAppConfig()` connect `Community 9` to `Community 8`, `Community 72`, `Community 10`, `Community 73`, `Community 25`, `Community 27`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _554 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.13768115942028986 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.11384615384615385 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06666666666666667 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._