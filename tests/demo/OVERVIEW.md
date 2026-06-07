# NeutronX Demo — Test Overview

## What this test is

A full end-to-end scenario of a Dutch auction partial-fill order driven through every
lifecycle phase: order submission → filler competition → partial fills → fallback sweep.

Run in 3 versions that fork Ethereum mainnet at different blocks, giving a different
Chainlink ETH/USD price each time. Same order parameters, same contracts — only the
market context changes, producing three structurally different outcomes.

---

## Order Parameters (identical across all versions)

| Field            | Value                  | Meaning                              |
|------------------|------------------------|--------------------------------------|
| inputToken       | WETH                   | 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 |
| outputToken      | USDC                   | 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 |
| inputAmount      | 4,000,000,000,000,000,000 | 4.0 WETH |
| minOutputAmount  | 9,500,000,000          | 9,500 USDC minimum |
| startPrice       | 2,490,000,000          | 2490 USDC/WETH starting auction price |
| decayPerBlock    | 100,000                | 0.1 USDC per block decay |
| deadline         | currentBlock + 100     | ~100 blocks (~20 min at 12s/block) |
| minFillBps       | 100                    | 1% minimum fill chunk |
| feeTier          | 500                    | Uniswap V3 0.05% pool for fallback  |

**Price range of the auction:** 2490 USDC/WETH → 2480 USDC/WETH over 100 blocks.
The total decay across the full window is only 10 USDC — a very tight band.
This means filler profitability is dominated almost entirely by market price, not decay.

---

## Actors

| Role           | Address                                      | Private Key (Anvil default) |
|----------------|----------------------------------------------|-----------------------------|
| Swapper / Deployer | 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 | 0xac0974...f2ff80 |
| WhaleFiller    | 0x70997970C51812dc3A010C7d01b50e0d17dc79C8   | 0x59c699...8690d  |
| CoWFiller      | 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC   | 0x5de411...365a   |

Starting balances after setup.sh:
- Swapper: 5 WETH, 0 USDC
- WhaleFiller: 0 WETH, 5,000 USDC
- CoWFiller: 0 WETH, 10,000 USDC

---

## Version 1 — Neutral Market (fork block 20,500,000 ≈ Sep 2024)

### Blockchain state at fork
| Property             | Value                                |
|----------------------|--------------------------------------|
| Fork block           | 20,500,000                           |
| Approximate date     | September 2024                       |
| Chainlink ETH/USD    | ~$2,500                              |
| Uniswap WETH/USDC TVL| High (mainnet liquidity)             |
| USDC supply          | Normal — whale funded                |

### Filler strategy evaluation
```
auctionPrice = 2490 USDC/WETH  (at startPrice, before any decay)
marketPrice  = 2500 USDC/WETH  (Chainlink at fork block)
spread       = +10 USDC/WETH   (+0.4%)  → PROFITABLE (barely)

WhaleFiller:
  usableBalance = 5000 * 50% = 2500 USDC
  fillAmount    = 2500 / 2490 ≈ 1.004 WETH
  spread_bps    = (2500-2490)/2500 * 10000 = 40bps  ≥ MIN_SPREAD(10bps) → FILL

CoWFiller (greedy bid match):
  bids: [2510@2WETH, 2505@3WETH, 2500@5WETH, ...]
  all bids > auctionPrice(2490) → profitable
  fill = 2.008 WETH across 2 profitable bid levels
  profit ≈ 40 USDC → FILL
```

### Expected output per step

| Step | Action                        | Expected                                          |
|------|-------------------------------|---------------------------------------------------|
| 1    | submit_order.sh               | orderHash returned, status=pending in DB          |
| 2    | Fillers poll (auto, ~6s)      | Both log: ✦ new order ... 4.0000 WETH → 9500 USDC |
| 3    | Mine into register window     | Strategy evaluates: 40bps spread → ✔ FILL         |
| 3    | FillAuction.register()        | Two separate txs, different wallets, no conflict  |
| 4    | Mine 1 block (execute)        | Both fillers call executePartialChunk()           |
| 4    | Reactor first fill            | EIP-712 signature validated, Permit2 pulls WETH   |
| 4    | WhaleFiller fill              | Delivers ~2500 USDC, receives ~1.004 WETH         |
| 4    | CoWFiller fill                | Delivers ~5002 USDC, receives ~2.008 WETH         |
| 5    | Event indexer                 | 2 rows inserted in fills table, status=active     |
| 6    | Mine into fallback window     | blocksLeft ≤ 10 → fallbackWatcher fires           |
| 7    | FallbackExecutor sweeps       | 0.988 WETH remaining → Uniswap → ~2475 USDC       |
| 7    | Event indexer                 | 3rd fill row, status=filled                       |

