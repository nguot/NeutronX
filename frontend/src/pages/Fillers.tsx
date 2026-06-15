import { Fragment, useState, useEffect, useCallback } from 'react'
import { useAppConfig } from '../context/AppConfig'
import { tokenByAddress, short, fromWei } from '../lib/tokens'

interface FillerFill {
  orderHash:   string
  slotIndex:   number
  status:      string
  escrowAddr:  string | null
  chainAId:    number
  dstChainId:  number
  outputToken: string
  amount:      string
  createdAt:   string
}

interface FillerSwapFill {
  id:           number
  orderHash:    string
  fillAmount:   string
  outputAmount: string
  txHash:       string
  blockNumber:  number | null
  createdAt:    string
  inputToken:   string
  outputToken:  string
  orderTotal:   string
}

interface FillerInfo {
  name:      string
  address:   string
  chains:    number[]
  fills:     FillerFill[]
  swapFills: FillerSwapFill[]
}

// Public read-only directory of registered fillers (configured via Admin →
// Fillers) — shows each filler's on-chain address as plain text (no explorer
// links) and the slots it has filled so far.
export default function Fillers() {
  const { backendUrl, chains, tokens } = useAppConfig()
  const [fillers, setFillers] = useState<FillerInfo[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch(`${backendUrl}/cc/fillers`)
      const data = await res.json()
      if (res.ok) setFillers(data.fillers ?? [])
    } catch { /* ignore */ }
    setLoading(false)
  }, [backendUrl])

  useEffect(() => { load() }, [load])

  function chainName(id: number): string {
    return chains.find(c => c.id === id)?.name ?? `Chain ${id}`
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">Fillers</div>
      </div>

      <div className="card">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <span style={{ fontSize: '0.78rem', color: '#64748b' }}>Registered fillers and their cross-chain fill history</span>
          <button className="ghost sm" onClick={load} disabled={loading} style={{ marginTop: 0 }}>
            {loading ? '…' : '↻ Refresh'}
          </button>
        </div>

        {!loading && fillers.length === 0 && (
          <div className="empty-state"><div className="empty-icon">🤖</div>No fillers registered yet.</div>
        )}

        {fillers.map(f => (
          <div key={f.name} className="slot-card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: '0.92rem' }}>{f.name}</strong>
              <span className="mono" style={{ fontSize: '0.78rem', color: '#475569' }}>
                {f.address || 'address not configured'}
              </span>
              {f.chains.map(id => (
                <span key={id} className="tag available" style={{ fontSize: '0.7rem' }}>{chainName(id)}</span>
              ))}
            </div>

            <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600, marginTop: 8 }}>Cross-chain fills</div>
            {f.fills.length === 0 ? (
              <div style={{ fontSize: '0.78rem', color: '#94a3b8' }}>No fills yet.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '4px 16px', fontSize: '0.78rem', marginTop: 6 }}>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Order</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Slot</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Route</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Amount</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Status</div>
                {f.fills.map(fill => {
                  const outT = tokenByAddress(fill.outputToken, tokens)
                  const dec  = outT?.decimals ?? 18
                  const sym  = outT?.symbol ?? short(fill.outputToken)
                  return (
                    <Fragment key={`${fill.orderHash}-${fill.slotIndex}`}>
                      <div className="mono">{short(fill.orderHash)}</div>
                      <div>{fill.slotIndex}</div>
                      <div>{chainName(fill.chainAId)} → {chainName(fill.dstChainId)}</div>
                      <div>{fromWei(BigInt(fill.amount), dec)} {sym}</div>
                      <div>
                        <span className={`tag ${fill.status === 'available' ? 'available' : 'claimed'}`}>{fill.status}</span>
                      </div>
                    </Fragment>
                  )
                })}
              </div>
            )}

            <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600, marginTop: 8 }}>Single-chain swap fills</div>
            {(f.swapFills ?? []).length === 0 ? (
              <div style={{ fontSize: '0.78rem', color: '#94a3b8' }}>No fills yet.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px 16px', fontSize: '0.78rem', marginTop: 6 }}>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Order</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Filled</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Received</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Tx</div>
                {(f.swapFills ?? []).map(fill => {
                  const inT  = tokenByAddress(fill.inputToken, tokens)
                  const outT = tokenByAddress(fill.outputToken, tokens)
                  const inDec  = inT?.decimals ?? 18
                  const outDec = outT?.decimals ?? 18
                  const inSym  = inT?.symbol ?? short(fill.inputToken)
                  const outSym = outT?.symbol ?? short(fill.outputToken)
                  return (
                    <Fragment key={fill.id}>
                      <div className="mono">{short(fill.orderHash)}</div>
                      <div>{fromWei(BigInt(fill.fillAmount), inDec)} {inSym}</div>
                      <div>{fromWei(BigInt(fill.outputAmount), outDec)} {outSym}</div>
                      <div className="mono">{short(fill.txHash)}</div>
                    </Fragment>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
