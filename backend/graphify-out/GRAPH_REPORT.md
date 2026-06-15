# Graph Report - backend  (2026-06-15)

## Corpus Check
- 37 files · ~15,596 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 243 nodes · 429 edges · 12 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `bd6093d1`
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

## God Nodes (most connected - your core abstractions)
1. `createCrossChainOrder()` - 12 edges
2. `db` - 11 edges
3. `compilerOptions` - 8 edges
4. `getChain()` - 7 edges
5. `chainIds()` - 7 edges
6. `resolveCheckpoint()` - 7 edges
7. `handleEscrow()` - 6 edges
8. `loadChainRegistry()` - 6 edges
9. `getMarketRate()` - 6 edges
10. `ensureIndexerStateTable()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `handleEscrow()` --calls--> `deriveSecret()`  [EXTRACTED]
  src/chain/escrowDstWatcher.ts → src/services/crosschainService.ts
- `createCrossChainOrder()` --calls--> `getChain()`  [EXTRACTED]
  src/services/crosschainService.ts → src/config/chains.ts
- `createCrossChainOrder()` --calls--> `chainIds()`  [EXTRACTED]
  src/services/crosschainService.ts → src/config/chains.ts
- `requireAdmin()` --calls--> `verifyToken()`  [EXTRACTED]
  src/routes/admin.ts → src/services/adminAuth.ts
- `resolveChainId()` --calls--> `resolveAggregatorChainId()`  [EXTRACTED]
  src/routes/aggregators.ts → src/services/aggregators/index.ts

## Import Cycles
- None detected.

## Communities (12 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.13
Nodes (23): ERC20_ABI, ESCROW_SRC_ABI, ESCROW_SRC_FACTORY_ABI, SAFETY_DEPOSIT, ChainConfig, chainIds(), getChain(), loadChainRegistry() (+15 more)

### Community 1 - "Community 1"
Cohesion: 0.11
Nodes (24): claimQueues, ESCROW_DST_ABI, EscrowDstWatcherOpts, FACTORY_ABI, handleEscrow(), startEscrowDstWatcher(), waitConfirmations(), withCosignerQueue() (+16 more)

### Community 2 - "Community 2"
Cohesion: 0.11
Nodes (25): AGGREGATORS, availableAggregators(), getAggregator(), resolveAggregatorChainId(), oneInchAdapter, OneInchSwapResponse, paraswapAdapter, ParaSwapPriceResponse (+17 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (26): author, dependencies, cors, dotenv, ethers, express, pg, @uniswap/sdk-core (+18 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (22): router, cancelOrder(), createOrder(), ERC20_ABI, getDomainSeparator(), getOrder(), getOrders(), getProvider() (+14 more)

### Community 5 - "Community 5"
Cohesion: 0.14
Nodes (11): router, coverageAt(), MIN_FILL_CANDIDATES, router, FillerEntry, fillerRegistry, initFillerSchema(), FillerQuote (+3 more)

### Community 6 - "Community 6"
Cohesion: 0.29
Nodes (8): readEnvFile(), requireAdmin(), router, writeEnvFile(), getCredentials(), login(), tokenFor(), verifyToken()

### Community 7 - "Community 7"
Cohesion: 0.17
Nodes (12): compilerOptions, esModuleInterop, module, outDir, resolveJsonModule, rootDir, strict, target (+4 more)

### Community 8 - "Community 8"
Cohesion: 0.22
Nodes (8): Consumers, Limitations / notes, Order parameter suggestion — `POST /suggest-params`, PRICE gate — anchored to the live market rate, Request / response, SIZE gate — `minFillBps` chosen by a coverage search, The model: a fill happens iff TWO independent gates pass, Why coverage is the constraint

### Community 9 - "Community 9"
Cohesion: 0.33
Nodes (5): Checkpointed polling (not `contract.on()`), Event Indexer, Handlers, Reconnection, What it watches

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (25): router, buildTree(), CCTokenInfo, computeDomainSeparator(), computeLeaf(), createCrossChainOrder(), CreateOrderParams, deriveHashlock() (+17 more)

### Community 11 - "Community 11"
Cohesion: 0.27
Nodes (10): router, COINGECKO_IDS, fetchPriceLive(), fetchTokenPriceUsd(), getMarketRate(), MarketQuote, priceCache, quoteFromAlphaRouter() (+2 more)

## Knowledge Gaps
- **96 isolated node(s):** `name`, `version`, `description`, `main`, `start` (+91 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `db` connect `Community 1` to `Community 0`, `Community 2`, `Community 4`, `Community 5`, `Community 10`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _96 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.12962962962962962 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.11491935483870967 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.11363636363636363 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.11692307692307692 - nodes in this community are weakly interconnected._