# Graph Report - WhaleFiller  (2026-06-14)

## Corpus Check
- 15 files · ~8,743 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 128 nodes · 236 edges · 8 communities
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

## God Nodes (most connected - your core abstractions)
1. `OrderInfo` - 10 edges
2. `wallet` - 9 edges
3. `compilerOptions` - 9 edges
4. `Executor` - 6 edges
5. `decide()` - 6 edges
6. `SUPPORTED_TOKENS` - 5 edges
7. `ERC20_ABI` - 5 edges
8. `provider` - 5 edges
9. `erc20()` - 5 edges
10. `ccFill()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `ensureApproval()` --calls--> `erc20()`  [EXTRACTED]
  src/execution/executor.ts → src/contract/contracts.ts
- `decide()` --calls--> `erc20()`  [EXTRACTED]
  src/strategy/strategy.ts → src/contract/contracts.ts
- `devFill()` --calls--> `devEnsureOutputToken()`  [EXTRACTED]
  src/dev/devFill.ts → src/dev/devFund.ts
- `bootstrap()` --calls--> `seedInventory()`  [EXTRACTED]
  src/index.ts → src/dev/seed.ts
- `bootstrap()` --calls--> `startQuoteServer()`  [EXTRACTED]
  src/index.ts → src/quote/quoteServer.ts

## Import Cycles
- None detected.

## Communities (8 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.09
Nodes (22): author, dependencies, axios, dotenv, ethers, description, devDependencies, ts-node (+14 more)

### Community 1 - "Community 1"
Cohesion: 0.17
Nodes (13): ERC20_ABI, FILL_AUCTION_ABI, POOL_ABI, REACTOR_ABI, provider, wallet, computeOrderHash(), devFill() (+5 more)

### Community 2 - "Community 2"
Cohesion: 0.18
Nodes (12): erc20(), reactor, computeOrderHash(), computeRequiredStake(), ensureApproval(), Executor, ORDER_TYPE_HASH, Registration (+4 more)

### Community 3 - "Community 3"
Cohesion: 0.18
Nodes (14): fillAuction, ERC20_ABI, fundEth(), fundFromWhale(), seedChain(), seedInventory(), TARGETS, WETH_ABI (+6 more)

### Community 4 - "Community 4"
Cohesion: 0.23
Nodes (7): fmt(), OrderListener, INVENTORY, REFERENCE_PRICES, SUPPORTED_TOKENS, FillDecision, FillSummary

### Community 5 - "Community 5"
Cohesion: 0.15
Nodes (13): compilerOptions, esModuleInterop, lib, module, outDir, resolveJsonModule, rootDir, strict (+5 more)

### Community 6 - "Community 6"
Cohesion: 0.23
Nodes (11): ESCROW_DST_ABI, ESCROW_FACTORY_ABI, ESCROW_SRC_ABI, ESCROW_SRC_FACTORY_ABI, ccClaimSlot(), ccFill(), ChainLegs, resolveLegs() (+3 more)

### Community 7 - "Community 7"
Cohesion: 0.25
Nodes (6): cors(), DECIMALS, json(), PORT, QuoteRequest, SYMBOLS

## Knowledge Gaps
- **45 isolated node(s):** `name`, `version`, `description`, `main`, `start` (+40 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `OrderListener` connect `Community 4` to `Community 3`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `OrderInfo` connect `Community 2` to `Community 1`, `Community 3`, `Community 4`, `Community 7`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `wallet` connect `Community 1` to `Community 2`, `Community 3`, `Community 4`, `Community 6`, `Community 7`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _45 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08695652173913043 - nodes in this community are weakly interconnected._