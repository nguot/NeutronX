import { AlphaRouter, SwapType } from '@uniswap/smart-order-router'
import { Protocol } from '@uniswap/router-sdk'
import { TradeType, CurrencyAmount, Token, Percent } from '@uniswap/sdk-core'
import { ethers } from 'ethers'

/// demo only => what more code should it have for full production
const CHAIN_ID = 1
const DUMMY_RECIPIENT = '0x0000000000000000000000000000000000000001'

// Uniswap V3 mainnet factory + WETH. Used to pick the deepest-liquidity
// (inputToken, WETH) pool so the on-chain stake oracle
// (DynamicStakeLib.toEthNotional) reads from a pool that actually exists at the
// order's feeTier and is hard to manipulate. A token pair can have several V3
// pools (one per fee tier), so the tier is what selects WHICH pool is quoted.
const UNIV3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984'
const WETH          = '0xC02aaa39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const CANDIDATE_FEE_TIERS = [100, 500, 3000, 10000] as const

const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)']
const V3_POOL_ABI = [
  'function liquidity() view returns (uint128)',
  // slot0()[3] = observationCardinality (how many past observations the pool retains)
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
]

export interface MarketQuote {
  estOut:     bigint
  marketRate: number      // human output per 1 human input unit
  impact:     string | null
  source:     'alpha_router' | 'coingecko'
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

async function quoteFromAlphaRouter(
  inputToken: string, inputDecimals: number, inputSymbol: string,
  outputToken: string, outputDecimals: number, outputSymbol: string,
  inputAmountWei: bigint, rpcUrl: string,
): Promise<MarketQuote> {
  const provider    = new ethers.providers.JsonRpcProvider(rpcUrl)
  const alphaRouter = new AlphaRouter({ chainId: CHAIN_ID, provider: provider as any })
  const tIn  = new Token(CHAIN_ID, inputToken,  inputDecimals,  inputSymbol)
  const tOut = new Token(CHAIN_ID, outputToken, outputDecimals, outputSymbol)
  const amount = CurrencyAmount.fromRawAmount(tIn, inputAmountWei.toString())

  const route = await alphaRouter.route(amount, tOut, TradeType.EXACT_INPUT, {
    type:              SwapType.SWAP_ROUTER_02,
    recipient:         DUMMY_RECIPIENT,
    slippageTolerance: new Percent(50, 10000),
    deadline:          Math.floor(Date.now() / 1000) + 300,
  }, { protocols: [Protocol.V2, Protocol.V3] })
  if (!route) throw new Error('No route found')

  const estOut   = BigInt(route.trade.outputAmount.quotient.toString())
  const inHuman  = Number(inputAmountWei) / 10 ** inputDecimals
  const outHuman = Number(estOut) / 10 ** outputDecimals
  return { estOut, marketRate: outHuman / inHuman, impact: route.trade.priceImpact.toFixed(2), source: 'alpha_router' }
}

// CoinGecko ids for the tokens we seed. The id endpoint (/simple/price) is far
// more reliable than the contract-address endpoint (/simple/token_price), which
// rate-limits harder and returns nothing for some tokens — the root cause of the
// intermittent "Token not found on CoinGecko" failures.
const COINGECKO_IDS: Record<string, string> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'weth',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'usd-coin',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'tether',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'dai',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'wrapped-bitcoin',
  '0x514910771af9ca656af840dff83e8264ecf986ca': 'chainlink',
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'uniswap',
}

// Per-token USD price cache. CoinGecko's free tier rate-limits (429) after a few
// rapid calls, which previously surfaced as "Token not found on CoinGecko" on
// every other quote. We cache the last good price and SERVE IT STALE whenever a
// live fetch fails — on a pinned mainnet fork the price barely moves, so a cached
// value is both correct enough and far more stable than failing the whole quote.
const priceCache = new Map<string, { usd: number; ts: number }>()
const PRICE_TTL_MS = 60_000

async function fetchPriceLive(addr: string): Promise<number | undefined> {
  // Preferred: resolve by CoinGecko id (reliable for the seeded tokens).
  const id = COINGECKO_IDS[addr]
  if (id) {
    try {
      const res = await withTimeout(fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`), 5000)
      if (res.ok) {
        const data = await res.json() as Record<string, { usd: number }>
        if (data[id]?.usd) return data[id].usd
      }
    } catch { /* fall through to the contract-address lookup */ }
  }

  // Fallback: resolve by ERC-20 contract address (covers tokens not in the map).
  try {
    const res = await withTimeout(fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${addr}&vs_currencies=usd`,
    ), 5000)
    if (!res.ok) return undefined
    const data = await res.json() as Record<string, { usd: number }>
    return data[addr]?.usd
  } catch { return undefined }
}