### Final state
```
Order status:   filled
Total fills:    3
  Fill 1 (WhaleFiller):  ~1.004 WETH consumed, ~2500 USDC paid to swapper
  Fill 2 (CoWFiller):    ~2.008 WETH consumed, ~5002 USDC paid to swapper
  Fill 3 (Fallback):     ~0.988 WETH consumed, ~2450 USDC from Uniswap

Swapper received: ~9952 USDC total for 4 WETH
                  (above 9500 minimum — Dutch auction worked)

WhaleFiller balance: +~1.004 WETH, -~2500 USDC  (sells WETH at $2500 market = breakeven+gas)
CoWFiller balance:   +~2.008 WETH, -~5002 USDC
```

---

## Version 2 — Bull Market (fork block 19,500,000 ≈ Mar 2024)

### Blockchain state at fork
| Property             | Value                                |
|----------------------|--------------------------------------|
| Fork block           | 19,500,000                           |
| Approximate date     | March 2024 (ETF approval rally)      |
| Chainlink ETH/USD    | ~$3,500                              |
| Uniswap WETH/USDC TVL| High                                 |

### Filler strategy evaluation
```
auctionPrice = 2490 USDC/WETH
marketPrice  = 3500 USDC/WETH
spread       = +1010 USDC/WETH (+40.6%)  → EXTREMELY PROFITABLE

WhaleFiller:
  usableBalance = 5000 * 50% = 2500 USDC
  fillAmount    = 2500 / 2490 ≈ 1.004 WETH
  spread_bps    = (3500-2490)/3500 * 10000 = 2886bps → FILL IMMEDIATELY

CoWFiller:
  all bids >> auctionPrice by huge margin
  fill = ~2.008 WETH (greedy fills all profitable levels)
  profit ≈ 2028 USDC → FILL IMMEDIATELY
```

Both fillers register at the FIRST BLOCK of the register window (blocksLeft=60)
rather than waiting for more decay — the spread is already enormous.

### Expected output per step

| Step | Action                       | Expected                                          |
|------|------------------------------|---------------------------------------------------|
| 1    | submit_order.sh              | orderHash, status=pending                         |
| 2    | Fillers poll                 | Both log new order immediately                    |
| 3    | Mine into register window    | Both register at first opportunity, no delay      |
| 4    | Mine 1 block                 | Both execute immediately                          |
| 4    | WhaleFiller + CoWFiller fill | ~3.012 WETH filled (75.3% of order)               |
| 5    | Check remaining              | ~0.988 WETH left, status=active                   |
| 6    | Mine into fallback window    | fallbackWatcher fires                             |
| 7    | FallbackExecutor             | Swaps ~0.988 WETH → ~3458 USDC at market price   |

### Final state
```
Order status:   filled
Total fills:    3

Swapper received: ~2500 + ~5002 + ~3458 = ~10960 USDC for 4 WETH
                  (~15% above 9500 minimum — bull market benefits swapper)

WhaleFiller:  +1.004 WETH  (market value = $3514, paid $2500 USDC → +$1014 profit)
CoWFiller:    +2.008 WETH  (market value = $7028, paid $5002 USDC → +$2026 profit)

KEY OBSERVATION: Filler profits are massive. In a real system, competition
would push fillers to fill faster / at lower spread, benefiting the swapper.
NeutronX's Dutch auction would need a slower decay to let competition drive
price improvement on bull days.
```

---

## Version 3 — Bear Market (fork block 17,000,000 ≈ Apr 2023)

### Blockchain state at fork
| Property             | Value                                |
|----------------------|--------------------------------------|
| Fork block           | 17,000,000                           |
| Approximate date     | April 2023 (post-Merge bear market)  |
| Chainlink ETH/USD    | ~$1,900                              |
| Uniswap WETH/USDC TVL| Lower than 2024 but sufficient       |

