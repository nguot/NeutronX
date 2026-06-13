import React, { useState, useEffect, useCallback } from 'react'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'

interface Fill {
  id:           number
  filler:       string
  fillAmount:   string
  outputAmount: string
  txHash:       string | null
  blockNumber:  number | null
  createdAt:    string
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
}

interface OrderDetail extends Order {
  nonce:         number
  minFillBps:    number
  startPrice:    string | null
  decayPerBlock: number
  feeTier:       number
  fillDetails:   Fill[]
}

type StatusFilter = 'all' | 'pending' | 'active' | 'filled' | 'cancelled'

const STATUS_COLORS: Record<string, string> = {
  pending:   'badge pending',
  active:    'badge active',
  filled:    'badge filled',
  cancelled: 'badge cancelled',
}

function short(addr: string) { return addr ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : '—' }

export default function Orders({ wallet }: { wallet: WalletState }) {
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
        <div className="page-sub">All Dutch-auction orders tracked by the backend</div>
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#64748b' }}>Status:</span>
          {(['all','pending','active','filled','cancelled'] as StatusFilter[]).map(s => (
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
                    <td style={{ color: '#64748b', fontSize: '0.78rem' }}>{o.deadline}</td>
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
                        {detail && <OrderDetailPanel order={detail} />}
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
    </>
  )
}

function OrderDetailPanel({ order }: { order: OrderDetail }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px 24px', fontSize: '0.78rem', marginBottom: 12 }}>
        <Field label="Full Hash"       value={order.hash} mono />
        <Field label="Nonce"           value={String(order.nonce)} />
        <Field label="Min Fill Bps"    value={`${order.minFillBps} (${(order.minFillBps / 100).toFixed(1)}%)`} />
        <Field label="Input Amount"    value={order.inputAmount} mono />
        <Field label="Min Output"      value={order.minOutput} mono />
        <Field label="Fee Tier"        value={String(order.feeTier)} />
        {order.startPrice && <Field label="Start Price" value={order.startPrice} mono />}
        <Field label="Decay / Block"   value={String(order.decayPerBlock)} />
      </div>

      {order.fillDetails.length > 0 ? (
        <>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
            Fills ({order.fillDetails.length})
          </div>
          {order.fillDetails.map(f => (
            <div key={f.id} className="slot-card claimed" style={{ marginTop: 6 }}>
              <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Filler:</span>{' '}
              <code>{f.filler}</code>
              &nbsp;&nbsp;
              <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Fill Amt:</span>{' '}
              <code>{f.fillAmount}</code>
              &nbsp;&nbsp;
              <span style={{ color: '#64748b', fontSize: '0.72rem' }}>Output:</span>{' '}
              <code>{f.outputAmount}</code>
              {f.txHash && (
                <span>&nbsp;&nbsp;<span style={{ color: '#64748b', fontSize: '0.72rem' }}>Tx:</span>{' '}<code style={{ wordBreak: 'break-all' }}>{f.txHash}</code></span>
              )}
              {f.blockNumber && (
                <span>&nbsp;&nbsp;<span style={{ color: '#64748b', fontSize: '0.72rem' }}>Block:</span>{' '}{f.blockNumber}</span>
              )}
            </div>
          ))}
        </>
      ) : (
        <div style={{ color: '#94a3b8', fontSize: '0.8rem', fontStyle: 'italic' }}>No fills recorded yet.</div>
      )}
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
