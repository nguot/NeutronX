// Live CEX orderbook snapshots (Binance public REST depth endpoint) — used by
// the matcher as a stand-in for "where could the filler offload outputToken
// right now". Falls back to the static book in mockOrderbook.ts if a pair
// isn't covered here or the request fails (offline dev, rate limit, etc).

import { http as axios } from '../httpClient'
import { SUPPORTED_TOKENS } from '../config'
import type { BidLevel, MockOrderbook } from './mockOrderbook'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

interface BinanceDepth {
  bids: [string, string][]
  asks: [string, string][]
}

const CACHE_TTL_MS = 5_000
const depthCache = new Map<string, { depth: BinanceDepth; expires: number }>()

async function fetchDepth(symbol: string): Promise<BinanceDepth> {
  const cached = depthCache.get(symbol)
  if (cached && cached.expires > Date.now()) return cached.depth

  const { data } = await axios.get<BinanceDepth>('https://api.binance.com/api/v3/depth', {
    params: { symbol, limit: 10 },
    timeout: 3000,
  })
  depthCache.set(symbol, { depth: data, expires: Date.now() + CACHE_TTL_MS })
  return data
}

// Converts a Binance decimal string (e.g. "1718.72000000") to a raw bigint at
// `decimals` precision, without going through floating point.
function toRaw(decimalStr: string, decimals: number): bigint {
  const [whole, frac = ''] = decimalStr.split('.')
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(whole + fracPadded)
}

const isAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export async function fetchLiveOrderbook(inputToken: string, outputToken: string): Promise<MockOrderbook | null> {
  const inMeta  = SUPPORTED_TOKENS[inputToken]
  const outMeta = SUPPORTED_TOKENS[outputToken]
  if (!inMeta || !outMeta) return null

  // WETH -> USDC/USDT: Binance bids (CEX buyers paying stablecoin for ETH)
  // map directly onto "where the filler could resell the WETH it just took in".
  if (isAddr(inputToken, WETH) && (isAddr(outputToken, USDC) || isAddr(outputToken, USDT))) {
    const symbol = isAddr(outputToken, USDC) ? 'ETHUSDC' : 'ETHUSDT'
    const { bids: rawBids } = await fetchDepth(symbol)
    const bids: BidLevel[] = rawBids.map(([price, size]) => ({
      price: toRaw(price, outMeta.decimals),
      size:  toRaw(size, inMeta.decimals),
    }))
    return { inputToken, outputToken, bids }
  }

  // USDC/USDT -> WETH: derive from Binance asks (CEX sellers offering ETH for
  // stablecoin), inverted into "buy stablecoin with the WETH the filler holds".
  if (isAddr(outputToken, WETH) && (isAddr(inputToken, USDC) || isAddr(inputToken, USDT))) {
    const symbol = isAddr(inputToken, USDC) ? 'ETHUSDC' : 'ETHUSDT'
    const { asks: rawAsks } = await fetchDepth(symbol)
    const bids: BidLevel[] = rawAsks.map(([price, size]) => {
      const priceRaw = toRaw(price, inMeta.decimals) // stablecoin per ETH, raw
      const sizeRaw  = toRaw(size, outMeta.decimals) // ETH amount, raw

      return {
        price: (10n ** BigInt(outMeta.decimals + 18)) / priceRaw, // matches matcher's price convention
        size:  (sizeRaw * priceRaw) / (10n ** BigInt(outMeta.decimals)), // ETH amount valued in raw stablecoin
      }
    })
    return { inputToken, outputToken, bids }
  }

  return null
}