### Filler strategy evaluation
```
auctionPrice = 2490 USDC/WETH
marketPrice  = 1900 USDC/WETH
spread       = -590 USDC/WETH (-23.7%)  → LOSS — do not fill

For price to reach market: 2490 - 590 = 1900 needs 590/0.1 = 5900 blocks of decay
Order only lasts 100 blocks → price never reaches market → NO FILLER EVER FILLS

WhaleFiller: shouldFill = false (spread < 0)  → skip every block
CoWFiller:   no bids above auctionPrice 2490  → no match → skip
```

### Expected output per step

| Step | Action                       | Expected                                           |
|------|------------------------------|----------------------------------------------------|
| 1    | submit_order.sh              | orderHash, status=pending                          |
| 2    | Fillers poll                 | Both detect order but log: ✗ spread negative       |
| 3    | Mine into register window    | No registration from either filler                 |
| 4    | Mine 1 block                 | Nothing happens — no fills                         |
| 5    | Check remaining              | 4 WETH still remaining, status=pending             |
| 6    | Mine into fallback window    | fallbackWatcher fires (this is the ONLY fill)      |
| 7    | FallbackExecutor             | Swaps all 4 WETH → ~7520 USDC at Uniswap          |
| 7    | Status update                | 1 fill row (fallback), status=filled               |

### Final state
```
Order status:   filled
Total fills:    1  (fallback only)

Swapper received: ~7520 USDC for 4 WETH  (~1880 USDC/WETH)
                  ← BELOW 9500 minOutputAmount ←
                  This is the protocol LIMITATION:
                  the fallback executor guarantees EXECUTION but not MIN PRICE.
                  It uses AlphaRouter's slippage tolerance (0.5%), not the order floor.

WhaleFiller:  unchanged (0 WETH gained, USDC intact)
CoWFiller:    unchanged

DESIGN NOTE: A production system would add a check in FallbackExecutor:
  require(amountOut >= order.minOutputAmount * remaining / totalInput)
  to revert if market price cannot meet the swapper's floor.
  Currently this check is absent — considered a known limitation (see Ch9).
```

---

## How to run

### Terminal layout (5 terminals needed in WSL)

```
T1: version anvil    →  ./tests/demo/v1_neutral_anvil.sh   (or v2/v3)
T2: backend          →  cd backend && npm start
T3: WhaleFiller      →  cd filler/WhaleFiller && npm start
T4: CoWFiller        →  cd filler/CoWFiller && npm start
T5: orchestrator     →  (run all the scripts below in sequence)
```

### Script sequence (T5)

```bash
# 1. After T1 (Anvil) is running:
./tests/demo/setup.sh

# 2. After T2/T3/T4 are running:
./tests/demo/submit_order.sh

# 3. Drive phases (press ENTER between each):
./tests/demo/run.sh

# 4. Check final state:
./tests/demo/verify.sh
```

Use `./tests/demo/run.sh --auto` to skip interactive pauses (for scripted recording).

---

## Log files

All scripts append to the same log file for a given run:
```
tests/demo/logs/demo_<version>_<YYYYMMDD_HHMMSS>.log
```

The active log path is stored in `tests/demo/logs/.current_run`.
Each run creates a new log file. Old logs are kept (never overwritten).

---

## Known limitations per version

| Limitation                         | v1 | v2 | v3 |
|------------------------------------|----|----|-----|
| Strategy oracle is a stub (no real Chainlink read yet) | affects all | affects all | affects all |
| Fillers fill in all versions because stub returns true  | ✓ fills | ✓ fills | fills unexpectedly |
| Swapper receives below minOutputAmount                  |    |    | ✓ (bear market) |
| FallbackExecutor no floor price check                   |    |    | ✓ (sees ~7520 < 9500) |
| Binance REST call returns current price, not fork era   | small diff | large diff | very large diff |

To enable real oracle-based strategy, implement `getMarketPrice()` in
`solver/src/strategy/strategy.ts` using the Chainlink address and the
`MOCK_MARKET_PRICE` env var already injected by the anvil scripts.
