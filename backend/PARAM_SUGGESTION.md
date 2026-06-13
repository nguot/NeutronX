# Order parameter suggestion — `POST /suggest-params`

Helps a swapper pick sane order parameters instead of guessing. Given a pair and
an input amount, it returns a ready-to-sign `startPrice / minOutputAmount /
decayPerBlock / deadline / minFillBps`, plus the **projected fill coverage** so the
UI can warn when an order would mostly route to the fallback.

This exists because of the **D-2** refund change: refunds are now keyed to the
filler's *own commitment*, so the refund table no longer doubles as a
fragmentation deterrent. Anti-fragmentation now lives in the order's `minFillBps`
— which makes choosing `minFillBps` the swapper's responsibility. This endpoint
removes the guesswork.

## The model: a fill happens iff TWO independent gates pass

```
filler fills  ⟺  (price has decayed into its profit zone)  AND  (its capacity ≥ minFill)
                  ─────────── PRICE gate ───────────             ──── SIZE gate ────
```

Every suggested parameter targets one gate.

### PRICE gate — anchored to the live market rate
Fetched from the Alpha Router (CoinGecko fallback) via `getMarketRate`. With a
`premiumBps` (default +2%) and `slippageBps` (default −1%):

| Param | Value | Why |
|---|---|---|
| `startPrice` | `market × (1 + premium)` | Start the auction **above** market so it decays *down through* the swapper's ask; competition clears it near market. Starting ≤ market would fill instantly at a below-market price with zero upside. |
| `minOutputAmount` | `inputAmount × floorPrice / 1e18`, `floorPrice = market × (1 − slippage)` | The C-1 floor — the worst total the swapper will accept; fills below it revert. |
| `decayPerBlock` | `(startPrice − floorPrice) / deadlineBlocks` | Sweep the whole ask→floor range across the order's life. Too slow → never reaches the profit zone before the deadline; too fast → crashes to the floor (worst price). Clamped to `uint32`. |
| `deadline` | `currentBlock + deadlineBlocks` (default 100) | Long enough for the sweep **and** for fillers to register/fill before the fallback window. |

### SIZE gate — `minFillBps` chosen by a coverage search
A filler only fills if its single-fill capacity ≥ `minFill = orderSize × minFillBps`.
A higher `minFillBps` ⇒ fewer fillers qualify ⇒ less coverage. So **coverage is
non-increasing in `minFillBps`**, and we want:

```
maximise   minFillBps          (bigger chunks = less fragmentation, cleaner settlement)
subject to coverage(minFillBps) ≥ targetCoverageBps     (default 90%)
```

A monotone predicate over a sorted candidate list ⇒ **binary search**:

```
CANDIDATES = [100, 250, 500, 1000, 2000, 3000, 5000, 7000, 10000]   // bps
lo, hi, best = 0, len-1, -1
while lo <= hi:
    mid = (lo + hi) / 2
    if coverage(CANDIDATES[mid]) >= target:   best = mid; lo = mid + 1   // can afford a bigger minimum
    else:                                      hi = mid - 1               // too aggressive, shrink
chosen = CANDIDATES[best]  (or CANDIDATES[0] if none meet the target)
```

`coverage(minFillBps)` is evaluated by **replaying the real registered fillers**
through `simulateOrder` (`services/fillerSim.ts`), i.e. the same machinery as
`POST /simulate`. It returns `totalFill / inputAmount` in bps.

**Why evaluate at the floor price, near the deadline.** The simulation is run with
`startPrice = floorPrice`, `decayPerBlock = 0`, `currentBlock = deadline − 10`
(`blocksLeft = 10`, above the strategy's 5-block cutoff). At the floor price the
**PRICE gate is fully open**, so the measured coverage reflects only the **SIZE
gate** (capacity vs. `minFill`) — which is exactly what we're choosing
`minFillBps` against. (In dev mode fillers fill by capacity at any price, so this
holds there too.) `≤ 4` simulate calls thanks to the binary search; results are
memoised.

### Why coverage is the constraint
Whatever the auction doesn't fill goes to the **fallback** — a public-pool Uniswap
swap that is sandwich-exposed and only gets the market rate (no auction upside).
So the swapper strictly prefers auction coverage. Hence: the **least-fragmenting
`minFillBps` that still keeps the order off the fallback.**

## Request / response

```jsonc
// POST /suggest-params
{
  "inputToken": "0x…", "outputToken": "0x…", "inputAmount": "<wei>",
  "inputDecimals": 18, "outputDecimals": 6,        // optional (default 18/6)
  "inputSymbol": "WETH", "outputSymbol": "USDC",   // optional
  "deadlineBlocks": 100,                            // optional
  "targetCoverageBps": 9000,                        // optional (90%)
  "premiumBps": 200, "slippageBps": 100             // optional (+2% / −1%)
}
```
```jsonc
{
  "startPrice": "…", "minOutputAmount": "…", "decayPerBlock": 750000,
  "deadline": 20500100, "minFillBps": 2000,
  "marketRate": "2493.10", "decayHuman": 0.75,
  "startPriceHuman": 2542.9, "floorPriceHuman": 2468.2,
  "projectedCoverageBps": 9400, "meetsTarget": true,
  "note": "Fillers can cover ~94.0% … at minFillBps=2000 …"
}
```

## Consumers
- Backend: `routes/suggest.ts` (this endpoint), reusing `services/marketRate.ts`
  and `services/fillerSim.ts`.
- Frontend: the **✨ Suggest parameters** button on the Dutch-auction order form
  (`frontend/src/pages/DutchAuction.tsx`) applies `minFillBps` + `decay` and shows
  the projected coverage (green) or a fallback warning (amber). The `Simulate`
  page remains the manual what-if tool; this endpoint inverts it to *propose* inputs.

## Limitations / notes
- Coverage reflects the **currently running** fillers' live inventory; with no
  fillers up it returns the smallest `minFillBps` and a "routes to fallback" note.
- Float precision in `rateToContract` is fine for the live 18-dec→6-dec pair; a
  general-decimals deployment should switch to a fixed-point conversion.
- The search assumes coverage is monotone in `minFillBps` (true for the current
  capacity-capped filler strategy); exotic strategies could violate it.
