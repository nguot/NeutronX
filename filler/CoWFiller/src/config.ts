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

export const DEV_MODE = process.env.DEV_MODE === 'true'

// ── CoW filler strategy knobs ─────────────────────────────────────────────────
export const INVENTORY = {
  // Register for a fill this many blocks before deadline.
  REGISTER_AT_BLOCKS_LEFT: 60,

  // Minimum estimated profit (raw outputToken units) to bother filling.
  // e.g. for USDC (6 decimals): 1_000_000 = $1.00. Use 0 for Anvil testing.
  MIN_PROFIT_RAW: 0,

  // Max fraction of outputToken inventory to risk on a single fill (bps).
  // 5000 = 50%. Set to 10000 to use all available inventory.
  MAX_INVENTORY_USE_BPS: 5000,
}

// ── Supported tokens ──────────────────────────────────────────────────────────
export const SUPPORTED_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2']: { symbol: 'WETH', decimals: 18 },
  ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48']: { symbol: 'USDC', decimals: 6  },
  ['0xdAC17F958D2ee523a2206206994597C13D831ec7']: { symbol: 'USDT', decimals: 6  },
  ['0x6B175474E89094C44Da98b954EedeAC495271d0F']: { symbol: 'DAI',  decimals: 18 },
}
