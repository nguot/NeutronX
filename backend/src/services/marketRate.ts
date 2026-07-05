import { AlphaRouter, SwapType } from '@uniswap/smart-order-router'
import { Protocol } from '@uniswap/router-sdk'
import { TradeType, CurrencyAmount, Token, Percent } from '@uniswap/sdk-core'
import { ethers } from 'ethers'

const CHAIN_ID = 1
const DUMMY_RECIPIENT = '0x0000000000000000000000000000000000000001'

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
