import { ethers } from 'ethers'

export const TOKENS = {
  WETH: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  USDC: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6  },
  USDT: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6  },
  DAI:  { symbol: 'DAI',  address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
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
export function fromWei(wei: bigint, dec: number): string {
  return parseFloat(ethers.utils.formatUnits(wei.toString(), dec)).toLocaleString(undefined, { maximumFractionDigits: 6 })
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
