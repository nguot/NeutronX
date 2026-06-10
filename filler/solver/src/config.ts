import * as dotenv from 'dotenv'
dotenv.config()

// ── Required env vars ────────────────────────────────────────────────────────
export const BACKEND_URL  = process.env.BACKEND_URL          || 'http://localhost:3000'
export const RPC_URL      = process.env.ALCHEMY_RPC_URL      || ''
export const PRIVATE_KEY  = process.env.PRIVATE_KEY          || ''
export const FILL_AUCTION = process.env.FILL_AUCTION         || ''
export const REACTOR      = process.env.PARTIAL_FILL_REACTOR || ''

// Set DEV_MODE=true to skip profit checks and register phase (Anvil testing only).
// The filler will fill every order instantly using whale impersonation for token funding.
export const DEV_MODE = process.env.DEV_MODE === 'true'

// ── Strategy knobs — tune these for your filler ──────────────────────────────
export const STRATEGY = {
  MIN_PROFIT_BPS:           20,   // skip fill if expected margin is below this
  FILL_RATIO:               0.5,  // what fraction of each order to fill (0.0 – 1.0)
  REGISTER_AT_BLOCKS_LEFT:  60,   // register when N blocks remain (>50 blocks → 1x stake multiplier)
}

// ── Tokens your filler supports ──────────────────────────────────────────────
// Orders involving tokens NOT listed here are ignored by the listener.
export const SUPPORTED_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': { symbol: 'WETH', decimals: 18 },
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': { symbol: 'USDC', decimals: 6  },
  '0xdAC17F958D2ee523a2206206994597C13D831ec7': { symbol: 'USDT', decimals: 6  },
  '0x6B175474E89094C44Da98b954EedeAC495271d0F': { symbol: 'DAI',  decimals: 18 },
  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': { symbol: 'WBTC', decimals: 8  },
}
