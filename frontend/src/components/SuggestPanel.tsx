import type { Suggestion } from '../lib/suggest'

// Shared result panel for /suggest-params — identical on the Swap and Simulate pages.
export function SuggestPanel({ sugg, inSym, outSym }: { sugg: Suggestion; inSym: string; outSym: string }) {
  return (
    <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
      {/* coverage headline */}
      <div className="uni-detail-row" style={{ padding: 0, alignItems: 'center' }}>
        <span className="uni-detail-label">Fillable by fillers</span>
        <span className={`badge ${sugg.meetsTarget ? 'filled' : 'pending'}`}>
          {(sugg.projectedCoverageBps / 100).toFixed(0)}%{sugg.meetsTarget ? '' : ' · partial'}
        </span>
      </div>
      {/* coverage bar */}
      <div style={{ height: 4, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden', margin: '7px 0 9px' }}>
        <div style={{ height: '100%', width: `${Math.min(100, sugg.projectedCoverageBps / 100)}%`,
          background: sugg.meetsTarget ? '#16a34a' : '#d97706' }} />
      </div>
      {/* applied params */}
      <div className="uni-detail-row" style={{ padding: '2px 0' }}>
        <span className="uni-detail-label">Min fill / chunk</span>
        <span style={{ fontWeight: 600 }}>{(sugg.minFillBps / 100).toFixed(0)}%</span>
      </div>
      <div className="uni-detail-row" style={{ padding: '2px 0' }}>
        <span className="uni-detail-label">Price (start → floor)</span>
        <span style={{ fontWeight: 600 }}>
          {Number(sugg.startPriceHuman).toFixed(2)} → {Number(sugg.floorPriceHuman).toFixed(2)}
          <span className="uni-label-muted" style={{ fontWeight: 400 }}> {outSym}/{inSym}</span>
        </span>
      </div>
      {!sugg.meetsTarget && (
        <div style={{ fontSize: '0.72rem', color: '#d97706', marginTop: 6 }}>
          ≈{(100 - sugg.projectedCoverageBps / 100).toFixed(0)}% would route through the Uniswap fallback — try a smaller min fill or order.
        </div>
      )}
    </div>
  )
}
