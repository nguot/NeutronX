import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'
import { tokenByAddress, short, fromWei } from '../lib/tokens'
import { FILL_AUCTION_ABI, extractRevertReason } from '../contract/fillAuctionAbi'

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

interface FillerRegistration {
  orderHash:       string
  fillAmount:      string
  stakeAmount:     string
  status:          'active' | 'filled' | 'slashed' | 'released'
  refundAmount:    string | null
  forfeitedAmount: string | null
  slashedReward:   string | null
  slashedBy:       string | null
  registeredBlock: number
  resolvedBlock:   number | null
  resolvedTxHash:  string | null
  createdAt:       string
  orderStatus:     string
  inputToken:      string
  outputToken:     string
  orderTotal:      string
}

interface FillerInfo {
  name:          string
  address:       string
  chains:        number[]
  fills:         FillerFill[]
  swapFills:     FillerSwapFill[]
  registrations: FillerRegistration[]
}

const REG_STATUS_TAG: Record<FillerRegistration['status'], string> = {
  active: 'locked', filled: 'claimed', slashed: 'refunded', released: 'available',
}

// Public read-only directory of registered fillers (configured via Admin →
// Fillers) — shows each filler's on-chain address as plain text (no explorer
// links), the slots it has filled so far, and its stake registrations.
export default function Fillers({ wallet }: { wallet: WalletState }) {
  const { backendUrl, chains, tokens, fillAuction } = useAppConfig()
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

  const iface = useMemo(() => new ethers.utils.Interface(FILL_AUCTION_ABI), [])
  const [reclaimBusy, setReclaimBusy] = useState<Record<string, boolean>>({})
  const [reclaimErr, setReclaimErr]   = useState<Record<string, string>>({})

  async function reclaim(orderHash: string, filler: string) {
    if (!wallet.signer) return
    const key = `${orderHash}:${filler}`
    setReclaimErr(p => ({ ...p, [key]: '' }))
    setReclaimBusy(p => ({ ...p, [key]: true }))
    try {
      const c  = new ethers.Contract(fillAuction, FILL_AUCTION_ABI, wallet.signer)
      const tx = await c.releaseRegistration(orderHash, filler)
      await tx.wait()
      await load()
    } catch (e: any) {
      setReclaimErr(p => ({ ...p, [key]: extractRevertReason(e, iface) }))
    }
    setReclaimBusy(p => ({ ...p, [key]: false }))
  }

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

            <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600, marginTop: 8 }}>Stake registrations</div>
            {(f.registrations ?? []).length === 0 ? (
              <div style={{ fontSize: '0.78rem', color: '#94a3b8' }}>No stake registrations yet.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '4px 16px', fontSize: '0.78rem', marginTop: 6, alignItems: 'center' }}>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Order</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Committed</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Stake</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Status</div>
                <div style={{ color: '#64748b', fontWeight: 600 }}>Action</div>
                {f.registrations.map(reg => {
                  const inT   = tokenByAddress(reg.inputToken, tokens)
                  const inDec = inT?.decimals ?? 18
                  const inSym = inT?.symbol ?? short(reg.inputToken)
                  const key   = `${reg.orderHash}:${f.address}`
                  const canReclaim = reg.status === 'active'
                    && wallet.connected && wallet.account.toLowerCase() === f.address.toLowerCase()
                  return (
                    <Fragment key={key}>
                      <div className="mono">{short(reg.orderHash)}</div>
                      <div>{fromWei(BigInt(reg.fillAmount), inDec)} {inSym}</div>
                      <div>{ethers.utils.formatEther(reg.stakeAmount)} ETH</div>
                      <div><span className={`tag ${REG_STATUS_TAG[reg.status]}`}>{reg.status}</span></div>
                      <div>
                        {canReclaim && (
                          <button className="ghost sm" style={{ marginTop: 0, padding: '3px 10px' }}
                                  disabled={reclaimBusy[key]} onClick={() => reclaim(reg.orderHash, f.address)}>
                            {reclaimBusy[key] ? 'Reclaiming…' : 'Reclaim'}
                          </button>
                        )}
                        {reclaimErr[key] && <div className="status bad" style={{ fontSize: '0.72rem', marginTop: 4 }}>{reclaimErr[key]}</div>}
                      </div>
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
