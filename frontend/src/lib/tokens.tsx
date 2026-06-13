import { ethers } from 'ethers'

export const TOKENS = {
  WETH: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  USDC: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6  },
  USDT: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6  },
  DAI:  { symbol: 'DAI',  address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
  WBTC: { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8  },
  LINK: { symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
  UNI:  { symbol: 'UNI',  address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
} as const

export type TK = keyof typeof TOKENS

// Resolve a known token by on-chain address (case-insensitive).
export function tokenByAddress(addr: string): { symbol: string; address: string; decimals: number } | null {
  if (!addr) return null
  const lower = addr.toLowerCase()
  for (const k of Object.keys(TOKENS) as TK[]) {
    if (TOKENS[k].address.toLowerCase() === lower) return TOKENS[k]
  }
  return null
}

export function short(addr: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—'
}

export function toWei(val: string, dec: number): bigint {
  try { return ethers.utils.parseUnits(val || '0', dec).toBigInt() } catch { return 0n }
}
// Full-precision token amount — formatUnits already gives an exact decimal string;
// parseFloat().toLocaleString(maximumFractionDigits:6) used to round tiny high-decimal
// amounts (e.g. WBTC) down to "0". Trim trailing zeros, group the integer part only.
export function fromWei(wei: bigint, dec: number): string {
  const [intPart, fracPart = ''] = ethers.utils.formatUnits(wei.toString(), dec).split('.')
  const frac = fracPart.replace(/0+$/, '')
  const grouped = BigInt(intPart).toLocaleString()
  return frac ? `${grouped}.${frac}` : grouped
}

// Full-precision price display — .toFixed(4) used to show "0.0000" for small-but-nonzero
// prices (e.g. ~0.0000157 USDC/WBTC). Shows enough significant digits for small values,
// grouped thousands for large ones.
export function formatPrice(price: number): string {
  if (!price || !isFinite(price)) return '0'
  if (Math.abs(price) >= 1) return price.toLocaleString(undefined, { maximumFractionDigits: 6 })
  const decimals = Math.min(18, -Math.floor(Math.log10(Math.abs(price))) + 4)
  return price.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')
}

// startPrice_contract = (outWei / inWei) * 1e18
export function calcStartPrice(inWei: bigint, outWei: bigint): bigint {
  if (inWei === 0n) return 0n
  return (outWei * BigInt(1e18)) / inWei
}
export function contractToHumanPrice(price: bigint, inDec: number, outDec: number): number {
  // humanPrice = price / 1e18 * 10^inDec / 10^outDec
  return Number(price) / 1e18 * (10 ** inDec) / (10 ** outDec)
}
// Inverse of contractToHumanPrice — used to turn a human "X output per input" price
// into the contract's 1e18-scaled startPrice. The same conversion applies to a
// per-block decay rate ("X output per input, per block") since it shares the
// same units as startPrice — pass humanPrice <= 0 to get 0n (flat/no decay).
export function humanPriceToContract(humanPrice: number, inDec: number, outDec: number): bigint {
  if (!humanPrice || humanPrice <= 0) return 0n
  const scaled = BigInt(Math.round(humanPrice * 1e6))
  return (scaled * BigInt(10 ** outDec) * BigInt(1e18)) / (BigInt(10 ** inDec) * BigInt(1e6))
}

// PartialFillReactor.OrderInfo.decayPerBlock is uint32 — unlike startPrice
// (uint128), it can't hold the full 1e18-scaled price range. For high-value /
// high-decimal-ratio pairs (e.g. WBTC/USDC) even a tiny human decay rate
// overflows uint32 once converted, so we surface the pair's max here instead
// of letting the backend's ABI encoder throw "value out-of-bounds".
export const DECAY_PER_BLOCK_MAX = 4294967295n // 2**32 - 1

export function maxHumanDecay(inDec: number, outDec: number): number {
  return Number(DECAY_PER_BLOCK_MAX) * (10 ** inDec) / (10 ** outDec) / 1e18
}

// ── Token pill (symbol selector) ────────────────────────────────────────────
export function TokenPill({ value, onChange, exclude }: { value: TK; onChange: (k: TK) => void; exclude?: TK }) {
  return (
    <div className="uni-token-pill">
      <select value={value} onChange={e => onChange(e.target.value as TK)}>
        {(Object.keys(TOKENS) as TK[]).filter(k => k !== exclude).map(k => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
      <span className="uni-pill-arrow">▾</span>
    </div>
  )
}
