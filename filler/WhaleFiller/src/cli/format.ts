import pc from 'picocolors'
import { SUPPORTED_TOKENS } from '../config'

// Address → { symbol, decimals }, keyed lowercase so lookups are case-insensitive.
const TOKENS: Record<string, { symbol: string; decimals: number }> = Object.fromEntries(
  Object.entries(SUPPORTED_TOKENS).map(([addr, meta]) => [addr.toLowerCase(), meta])
)

export function sym(addr: string): string {
  return TOKENS[addr?.toLowerCase()]?.symbol ?? (addr ? addr.slice(0, 8) + '…' : '?')
}

export function dec(addr: string): number {
  return TOKENS[addr?.toLowerCase()]?.decimals ?? 18
}

// wei → full-precision decimal string (no rounding), trailing zeros trimmed.
export function humanRaw(raw: string | bigint, decimals: number): string {
  const s = BigInt(raw || '0').toString().padStart(decimals + 1, '0')
  const intPart = s.slice(0, s.length - decimals)
  const frac    = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${intPart}.${frac}` : intPart
}

export function human(raw: string | bigint, addr: string): string {
  return humanRaw(raw, dec(addr))
}

// Full-precision non-negative ratio → decimal string with `precision` frac digits.
function ratio(num: bigint, den: bigint, precision: number): string {
  let intPart = num / den
  let rem = num % den
  let frac = ''
  for (let i = 0; i < precision && rem > 0n; i++) { rem *= 10n; frac += (rem / den).toString(); rem %= den }
  frac = frac.replace(/0+$/, '')
  return frac ? `${intPart}.${frac}` : intPart.toString()
}

// `price` is the contract's 1e18-scaled outputWei/inputWei rate (OrderInfo.startPrice
// units); human price = price/1e18 * 10^inDec/10^outDec.
export function priceHuman(price: bigint, inAddr: string, outAddr: string): string {
  return ratio(price * 10n ** BigInt(dec(inAddr)), 10n ** 18n * 10n ** BigInt(dec(outAddr)), 6)
}

// Colored unicode progress bar, e.g. ███░░ for 60%.
export function progressBar(pct: number, width = 18): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const color = pct >= 100 ? pc.green : pct > 0 ? pc.cyan : pc.dim
  return color(bar)
}

export function shortHash(h: string): string {
  return h && h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : (h ?? '')
}

// Status → colored label, matching the dashboard's color language.
export function statusLabel(status: string): string {
  switch (status) {
    case 'active':    return pc.green(status)
    case 'pending':   return pc.blue(status)
    case 'filled':    return pc.dim(status)
    case 'cancelled': return pc.red(status)
    case 'available': return pc.green(status)
    case 'locked':    return pc.yellow(status)
    case 'claimed':   return pc.cyan(status)
    // Model 2 cross-chain fill states (see crosschainService.ts's state machine)
    case 'quoted':      return pc.blue(status)
    case 'dst_funded':  return pc.blue(status)
    case 'authorized':  return pc.yellow(status)
    case 'src_locked':  return pc.yellow(status)
    case 'revealed':    return pc.cyan(status)
    case 'slashed':     return pc.red(status)
    default:          return status
  }
}

// ora's spinner.fail()/succeed()/warn() assume the persisted message is a
// single terminal line — ethers.js errors routinely dump multi-KB, embedded-
// newline JSON-RPC bodies, which wrap across many rows and throw off ora's
// cursor bookkeeping for everything rendered after it (including the REPL's
// next prompt). Collapse to one line and cap the length before handing it off.
export function shortErr(e: any, max = 180): string {
  const msg = String(e?.reason ?? e?.message ?? e).replace(/\s+/g, ' ').trim()
  return msg.length > max ? msg.slice(0, max) + '…' : msg
}

export const c = pc

// Section banner used at the top of each command's output.
export function banner(filler: string, subtitle: string): string {
  return `${pc.bold(pc.cyan('NeutronX'))} ${pc.dim('·')} ${pc.bold(filler)} ${pc.dim('·')} ${pc.dim(subtitle)}`
}
