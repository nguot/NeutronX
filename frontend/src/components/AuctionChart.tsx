import { contractToHumanPrice, formatPrice } from '../lib/tokens'

interface FillDot { id: number; filler: string; fillAmount: string; blockNumber: number | null }

interface AuctionChartProps {
  startBlock:         number
  deadline:           number
  startPriceContract: bigint
  decayContract:      bigint
  curBlock:           number
  inDec:              number
  outDec:             number
  inSym:              string
  outSym:             string
  fills?:             FillDot[]
  totalAmount?:       bigint   // order's total input amount — sizes the fill dots proportionally
  curLabel?:          string
}

// Deterministic color per filler so the same filler always gets the same
// color across the chart, the fill bar, and the fill list.
const FILLER_COLORS = ['#16a34a', '#2563eb', '#f59e0b', '#db2777', '#0d9488', '#9333ea', '#ea580c', '#4f46e5']
export function colorForFiller(filler: string): string {
  let hash = 0
  for (let i = 0; i < filler.length; i++) hash = (hash * 31 + filler.charCodeAt(i)) >>> 0
  return FILLER_COLORS[hash % FILLER_COLORS.length]
}

// Renders the Dutch-auction price-decay curve (startPrice → 0 over [startBlock, deadline])
// with a marker at curBlock. Used by both the live Swap order view and the Simulate preview.
export function AuctionChart({
  startBlock, deadline, startPriceContract, decayContract, curBlock,
  inDec, outDec, inSym, outSym, fills = [], totalAmount, curLabel = 'now',
}: AuctionChartProps) {
  const W = 440, H = 160
  const PL = 8, PR = 8, PT = 12, PB = 28
  const cW = W - PL - PR, cH = H - PT - PB

  const span  = Math.max(1, deadline - startBlock)
  const startP = contractToHumanPrice(startPriceContract, inDec, outDec)

  const priceAt = (b: number): number => {
    const dc = decayContract * BigInt(Math.max(0, Math.round(b - startBlock)))
    const pc = startPriceContract > dc ? startPriceContract - dc : 0n
    return contractToHumanPrice(pc, inDec, outDec)
  }

  const bx = (b: number) => PL + Math.min(1, Math.max(0, (b - startBlock) / span)) * cW
  const py = (p: number) => PT + (1 - Math.min(1, Math.max(0, startP > 0 ? p / startP : 0))) * cH

  // curve points
  const pts: string[] = []
  for (let i = 0; i <= 60; i++) {
    const b  = startBlock + (i / 60) * span
    const ph = priceAt(b)
    pts.push(`${bx(b).toFixed(1)},${py(ph).toFixed(1)}`)
    if (ph <= 0) break
  }

  const clampedCur = Math.min(deadline, Math.max(startBlock, curBlock))
  const curPrice   = priceAt(clampedCur)
  const cx = bx(clampedCur)
  const cy = py(Math.max(0, curPrice))

  return (
    <div className="uni-chart-wrap">
      <div className="uni-chart-label">
        <span>Price decay</span>
        <span className="uni-chart-price">{formatPrice(curPrice)} {outSym}/{inSym}</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* fill */}
        {pts.length > 1 && (
          <path d={`M ${pts.join(' L ')} L ${pts[pts.length-1].split(',')[0]},${PT+cH} L ${PL},${PT+cH} Z`} fill="url(#cg)" />
        )}
        {/* line */}
        {pts.length > 1 && (
          <polyline points={pts.join(' ')} fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" />
        )}

        {/* fill event dots — sized by fill amount, colored per filler */}
        {fills.map(f => {
          if (!f.blockNumber || f.blockNumber < startBlock || f.blockNumber > deadline) return null
          const ratio = totalAmount && totalAmount > 0n ? Number(BigInt(f.fillAmount)) / Number(totalAmount) : 0
          const r = 3 + Math.sqrt(Math.min(1, Math.max(0, ratio))) * 7 // 3–10px, area-proportional
          return <circle key={f.id} cx={bx(f.blockNumber)} cy={py(priceAt(f.blockNumber))} r={r} fill={colorForFiller(f.filler)} stroke="white" strokeWidth={1.5} />
        })}

        {/* current/marker dot */}
        <circle cx={cx} cy={cy} r={9} fill="#7c3aed" opacity={0.12}>
          <animate attributeName="r" values="7;11;7" dur="2s" repeatCount="indefinite" />
        </circle>
        <circle cx={cx} cy={cy} r={5} fill="#7c3aed" stroke="white" strokeWidth={2} />

        {/* x labels */}
        <text x={PL} y={H-8} fontSize="10" fill="#94a3b8">block {startBlock}</text>
        <text x={W-PR} y={H-8} textAnchor="end" fontSize="10" fill="#94a3b8">block {deadline}</text>
        <text x={cx} y={H-8} textAnchor="middle" fontSize="10" fill="#7c3aed">{curLabel}</text>
      </svg>
      {/* timeline bar */}
      <div className="uni-timeline">
        <div className="uni-timeline-fill" style={{ width: `${Math.min(100, Math.max(0, (clampedCur - startBlock) / span * 100))}%` }} />
      </div>
    </div>
  )
}
