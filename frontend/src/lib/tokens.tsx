import { ethers } from 'ethers'

// Token shape served by the backend GET /tokens directory (DB-backed). The token
// list is no longer hardcoded here — it loads at runtime via AppConfig so tokens
// can be added with a DB insert instead of a frontend redeploy.
export interface TokenInfo {
  symbol:   string
  address:  string
  decimals: number
  name?:    string
  chainId?: number
}

// Resolve a token by on-chain address (case-insensitive) within a loaded list.
export function tokenByAddress(addr: string, tokens: TokenInfo[]): TokenInfo | null {
  if (!addr) return null
  const lower = addr.toLowerCase()
  return tokens.find(t => t.address.toLowerCase() === lower) ?? null
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
export function TokenPill({ tokens, value, onChange, exclude }: {
  tokens: TokenInfo[]; value: string; onChange: (s: string) => void; exclude?: string
}) {
  return (
    <div className="uni-token-pill">
      <select value={value} onChange={e => onChange(e.target.value)}>
        {tokens.filter(t => t.symbol !== exclude).map(t => (
          <option key={t.symbol} value={t.symbol}>{t.symbol}</option>
        ))}
      </select>
      <span className="uni-pill-arrow">▾</span>
    </div>
  )
}
