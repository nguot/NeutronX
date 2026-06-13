import * as dotenv from 'dotenv'
dotenv.config()

export const BACKEND_URL  = process.env.BACKEND_URL          || 'http://localhost:3000'
export const RPC_URL      = process.env.ALCHEMY_RPC_URL      || ''
export const PRIVATE_KEY  = process.env.PRIVATE_KEY          || ''
export const FILL_AUCTION = process.env.FILL_AUCTION         || ''
export const REACTOR      = process.env.PARTIAL_FILL_REACTOR || ''

// Cross-chain vars — written by tests/crosschain/setup_cc.sh
export const ESCROW_SRC_FACTORY = process.env.ESCROW_SRC_FACTORY || ''
export const CHAIN_B_RPC        = process.env.CHAIN_B_RPC        || ''
export const CHAIN_B_FACTORY    = process.env.CHAIN_B_FACTORY    || ''

// DEV_MODE=true: skip spread/inventory checks, fund wallet via whale impersonation before each fill.
export const DEV_MODE = process.env.DEV_MODE === 'true'

// ── Inventory strategy knobs ──────────────────────────────────────────────────
export const INVENTORY = {
  // Register for a fill this many blocks before deadline.
  REGISTER_AT_BLOCKS_LEFT: 60,

  // Minimum spread (bps) between market price and auction price required to fill.
  // 10 bps = 0.1%. Covers gas + stake opportunity cost for local Anvil testing.
  MIN_SPREAD_BPS: 10,

  // Max fraction of outputToken inventory to risk on a single fill (in bps).
  // 5000 = 50%: never put more than half your USDC into one order.
  // Set to 10000 to always fill as much as possible.
  MAX_INVENTORY_USE_BPS: 5000,
}

// ── Supported tokens ──────────────────────────────────────────────────────────
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const DAI  = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
const LINK = '0x514910771AF9Ca656af840dff83E8264EcF986CA'
const UNI  = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'

export const SUPPORTED_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [WETH]: { symbol: 'WETH', decimals: 18 },
  [USDC]: { symbol: 'USDC', decimals: 6  },
  [USDT]: { symbol: 'USDT', decimals: 6  },
  [DAI]:  { symbol: 'DAI',  decimals: 18 },
  [WBTC]: { symbol: 'WBTC', decimals: 8  },
  [LINK]: { symbol: 'LINK', decimals: 18 },
  [UNI]:  { symbol: 'UNI',  decimals: 18 },
}

// ── Reference market prices ───────────────────────────────────────────────────
// Format: raw outputToken per 1 raw inputToken, scaled the same way as order.startPrice.
// Formula: humanPrice * 10^outDecimals
// e.g. WETH→USDC at $2500: 2500 * 10^6 = 2_500_000_000n
//
// The filler fills when auctionPrice < refPrice (swapper accepts less than market → spread for filler).
// For Anvil testing: set refPrice BELOW the order's startPrice so fills are triggered.
export const REFERENCE_PRICES: Record<string, Record<string, bigint>> = {
  [WETH]: {
    [USDC]: 2_500n * 10n**6n,
    [USDT]: 2_500n * 10n**6n,
    [DAI]:  2_500n * 10n**18n,
  },
  [USDC]: {
    [WETH]: 10n**18n / (2_500n * 10n**6n),
  },
  [USDT]: {
    [WETH]: 10n**18n / (2_500n * 10n**6n),
  },
  [DAI]: {
    [WETH]: 10n**18n / (2_500n * 10n**18n),
  },
}
