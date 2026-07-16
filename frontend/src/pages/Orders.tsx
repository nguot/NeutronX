import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'
import { BlockEta } from '../lib/blocktime'
import { fromWei } from '../lib/tokens'
import { AuctionChart, colorForFiller } from '../components/AuctionChart'
import CrossChainOrders from '../components/CrossChainOrders'
import { REACTOR_ABI } from '../contract/reactorAbi'
import { extractRevertReason } from '../contract/fillAuctionAbi'

interface Fill {
  id:           number
  filler:       string
  fillAmount:   string
  outputAmount: string
  txHash:       string | null
  blockNumber:  number | null
  createdAt:    string
  source:       'filler' | 'fallback'
  aggregator:   string | null
}

interface Order {
  hash:        string
  swapper:     string
  inputToken:  string
  outputToken: string
  inputAmount: string
  minOutput:   string
  deadline:    number
  status:      string
  fills:       number
  createdAt:   string
  preferredAggregator: string | null
}

interface OrderDetail extends Order {
  nonce:         number
  minFillBps:    number
  startPrice:    string | null
  decayPerBlock: number
  feeTier:       number
  startBlock:    number
  fillDetails:   Fill[]
}

interface AggregatorCheckResult {
  key:           string
  name:          string
  ok:            boolean
  minAmountOut?: string
  error?:        string
}

interface FallbackCheckResult {
  orderHash:           string
  chainId:             number
  remainingInput:      string
  preferredAggregator: string | null
  minOutputTotal:      string
  paidSoFar:            string
  proRataFloor:         string
  remainingOutputOwed:  string
  requiredMinOutput:   string
  results:             AggregatorCheckResult[]
}

type StatusFilter = 'all' | 'pending' | 'active' | 'filled' | 'cancelled' | 'expired'

const STATUS_COLORS: Record<string, string> = {
  pending:   'badge pending',
  active:    'badge active',
  filled:    'badge filled',
  cancelled: 'badge cancelled',
  expired:   'badge expired',
}

function short(addr: string) { return addr ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : '—' }

export default function Orders({ wallet, switchNetwork }: { wallet: WalletState; switchNetwork: (chainId: number) => Promise<void> }) {
  const { backendUrl } = useAppConfig()

  const [orders, setOrders]     = useState<Order[]>([])
  const [total, setTotal]       = useState(0)
  const [page, setPage]         = useState(1)
  const [filter, setFilter]     = useState<StatusFilter>('all')
  const [myOrders, setMyOrders] = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail]     = useState<OrderDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const PAGE_SIZE = 15

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })
      if (filter !== 'all')             params.set('status', filter)
      if (myOrders && wallet.account)   params.set('swapper', wallet.account)
      const res  = await fetch(`${backendUrl}/orders?${params}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load orders')
      setOrders(data.orders)
      setTotal(data.total)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [backendUrl, page, filter, myOrders, wallet.account])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [filter, myOrders])

  async function loadDetail(hash: string) {
    if (expanded === hash) { setExpanded(null); setDetail(null); return }
    setExpanded(hash)
    setDetail(null)
    setDetailLoading(true)
    try {
      const res  = await fetch(`${backendUrl}/orders/${hash}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setDetail({ ...data, fillDetails: data.fills ?? [] })
    } catch { setDetail(null) }
    finally { setDetailLoading(false) }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <>
      <div className="page-header">
        <div className="page-title">Order History</div>
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#64748b' }}>Status:</span>
          {(['all','pending','active','filled','cancelled','expired'] as StatusFilter[]).map(s => (
            <button
              key={s}
              className={filter === s ? '' : 'ghost'}
              style={{ padding: '4px 12px', fontSize: '0.78rem', marginTop: 0, borderRadius: 999 }}
              onClick={() => setFilter(s)}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}

          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {wallet.connected && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, cursor: 'pointer', fontSize: '0.82rem', color: '#475569' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto', cursor: 'pointer' }}
                  checked={myOrders}
                  onChange={e => setMyOrders(e.target.checked)}
                />
                My orders only
              </label>
            )}
            <button className="ghost sm" style={{ marginTop: 0 }} onClick={load}>↻ Refresh</button>
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {error && <div className="status bad" style={{ margin: 16 }}>{error}</div>}
        {loading && <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>Loading…</div>}

        {!loading && orders.length === 0 && !error && (
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            No orders found
          </div>
        )}

        {!loading && orders.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Hash</th>
                <th>Swapper</th>
                <th>Input → Output</th>
                <th>Status</th>
                <th>Fills</th>
                <th>Deadline</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <React.Fragment key={o.hash}>
                  <tr style={{ cursor: 'pointer' }} onClick={() => loadDetail(o.hash)}>
                    <td className="mono">{short(o.hash)}</td>
                    <td className="mono">{short(o.swapper)}</td>
                    <td style={{ fontSize: '0.78rem' }}>
                      <span className="mono">{short(o.inputToken)}</span>
                      <span style={{ color: '#94a3b8', margin: '0 4px' }}>→</span>
                      <span className="mono">{short(o.outputToken)}</span>
                    </td>
                    <td><span className={STATUS_COLORS[o.status] ?? 'badge'}>{o.status}</span></td>
                    <td style={{ color: o.fills > 0 ? '#16a34a' : '#94a3b8' }}>{o.fills}</td>
                    <td style={{ color: '#64748b', fontSize: '0.78rem' }}><BlockEta target={o.deadline} /></td>
                    <td style={{ color: '#64748b', fontSize: '0.75rem' }}>{new Date(o.createdAt).toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="ghost sm" style={{ marginTop: 0, padding: '3px 10px' }}>
                        {expanded === o.hash ? '▲' : '▼'}
                      </button>
                    </td>
                  </tr>

                  {expanded === o.hash && (
                    <tr>
                      <td colSpan={8} style={{ background: '#f8fafc', padding: '16px 20px' }}>
                        {detailLoading && <div style={{ color: '#94a3b8', fontSize: '0.82rem' }}>Loading…</div>}
                        {detail && <OrderDetailPanel order={detail} wallet={wallet} onCancelled={load} />}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '14px 16px', borderTop: '1px solid #f1f5f9' }}>
            <button className="ghost sm" disabled={page === 1} onClick={() => setPage(p => p - 1)} style={{ marginTop: 0 }}>← Prev</button>
            <span style={{ fontSize: '0.8rem', color: '#64748b' }}>Page {page} of {totalPages} · {total} total</span>
            <button className="ghost sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} style={{ marginTop: 0 }}>Next →</button>
          </div>
        )}
      </div>

      {/* Cross-chain orders for the connected wallet (hidden when none) */}
      <CrossChainOrders wallet={wallet} switchNetwork={switchNetwork} />
    </>
  )
}

