# Graph Report - frontend  (2026-06-14)

## Corpus Check
- 20 files · ~14,640 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 143 nodes · 223 edges · 9 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
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
1. `useAppConfig()` - 21 edges
2. `compilerOptions` - 10 edges
3. `WalletState` - 8 edges
4. `BlockEta` - 7 edges
5. `scripts` - 4 edges
6. `AuctionChart()` - 4 edges
7. `AppConfigProvider()` - 4 edges
8. `formatDuration()` - 4 edges
9. `CrossChain()` - 4 edges
10. `Simulate()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `CrossChainOrders()` --calls--> `useAppConfig()`  [EXTRACTED]
  src/components/CrossChainOrders.tsx → src/context/AppConfig.tsx
- `Orders()` --calls--> `useAppConfig()`  [EXTRACTED]
  src/pages/Orders.tsx → src/context/AppConfig.tsx
- `BlockEta` --calls--> `useAppConfig()`  [EXTRACTED]
  src/lib/blocktime.tsx → src/context/AppConfig.tsx
- `ChainTab()` --calls--> `useAppConfig()`  [EXTRACTED]
  src/pages/Admin.tsx → src/context/AppConfig.tsx
- `ConfigTab()` --calls--> `useAppConfig()`  [EXTRACTED]
  src/pages/Admin.tsx → src/context/AppConfig.tsx

## Import Cycles
- None detected.

## Communities (9 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.10
Nodes (26): AuctionChart(), AuctionChartProps, clamp(), colorForFiller(), FillDot, FILLER_COLORS, SuggestPanel(), BlockEta (+18 more)

### Community 1 - "Community 1"
Cohesion: 0.13
Nodes (16): AppConfig, AppConfigCtx, AppConfigProvider(), ChainConfig, Ctx, DEFAULT, deriveLegacy(), RawConfig (+8 more)

### Community 2 - "Community 2"
Cohesion: 0.11
Nodes (16): CCOrder, CCTokenInfo, CrossChainOrders(), HashRow(), Slot, WalletState, CCTokenInfo, CHAIN_NAMES (+8 more)

### Community 3 - "Community 3"
Cohesion: 0.11
Nodes (17): dependencies, ethers, react, react-dom, devDependencies, @types/react, @types/react-dom, typescript (+9 more)

### Community 4 - "Community 4"
Cohesion: 0.20
Nodes (8): ApprovalRow, CCTokenInfo, ERC_ABI, Explore(), ICON_COLORS, P2_ABI, Row, short()

### Community 5 - "Community 5"
Cohesion: 0.17
Nodes (11): compilerOptions, esModuleInterop, jsx, lib, module, moduleResolution, noEmit, skipLibCheck (+3 more)

### Community 6 - "Community 6"
Cohesion: 0.22
Nodes (7): CHAIN_RPCS, INITIAL, useWallet(), Window, Inner(), NAV, Tab

### Community 7 - "Community 7"
Cohesion: 0.22
Nodes (6): Fill, Order, OrderDetail, Orders(), STATUS_COLORS, StatusFilter

## Knowledge Gaps
- **64 isolated node(s):** `name`, `version`, `type`, `dev`, `build` (+59 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `useAppConfig()` connect `Community 1` to `Community 0`, `Community 2`, `Community 4`, `Community 7`?**
  _High betweenness centrality (0.135) - this node is a cross-community bridge._
- **Why does `WalletState` connect `Community 2` to `Community 0`, `Community 4`, `Community 6`, `Community 7`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `BlockEta` connect `Community 0` to `Community 1`, `Community 2`, `Community 7`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **What connects `name`, `version`, `type` to the rest of the system?**
  _64 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.10037878787878787 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.12681159420289856 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.11255411255411256 - nodes in this community are weakly interconnected._