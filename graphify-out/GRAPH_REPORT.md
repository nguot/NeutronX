# Graph Report - dex-aggregator  (2026-06-16)

## Corpus Check
- 122 files · ~128,141 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 960 nodes · 1304 edges · 72 communities (58 shown, 14 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a968f850`
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
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 77|Community 77]]

## God Nodes (most connected - your core abstractions)
1. `useAppConfig()` - 24 edges
2. `Security Audit — `FillAuction.sol` & `PartialFillReactor.sol`` - 16 edges
3. `createCrossChainOrder()` - 14 edges
4. `NeutronX — Smart-Contract Test Catalogue` - 14 edges
5. `Cross-Chain Swap Test` - 13 edges
6. `db` - 11 edges
7. `compilerOptions` - 10 edges
8. `compilerOptions` - 9 edges
9. `compilerOptions` - 9 edges
10. `compilerOptions` - 9 edges

## Surprising Connections (you probably didn't know these)
- `CrossChainOrders()` --calls--> `useAppConfig()`  [EXTRACTED]
  frontend/src/components/CrossChainOrders.tsx → frontend/src/context/AppConfig.tsx
- `AdminLogin()` --calls--> `useAppConfig()`  [EXTRACTED]
  frontend/src/pages/AdminLogin.tsx → frontend/src/context/AppConfig.tsx
- `Orders()` --calls--> `useAppConfig()`  [EXTRACTED]
  frontend/src/pages/Orders.tsx → frontend/src/context/AppConfig.tsx
- `Simulate()` --calls--> `toWei()`  [INFERRED]
  frontend/src/pages/Simulate.tsx → frontend/src/pages/CrossChain.tsx
- `requireAdmin()` --calls--> `verifyToken()`  [EXTRACTED]
  backend/src/routes/admin.ts → backend/src/services/adminAuth.ts

## Import Cycles
- None detected.

## Communities (72 total, 14 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (74): ERC20_ABI, ESCROW_SRC_ABI, ESCROW_SRC_FACTORY_ABI, SAFETY_DEPOSIT, claimQueues, ESCROW_DST_ABI, EscrowDstWatcherOpts, FACTORY_ABI (+66 more)

### Community 1 - "Community 1"
Cohesion: 0.07
Nodes (29): readEnvFile(), requireAdmin(), router, writeEnvFile(), router, router, coverageAt(), MIN_FILL_CANDIDATES (+21 more)

### Community 2 - "Community 2"
Cohesion: 0.05
Nodes (36): 1. Signature standard (EIP-712), 2. Merkle tree — build off-chain, verify on-chain, 3.2 — Source/destination legs not bound to the same filler 🟠 (cosigner-enforced), 3.6 — Last-slot output underfunding 🟡 (fixed, off-chain validation), 3.7 — 1-wei safety deposit 🟢 (fixed on-chain), 3.8 — Zero-amount non-final slots 🟢 (fixed on-chain), 3. Nonce, 4. Cross-chain timelock ordering (`T2 < T1`) — 🟠 High, not enforced on-chain (+28 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (26): author, dependencies, cors, dotenv, ethers, express, pg, @uniswap/sdk-core (+18 more)

### Community 4 - "Community 4"
Cohesion: 0.11
Nodes (23): router, cancelOrder(), createOrder(), ERC20_ABI, getDomainSeparator(), getFillerSwapFills(), getOrder(), getOrders() (+15 more)

### Community 5 - "Community 5"
Cohesion: 0.09
Nodes (22): author, dependencies, axios, dotenv, ethers, description, devDependencies, ts-node (+14 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (22): author, dependencies, axios, dotenv, ethers, description, devDependencies, ts-node (+14 more)

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
Cohesion: 0.12
Nodes (16): 0. The one-paragraph mental model, 1. File map (what each file is, one line each), 2. Reading order (code ↔ test, bottom-up), 3. The life of an order (single-chain happy path), 4. Mental model / invariant per file (the thing to actually remember), 5. Rebuild from scratch (M0 → M7), test-first, 6. Tooling & commands, 7. Self-quiz (if you can answer these, you understand it) (+8 more)

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
Cohesion: 0.22
Nodes (6): cors(), DECIMALS, json(), PORT, QuoteRequest, SYMBOLS

### Community 31 - "Community 31"
Cohesion: 0.22
Nodes (6): cors(), DECIMALS, json(), PORT, QuoteRequest, SYMBOLS

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
Cohesion: 0.36
Nodes (9): ERC20_ABI, fundEth(), fundFromWhale(), seedChain(), seedInventory(), TARGETS, WETH_ABI, WHALES (+1 more)

### Community 38 - "Community 38"
Cohesion: 0.36
Nodes (9): ERC20_ABI, fundEth(), fundFromWhale(), seedChain(), seedInventory(), TARGETS, WETH_ABI, WHALES (+1 more)

### Community 39 - "Community 39"
Cohesion: 0.25
Nodes (7): Accounts & Token Addresses (Devnet Reference), Anvil dev accounts, Chains, Checking balances (cast), Deployed contracts — re-deployed every run, check `backend/.env`, Infra, Tokens

### Community 40 - "Community 40"
Cohesion: 0.25
Nodes (7): ERC20_ABI, ESCROW_DST_ABI, ESCROW_FACTORY_ABI, ESCROW_SRC_ABI, ESCROW_SRC_FACTORY_ABI, FILL_AUCTION_ABI, REACTOR_ABI

### Community 41 - "Community 41"
Cohesion: 0.32
Nodes (4): computeOrderHash(), devFill(), getContracts(), ORDER_TYPE_HASH

### Community 42 - "Community 42"
Cohesion: 0.32
Nodes (4): computeOrderHash(), devFill(), getContracts(), ORDER_TYPE_HASH

### Community 43 - "Community 43"
Cohesion: 0.22
Nodes (8): Attack, Follow-up — finding 3.5 (full relief, not just a partial refund), Front-Running Griefing Fix — `FillAuction`, Proving it actually catches the bug, Running it, The fix, The test — `FrontRunGriefing.t.sol`, The vulnerability

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
Cohesion: 0.32
Nodes (11): ccClaimSlot(), ccFill(), ChainLegs, ensureDstEscrowDeployed(), fetchOrderAndSlot(), fillSlotOnSrc(), resolveLegs(), SAFETY_DEPOSIT (+3 more)

### Community 49 - "Community 49"
Cohesion: 0.32
Nodes (11): ccClaimSlot(), ccFill(), ChainLegs, ensureDstEscrowDeployed(), fetchOrderAndSlot(), fillSlotOnSrc(), resolveLegs(), SAFETY_DEPOSIT (+3 more)

### Community 51 - "Community 51"
Cohesion: 0.33
Nodes (5): Checkpointed polling (not `contract.on()`), Event Indexer, Handlers, Reconnection, What it watches

### Community 52 - "Community 52"
Cohesion: 0.33
Nodes (5): FillAuction Solvency Invariant, How it's wired up, Running it, Sanity-checked against a real bug, What this proves

### Community 53 - "Community 53"
Cohesion: 0.33
Nodes (5): Filler-race E2E scenarios, Notes, Prerequisites, Run, What is asserted (winner-agnostic)

### Community 55 - "Community 55"
Cohesion: 0.50
Nodes (3): FillDecision, FillSummary, OrderInfo

### Community 58 - "Community 58"
Cohesion: 0.50
Nodes (3): FillDecision, FillSummary, OrderInfo

### Community 61 - "Community 61"
Cohesion: 0.36
Nodes (7): setup_cc.sh script, approve_swapper_token(), fund_and_approve_swapper(), fund_swapper_token(), LOG_FILE, TOKEN_ADDR, TOKEN_AMOUNT

### Community 72 - "Community 72"
Cohesion: 0.18
Nodes (9): AppConfig, AppConfigCtx, AppConfigProvider(), ChainConfig, Ctx, DEFAULT, deriveLegacy(), RawConfig (+1 more)

### Community 73 - "Community 73"
Cohesion: 0.13
Nodes (16): AuctionChart(), AuctionChartProps, clamp(), colorForFiller(), FillDot, FILLER_COLORS, AggregatorCheckResult, FallbackCheckResult (+8 more)

### Community 77 - "Community 77"
Cohesion: 0.09
Nodes (34): AGGREGATORS, availableAggregators(), getAggregator(), resolveAggregatorChainId(), CHAIN_NAMES, KyberBuildResponse, KyberRouteResponse, kyberswapAdapter (+26 more)

## Knowledge Gaps
- **470 isolated node(s):** `name`, `version`, `description`, `main`, `start` (+465 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `useAppConfig()` connect `Community 9` to `Community 8`, `Community 72`, `Community 10`, `Community 73`, `Community 25`, `Community 27`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `db` connect `Community 0` to `Community 1`, `Community 4`, `Community 77`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _470 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05209397344228805 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.07317073170731707 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.05405405405405406 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._