function OrderDetailPanel({ order, wallet, onCancelled }: { order: OrderDetail; wallet: WalletState; onCancelled: () => void }) {
  const { backendUrl, tokens, currentBlock, partialFillReactor } = useAppConfig()
  const inT  = tokens.find(t => t.address.toLowerCase() === order.inputToken.toLowerCase())
  const outT = tokens.find(t => t.address.toLowerCase() === order.outputToken.toLowerCase())
  const inDec  = inT?.decimals ?? 18
  const outDec = outT?.decimals ?? 6
  const inSym  = inT?.symbol  ?? short(order.inputToken)
  const outSym = outT?.symbol ?? short(order.outputToken)

  const inWei  = BigInt(order.inputAmount)
  const filled = order.fillDetails.reduce((s, f) => s + BigInt(f.fillAmount), 0n)
  const pct    = inWei > 0n ? Number(filled * 100n / inWei) : 0
  const curBlock = currentBlock ?? order.startBlock

  const [fbCheck, setFbCheck]     = useState<FallbackCheckResult | null>(null)
  const [fbLoading, setFbLoading] = useState(false)
  const [fbError, setFbError]     = useState('')

  const reactorIface = useMemo(() => new ethers.utils.Interface(REACTOR_ABI), [])
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelErr, setCancelErr]   = useState('')
  const [cancelMsg, setCancelMsg]   = useState('')

  const canCancel = wallet.connected
    && wallet.account.toLowerCase() === order.swapper.toLowerCase()
    && (order.status === 'pending' || order.status === 'active')

  async function cancelOrder() {
    if (!wallet.signer) return
    if (!window.confirm('Cancel this order? This invalidates its nonce on-chain — permanent and cannot be undone.')) return
    setCancelErr(''); setCancelMsg(''); setCancelBusy(true)
    try {
      const c  = new ethers.Contract(partialFillReactor, REACTOR_ABI, wallet.signer)
      const tx = await c.invalidateNonce(order.nonce)
      setCancelMsg('Cancelling…')
      await tx.wait()
      setCancelMsg('Cancelled on-chain — order list updates once the indexer catches up (a few seconds).')
      onCancelled()
    } catch (e: any) { setCancelErr(extractRevertReason(e, reactorIface)) }
    setCancelBusy(false)
  }

  async function checkFallback() {
    setFbLoading(true)
    setFbError('')
    setFbCheck(null)
    try {
      const res  = await fetch(`${backendUrl}/fallback/check/${order.hash}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Check failed')
      setFbCheck(data)
    } catch (e: any) { setFbError(e.message) }
    finally { setFbLoading(false) }
  }

  return (
    <div>
      {/* Dutch-auction price-decay timeline — same chart as the live Swap view,
          reconstructed from the order's persisted curve params + startBlock. */}
      {order.startPrice && (
        <>
          <div className="text-muted" style={{ textAlign: 'center', marginBottom: 4 }}>
            Auction ends <BlockEta target={order.deadline} current={curBlock} />
          </div>
          <AuctionChart
            startBlock={order.startBlock} deadline={order.deadline}
            startPriceContract={BigInt(order.startPrice)} decayContract={BigInt(order.decayPerBlock)}
            curBlock={curBlock} inDec={inDec} outDec={outDec}
            inSym={inSym} outSym={outSym}
            fills={order.fillDetails} totalAmount={inWei}
          />
          <div className="uni-fill-section">
            <div className="uni-fill-label">
              <span>Filled</span>
              <span>{fromWei(filled, inDec)} / {fromWei(inWei, inDec)} {inSym} <strong>{pct.toFixed(0)}%</strong></span>
            </div>
            <div className="uni-fill-track">
              {order.fillDetails.map(f => {
                const segPct = inWei > 0n ? Number(BigInt(f.fillAmount) * 1000n / inWei) / 10 : 0
                return <div key={f.id} className="uni-fill-segment" style={{ width: `${segPct}%`, background: colorForFiller(f.filler) }} />
              })}
            </div>
            {order.fillDetails.length > 0 && (
              <table style={{ width: '100%', fontSize: '0.76rem', marginTop: 8, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                    <th style={{ fontWeight: 500, paddingRight: 12 }}>Filler</th>
                    <th style={{ fontWeight: 500, paddingRight: 12 }}>Source</th>
                    <th style={{ fontWeight: 500, paddingRight: 12 }}>Paid (in)</th>
                    <th style={{ fontWeight: 500 }}>Received (out)</th>
                  </tr>
                </thead>
                <tbody>
                  {order.fillDetails.map(f => (
                    <tr key={f.id}>
                      <td style={{ paddingRight: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 4, background: colorForFiller(f.filler), flexShrink: 0 }} />
                        <span className="mono">{short(f.filler)}</span>
                      </td>
                      <td style={{ paddingRight: 12 }}>{f.source === 'fallback' ? `fallback · ${f.aggregator ?? '?'}` : 'filler'}</td>
                      <td style={{ paddingRight: 12 }}>{fromWei(BigInt(f.fillAmount), inDec)} {inSym}</td>
                      <td>{fromWei(BigInt(f.outputAmount), outDec)} {outSym}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px 24px', fontSize: '0.78rem', margin: '12px 0' }}>
        <Field label="Full Hash"       value={order.hash} mono />
        <Field label="Nonce"           value={String(order.nonce)} />
        <Field label="Min Fill Bps"    value={`${order.minFillBps} (${(order.minFillBps / 100).toFixed(1)}%)`} />
        <Field label="Input Amount"    value={`${fromWei(inWei, inDec)} ${inSym}`} />
        <Field label="Min Output"      value={`${fromWei(BigInt(order.minOutput), outDec)} ${outSym}`} />
        <Field label="Fee Tier"        value={String(order.feeTier)} />
        <Field label="Fallback Route"  value={order.preferredAggregator ?? 'Auto (best price)'} />
      </div>

      {canCancel && (
        <div className="uni-fill-section" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="ghost sm" style={{ marginTop: 0 }} onClick={cancelOrder} disabled={cancelBusy}>
            {cancelBusy ? 'Cancelling…' : 'Cancel order'}
          </button>
          {cancelErr && <span className="status bad" style={{ fontSize: '0.78rem' }}>{cancelErr}</span>}
          {cancelMsg && <span style={{ fontSize: '0.78rem', color: '#16a34a' }}>{cancelMsg}</span>}
        </div>
      )}

      <div className="uni-fill-section">
        <div className="uni-fill-label">
          <span>Fallback Route Check</span>
          <button className="ghost sm" style={{ marginTop: 0 }} onClick={checkFallback} disabled={fbLoading || order.status === 'filled'}>
            {fbLoading ? 'Checking…' : order.status === 'filled' ? 'Fully filled' : 'Test fallback route'}
          </button>
        </div>
        {fbError && <div className="status bad" style={{ fontSize: '0.78rem', marginTop: 6 }}>{fbError}</div>}
        {fbCheck && fbCheck.remainingInput === '0' && (
          <div className="text-muted" style={{ marginTop: 6, fontSize: '0.78rem' }}>
            Order fully filled ({fromWei(BigInt(fbCheck.paidSoFar), outDec)} {outSym} paid out of {fromWei(BigInt(fbCheck.minOutputTotal), outDec)} {outSym} owed) — nothing left to route via fallback.
          </div>
        )}
        {fbCheck && fbCheck.remainingInput !== '0' && (
          <div style={{ marginTop: 6, fontSize: '0.78rem' }}>
            <div className="text-muted" style={{ marginBottom: 4 }}>
              Input remaining: <strong>{fromWei(BigInt(fbCheck.remainingInput), inDec)} {inSym}</strong> on chain {fbCheck.chainId}
              {fbCheck.preferredAggregator && <> · pinned to <strong>{fbCheck.preferredAggregator}</strong></>}
            </div>
            <div className="text-muted" style={{ marginBottom: 4 }}>
              Output — total owed {fromWei(BigInt(fbCheck.minOutputTotal), outDec)} {outSym},
              {' '}already paid {fromWei(BigInt(fbCheck.paidSoFar), outDec)} {outSym},
              {' '}still owed <strong>{fromWei(BigInt(fbCheck.remainingOutputOwed), outDec)} {outSym}</strong>
            </div>
            <div className="text-muted" style={{ marginBottom: 6 }}>
              Two on-chain gates a quote must BOTH clear:
              {' '}per-leg pro-rata floor <strong>{fromWei(BigInt(fbCheck.proRataFloor), outDec)} {outSym}</strong>
              {' '}(FallbackExecutor.sol, this leg alone) · cumulative floor <strong>{fromWei(BigInt(fbCheck.remainingOutputOwed), outDec)} {outSym}</strong>
              {' '}(PartialFillReactor.sol, total order) → effective required min:{' '}
              <strong>{fromWei(BigInt(fbCheck.requiredMinOutput), outDec)} {outSym}</strong>
            </div>
            {fbCheck.results.map(r => {
              const clearsFloor = r.ok && BigInt(r.minAmountOut!) >= BigInt(fbCheck.requiredMinOutput)
              return (
                <div key={r.key} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' }}>
                  <span style={{ color: clearsFloor ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{clearsFloor ? '✓' : '✗'}</span>
                  <span style={{ minWidth: 160 }}>{r.name}</span>
                  {r.ok
                    ? <span>
                        {fromWei(BigInt(r.minAmountOut!), outDec)} {outSym} min{' '}
                        <span style={{ color: clearsFloor ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                          {clearsFloor ? '· clears both floors' : '· below required floor (would revert)'}
                        </span>
                      </span>
                    : <span className="text-muted" style={{ wordBreak: 'break-all' }}>{r.error}</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {order.fillDetails.length === 0
        ? <p className="uni-waiting">Waiting for fillers…</p>
        : order.fillDetails.map(f => (
          <div key={f.id} className="uni-fill-row">
            <span className="uni-fill-dot" style={{ background: f.source === 'fallback' ? '#f59e0b' : colorForFiller(f.filler) }} />
            <span className="uni-fill-filler">
              {f.source === 'fallback' ? `⚡ Fallback via ${f.aggregator}` : f.filler}
            </span>
            <span className="uni-fill-info">
              {fromWei(BigInt(f.fillAmount), inDec)} {inSym}
              {f.source === 'fallback' && <> → {fromWei(BigInt(f.outputAmount), outDec)} {outSym}</>}
            </span>
            <span className="uni-fill-block" title={f.txHash ?? undefined}>{f.blockNumber ? `#${f.blockNumber}` : new Date(f.createdAt).toLocaleTimeString()}</span>
          </div>
        ))
      }
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: '0.8rem', fontFamily: mono ? 'monospace' : 'inherit', wordBreak: 'break-all', color: '#0f172a' }}>{value}</div>
    </div>
  )
}
