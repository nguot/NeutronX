import { useState, useEffect, useRef, useCallback } from 'react'
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Interactive Dutch-auction price-decay curve over [startBlock, deadline] with a
// marker at curBlock. Supports zoom (buttons + scroll wheel) and pan (drag); both
// axes rescale to the visible window. Used by the live Swap view and Simulate.
export function AuctionChart({
  startBlock, deadline, startPriceContract, decayContract, curBlock,
  inDec, outDec, inSym, outSym, fills = [], totalAmount, curLabel = 'now',
}: AuctionChartProps) {
  const W = 440, H = 170
  const PL = 8, PR = 8, PT = 14, PB = 26
  const cW = W - PL - PR, cH = H - PT - PB

  const fullSpan = Math.max(1, deadline - startBlock)
  const MIN_SPAN = Math.min(4, fullSpan)

  // Visible block window [v0, v1]; reset whenever the order changes.
  const [view, setView] = useState<[number, number]>([startBlock, deadline])
  useEffect(() => { setView([startBlock, deadline]) }, [startBlock, deadline])
  const [v0, v1] = view
  const vSpan = Math.max(MIN_SPAN, v1 - v0)

  const priceAt = useCallback((b: number): number => {
    const dc = decayContract * BigInt(Math.max(0, Math.round(b - startBlock)))
    const pc = startPriceContract > dc ? startPriceContract - dc : 0n
    return contractToHumanPrice(pc, inDec, outDec)
  }, [decayContract, startBlock, startPriceContract, inDec, outDec])

  // Y rescales to the visible price band so a zoomed-in slice fills the chart.
  const pTop = priceAt(v0)              // highest price in view (left/earliest)
  const pBot = priceAt(v1)             // lowest price in view (right/latest)
  const pRange = pTop - pBot
  const flat = pRange <= pTop * 1e-9 + 1e-12

  const bx = (b: number) => PL + ((b - v0) / vSpan) * cW
  const py = (p: number) => flat ? PT + cH * 0.5 : PT + (1 - clamp((p - pBot) / pRange, 0, 1)) * cH
  const inView = (b: number) => b >= v0 - 1e-6 && b <= v1 + 1e-6

  // curve points sampled across the visible window
  const pts: string[] = []
  for (let i = 0; i <= 80; i++) {
    const b = v0 + (i / 80) * vSpan
    pts.push(`${bx(b).toFixed(1)},${py(priceAt(b)).toFixed(1)}`)
  }

  const clampedCur = clamp(curBlock, startBlock, deadline)
  const curPrice   = priceAt(clampedCur)
  const curShown   = inView(clampedCur)
  const cx = clamp(bx(clampedCur), PL, PL + cW)
  const cy = py(curPrice)

  // ── zoom / pan ──────────────────────────────────────────────────────────────
  const zoomAround = useCallback((factor: number, centerBlock: number) => {
    setView(([a, b]) => {
      const span = Math.max(MIN_SPAN, b - a)
      const c = clamp(centerBlock, a, b)
      let nSpan = clamp(span * factor, MIN_SPAN, fullSpan)
      let n0 = c - ((c - a) / span) * nSpan
      let n1 = n0 + nSpan
      if (n0 < startBlock) { n0 = startBlock; n1 = n0 + nSpan }
      if (n1 > deadline)   { n1 = deadline;   n0 = Math.max(startBlock, n1 - nSpan) }
      return [n0, n1]
    })
  }, [fullSpan, MIN_SPAN, startBlock, deadline])

  const svgRef = useRef<SVGSVGElement>(null)
  const blockAtClientX = (clientX: number): number => {
    const el = svgRef.current
    if (!el) return (v0 + v1) / 2
    const rect = el.getBoundingClientRect()
    const xVb = ((clientX - rect.left) / rect.width) * W
    return v0 + ((xVb - PL) / cW) * vSpan
  }

  // Native non-passive wheel listener so we can preventDefault the page scroll.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAround(e.deltaY < 0 ? 0.82 : 1 / 0.82, blockAtClientX(e.clientX))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v0, v1, zoomAround])

  const drag = useRef<{ x: number; a: number; b: number } | null>(null)
  const onDown = (e: React.MouseEvent) => { drag.current = { x: e.clientX, a: v0, b: v1 } }
  const onMove = (e: React.MouseEvent) => {
    if (!drag.current) return
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const span = drag.current.b - drag.current.a
    const dBlocks = -(((e.clientX - drag.current.x) / rect.width) * W / cW) * span
    let n0 = drag.current.a + dBlocks, n1 = drag.current.b + dBlocks
    if (n0 < startBlock) { n0 = startBlock; n1 = n0 + span }
    if (n1 > deadline)   { n1 = deadline;   n0 = n1 - span }
    setView([Math.max(startBlock, n0), Math.min(deadline, n1)])
  }
  const onUp = () => { drag.current = null }

  const zoomed = v0 > startBlock + 0.5 || v1 < deadline - 0.5
  const btn: React.CSSProperties = {
    width: 22, height: 22, lineHeight: '20px', textAlign: 'center', padding: 0,
    fontSize: 14, borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff',
    color: '#475569', cursor: 'pointer', marginTop: 0,
  }

  // marker pill placement (kept off the x-axis baseline → never collides with the
  // block labels). Sits above the dot, clamped inside the plot; flips below if high.
  const pillW = 8 + curLabel.length * 6.2
  const pillX = clamp(cx - pillW / 2, PL, PL + cW - pillW)
  const pillAbove = cy > PT + 22
  const pillY = pillAbove ? cy - 20 : cy + 8

  return (
    <div className="uni-chart-wrap" style={{ position: 'relative' }}>
      <div className="uni-chart-label">
        <span>Price decay</span>
        <span className="uni-chart-price">{formatPrice(curPrice)} {outSym}/{inSym}</span>
      </div>

      {/* zoom toolbar */}
      <div style={{ position: 'absolute', top: 30, right: 8, display: 'flex', gap: 4, zIndex: 2 }}>
        <button style={btn} title="Zoom out" onClick={() => zoomAround(1 / 0.82, (v0 + v1) / 2)}>−</button>
        <button style={btn} title="Zoom in"  onClick={() => zoomAround(0.82, (v0 + v1) / 2)}>+</button>
        <button style={{ ...btn, opacity: zoomed ? 1 : 0.4 }} title="Reset zoom" disabled={!zoomed}
                onClick={() => setView([startBlock, deadline])}>⤢</button>
      </div>

      <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`}
           style={{ display: 'block', cursor: drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
           onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
        <defs>
          <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* fill area + curve */}
        {pts.length > 1 && (
          <path d={`M ${pts.join(' L ')} L ${PL + cW},${PT + cH} L ${PL},${PT + cH} Z`} fill="url(#cg)" />
        )}
        {pts.length > 1 && (
          <polyline points={pts.join(' ')} fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        )}

        {/* fill event dots — only those inside the visible window */}
        {fills.map(f => {
          if (!f.blockNumber || !inView(f.blockNumber)) return null
          const ratio = totalAmount && totalAmount > 0n ? Number(BigInt(f.fillAmount)) / Number(totalAmount) : 0
          const r = 3 + Math.sqrt(clamp(ratio, 0, 1)) * 7
          return <circle key={f.id} cx={bx(f.blockNumber)} cy={py(priceAt(f.blockNumber))} r={r}
                         fill={colorForFiller(f.filler)} stroke="white" strokeWidth={1.5} />
        })}

        {/* current marker (only when in view) */}
        {curShown && (
          <>
            <circle cx={cx} cy={cy} r={9} fill="#7c3aed" opacity={0.12}>
              <animate attributeName="r" values="7;11;7" dur="2s" repeatCount="indefinite" />
            </circle>
            <circle cx={cx} cy={cy} r={5} fill="#7c3aed" stroke="white" strokeWidth={2} />
            {/* marker label as a pill near the dot — off the axis baseline */}
            <g>
              <rect x={pillX} y={pillY - 11} width={pillW} height={15} rx={4} fill="#7c3aed" />
              <text x={pillX + pillW / 2} y={pillY} textAnchor="middle" fontSize="10" fill="#fff">{curLabel}</text>
            </g>
          </>
        )}

        {/* x-axis block labels (corners only — no overlap with the marker) */}
        <text x={PL} y={H - 7} fontSize="10" fill="#94a3b8">block {Math.round(v0)}</text>
        <text x={W - PR} y={H - 7} textAnchor="end" fontSize="10" fill="#94a3b8">block {Math.round(v1)}</text>
      </svg>

      {/* timeline bar reflects the FULL order; the shaded segment is the visible window */}
      <div className="uni-timeline">
        <div className="uni-timeline-fill" style={{
          marginLeft: `${clamp((v0 - startBlock) / fullSpan * 100, 0, 100)}%`,
          width:      `${clamp((v1 - v0) / fullSpan * 100, 0, 100)}%`,
        }} />
      </div>
      <div style={{ fontSize: '0.68rem', color: '#94a3b8', textAlign: 'center', marginTop: 2 }}>
        {zoomed ? 'drag to pan · scroll or ± to zoom · ⤢ to reset' : 'scroll or ± to zoom in on the curve'}
      </div>
    </div>
  )
}