async function fetchTokenPriceUsd(address: string): Promise<number | undefined> {
  const addr   = address.toLowerCase()
  const cached = priceCache.get(addr)
  if (cached && Date.now() - cached.ts < PRICE_TTL_MS) return cached.usd

  const live = await fetchPriceLive(addr)
  if (live != null) {
    priceCache.set(addr, { usd: live, ts: Date.now() })
    return live
  }
  // Live fetch failed (rate-limited / down) — serve the last good price if we have one.
  return cached?.usd
}

async function quoteFromCoinGecko(
  inputToken: string, inputDecimals: number,
  outputToken: string, outputDecimals: number,
  inputAmountWei: bigint,
): Promise<MarketQuote> {
  const [pIn, pOut] = await Promise.all([fetchTokenPriceUsd(inputToken), fetchTokenPriceUsd(outputToken)])
  if (!pIn || !pOut) throw new Error('Token not found on CoinGecko')
  const inHuman  = Number(inputAmountWei) / 10 ** inputDecimals
  const outHuman = inHuman * pIn / pOut
  const estOut   = BigInt(Math.floor(outHuman * 10 ** outputDecimals))
  return { estOut, marketRate: pIn / pOut, impact: null, source: 'coingecko' }
}

/// Market rate for inputToken→outputToken: Alpha Router first, CoinGecko fallback.
export async function getMarketRate(
  inputToken: string, inputDecimals: number, inputSymbol: string,
  outputToken: string, outputDecimals: number, outputSymbol: string,
  inputAmountWei: bigint, rpcUrl: string,
): Promise<MarketQuote> {
  try {
    return await withTimeout(
      quoteFromAlphaRouter(inputToken, inputDecimals, inputSymbol, outputToken, outputDecimals, outputSymbol, inputAmountWei, rpcUrl),
      8000,
    )
  } catch {
    return quoteFromCoinGecko(inputToken, inputDecimals, outputToken, outputDecimals, inputAmountWei)
  }
}

/// Pick the (inputToken, WETH) fee tier whose V3 pool has the deepest liquidity,
/// so the on-chain stake oracle reads a real, manipulation-resistant pool instead
/// of a hardcoded tier that may point at a thin (or non-existent) pool.
///
/// Returns `null` when no usable pool exists — the caller then keeps the
/// client-supplied feeTier (the order is still fillable when the on-chain oracle
/// is disabled / running in notional mode, and WETH input is quoted 1:1 anyway).
/// Best-effort: never throws, so an RPC hiccup never blocks order creation.
///
/// `minObservationCardinality` guards the TWAP window: observe() can only span a
/// window the pool has retained enough observations for. Deep mainnet pools keep
/// hundreds; a value of 2 just rejects brand-new pools that only hold the spot.
export async function pickFeeTier(
  provider: ethers.providers.Provider,
  inputToken: string,
  minObservationCardinality = 2,
): Promise<number | null> {
  if (inputToken.toLowerCase() === WETH.toLowerCase()) return null // oracle is 1:1 for WETH input
  try {
    const factory = new ethers.Contract(UNIV3_FACTORY, FACTORY_ABI, provider)
    let best: { tier: number; liquidity: ethers.BigNumber } | null = null

    for (const tier of CANDIDATE_FEE_TIERS) {
      const pool: string = await factory.getPool(inputToken, WETH, tier)
      if (pool === ethers.constants.AddressZero) continue          // (1) pool exists?

      const c = new ethers.Contract(pool, V3_POOL_ABI, provider)
      const [liquidity, slot0] = await Promise.all([c.liquidity(), c.slot0()])
      if ((liquidity as ethers.BigNumber).isZero()) continue        // (2) has liquidity?
      if ((slot0[3] as number) < minObservationCardinality) continue // (3) enough history?

      if (!best || (liquidity as ethers.BigNumber).gt(best.liquidity)) {
        best = { tier, liquidity }                                  // keep the deepest
      }
    }
    return best?.tier ?? null
  } catch {
    return null
  }
}
