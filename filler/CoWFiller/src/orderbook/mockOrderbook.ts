// CEX orderbook source for the matcher. getOrderbook() tries a live Binance
// depth snapshot (see liveOrderbook.ts) first; the static books below are the
// fallback when a pair isn't covered live or the request fails.
//
// Price format: raw outputToken per 1 raw inputToken, same as order.startPrice.
//   e.g. WETH→USDC at $2510: 2510 * 10^6 = 2_510_000_000n
//   outputRequired = fillAmount * price / 1e18
//
// Bids are sorted descending (best price first) — matcher walks top-down.

import { fetchLiveOrderbook } from './liveOrderbook'

export interface BidLevel {
  price: bigint  // raw outputToken per 1e18 raw inputToken
  size:  bigint  // raw inputToken (e.g. wei for WETH)
}

export interface MockOrderbook {
  inputToken:  string
  outputToken: string
  bids:        BidLevel[]  // descending by price
}

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const DAI  = '0x6B175474E89094C44Da98b954EedeAC495271d0F'

const ONE_WETH = 10n ** 18n
const ONE_USDC = 10n ** 6n

// WETH → USDC: CEX buyers wanting to buy WETH, quoted in USDC
const WETH_USDC_BOOK: MockOrderbook = {
  inputToken:  WETH,
  outputToken: USDC,
  bids: [
    { price: 2510n * ONE_USDC, size: 2n  * ONE_WETH },
    { price: 2505n * ONE_USDC, size: 3n  * ONE_WETH },
    { price: 2500n * ONE_USDC, size: 5n  * ONE_WETH },
    { price: 2495n * ONE_USDC, size: 10n * ONE_WETH },
    { price: 2490n * ONE_USDC, size: 20n * ONE_WETH },
  ],
}

// WETH → USDT: same structure
const WETH_USDT_BOOK: MockOrderbook = {
  inputToken:  WETH,
  outputToken: USDT,
  bids: [
    { price: 2510n * ONE_USDC, size: 2n  * ONE_WETH },
    { price: 2505n * ONE_USDC, size: 3n  * ONE_WETH },
    { price: 2500n * ONE_USDC, size: 5n  * ONE_WETH },
    { price: 2495n * ONE_USDC, size: 10n * ONE_WETH },
  ],
}

// USDC → WETH: CEX buyers wanting to buy USDC (sell WETH), quoted in WETH
// price = WETH per 1e18 raw USDC = (1/2500) * 1e18 ≈ 4 * 10^14
const USDC_WETH_BOOK: MockOrderbook = {
  inputToken:  USDC,
  outputToken: WETH,
  bids: [
    { price: 10n ** 18n / (2490n * ONE_USDC), size: 5_000n * ONE_USDC },
    { price: 10n ** 18n / (2495n * ONE_USDC), size: 10_000n * ONE_USDC },
    { price: 10n ** 18n / (2500n * ONE_USDC), size: 20_000n * ONE_USDC },
  ],
}

const ALL_BOOKS: MockOrderbook[] = [
  WETH_USDC_BOOK,
  WETH_USDT_BOOK,
  USDC_WETH_BOOK,
]

function getStaticOrderbook(inputToken: string, outputToken: string): MockOrderbook | null {
  return ALL_BOOKS.find(
    b => b.inputToken.toLowerCase()  === inputToken.toLowerCase() &&
         b.outputToken.toLowerCase() === outputToken.toLowerCase()
  ) ?? null
}

export async function getOrderbook(inputToken: string, outputToken: string): Promise<MockOrderbook | null> {
  try {
    const live = await fetchLiveOrderbook(inputToken, outputToken)
    if (live) return live
  } catch (e) {
    console.warn(`[Orderbook] live fetch failed (${(e as Error).message}) — using static book`)
  }
  return getStaticOrderbook(inputToken, outputToken)
}
