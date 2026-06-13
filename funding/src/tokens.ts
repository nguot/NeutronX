export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
export const DAI  = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
export const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
export const LINK = '0x514910771AF9Ca656af840dff83E8264EcF986CA'
export const UNI  = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'

// Human-readable per-account targets (converted to raw via decimals in fund.ts).
export const TOKENS: Record<string, { address: string; decimals: number; target: string }> = {
  WETH: { address: WETH, decimals: 18, target: '50'      },
  USDC: { address: USDC, decimals: 6,  target: '100000'  },
  USDT: { address: USDT, decimals: 6,  target: '100000'  },
  DAI:  { address: DAI,  decimals: 18, target: '100000'  },
  WBTC: { address: WBTC, decimals: 8,  target: '2'       },
  LINK: { address: LINK, decimals: 18, target: '10000'   },
  UNI:  { address: UNI,  decimals: 18, target: '10000'   },
}

// Binance hot wallets — deep balances of major tokens on a mainnet fork.
export const WHALES = [
  '0x28C6c06298d514Db089934071355E5743bf21d60', // Binance 14
  '0xF977814e90dA44bFA03b6295A0616a897441aceC', // Binance 8 (fallback)
]
