import { db } from '../db/client'
import { chainIds } from '../config/chains'

// ─────────────────────────────────────────────────────────────────────────────
//  Token registry  —  single source of truth for the swap & cross-chain UIs
// ─────────────────────────────────────────────────────────────────────────────
//
//  Previously the frontend hardcoded its token list (frontend/src/lib/tokens.tsx)
//  and the cross-chain page read a separate `cc_tokens` table. Both now read this
//  one `tokens` table, seeded below. Adding a token is a DB insert — no frontend
//  redeploy.
//
//  Each token is registered on every chain in the chain registry
//  (backend/config/chains.json). All local anvil instances fork mainnet, so a
//  token keeps the same address on each.

// Chain the single-chain Dutch-auction swap (PARTIAL_FILL_REACTOR) runs on —
// separate from the cross-chain registry.
export const SINGLE_CHAIN_ID = parseInt(process.env.CHAIN_ID || '31337')

export interface TokenInfo {
  symbol:   string
  address:  string
  decimals: number
  name:     string
  chainId:  number
}

// The 7 common mainnet tokens, registered on both chains. Addresses/decimals are
// canonical mainnet values (the anvil nodes fork mainnet).
const COMMON_TOKENS: Omit<TokenInfo, 'chainId'>[] = [
  { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, name: 'Wrapped Ether'   },
  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6,  name: 'USD Coin'        },
  { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6,  name: 'Tether USD'      },
  { symbol: 'DAI',  address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, name: 'Dai Stablecoin'  },
  { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8,  name: 'Wrapped Bitcoin' },
  { symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18, name: 'Chainlink'       },
  { symbol: 'UNI',  address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18, name: 'Uniswap'         },
]

// ─── Schema + seed (called once at startup) ───────────────────────────────────
export async function initTokenSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      id         SERIAL PRIMARY KEY,
      chain_id   INTEGER     NOT NULL,
      symbol     VARCHAR(16) NOT NULL,
      address    VARCHAR(42) NOT NULL,
      decimals   SMALLINT    NOT NULL,
      name       VARCHAR(64) NOT NULL DEFAULT '',
      sort_order INTEGER     NOT NULL DEFAULT 0,
      UNIQUE (chain_id, address)
    )
  `)
  for (const chainId of chainIds()) {
    for (let i = 0; i < COMMON_TOKENS.length; i++) {
      const t = COMMON_TOKENS[i]
      await db.query(`
        INSERT INTO tokens (chain_id, symbol, address, decimals, name, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (chain_id, address) DO UPDATE
          SET symbol = EXCLUDED.symbol, decimals = EXCLUDED.decimals,
              name = EXCLUDED.name, sort_order = EXCLUDED.sort_order
      `, [chainId, t.symbol, t.address, t.decimals, t.name, i])
    }
  }
}

// ─── Reads ─────────────────────────────────────────────────────────────────────
export async function listTokens(chainId?: number): Promise<TokenInfo[]> {
  const r = chainId == null
    ? await db.query('SELECT chain_id, symbol, address, decimals, name FROM tokens ORDER BY chain_id, sort_order')
    : await db.query('SELECT chain_id, symbol, address, decimals, name FROM tokens WHERE chain_id = $1 ORDER BY sort_order', [chainId])
  return r.rows.map(row => ({
    symbol: row.symbol, address: row.address, decimals: row.decimals,
    name: row.name, chainId: row.chain_id,
  }))
}
