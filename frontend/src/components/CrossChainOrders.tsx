import { useState, useEffect, useRef, useCallback } from 'react'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'
import { fromWei } from '../lib/tokens'
import { BlockEta } from '../lib/blocktime'

export interface CCTokenInfo { symbol: string; address: string; decimals: number; chainId: number }

interface Slot {
  index:          number
  hashlock:       string
  status:         string
  assignedFiller: string | null
  escrowAddr:     string | null
}

export interface CCOrder {
  orderHash:   string
  inputToken:  string
  inputAmount: string
  outputToken: string
  minOutput:   string
  deadline:    number
  numSlots:    number
  t2Expiry:    number
  slots:       Slot[]
}

// ── Full, copyable hash/address row (also used by the CrossChain info panel) ──
export function HashRow({ label, value, accent = false }: { label: string; value?: string | null; accent?: boolean }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' }}>
      <span className="uni-detail-label" style={{ minWidth: 62, flexShrink: 0 }}>{label}</span>
      <code style={{
        flex: 1, fontSize: '0.72rem', wordBreak: 'break-all', lineHeight: 1.4,
        color: accent ? '#0f172a' : '#64748b', fontWeight: accent ? 600 : 400,
      }}>{value}</code>
      <button className="ghost sm" style={{ marginTop: 0, padding: '1px 7px', fontSize: '0.68rem', flexShrink: 0 }}
        onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
        {copied ? '✓' : 'copy'}
      </button>
    </div>
  )
}

// ── Cross-chain order list for the connected wallet (used on the Orders page) ──
export default function CrossChainOrders({ wallet }: { wallet: WalletState }) {
  const { backendUrl } = useAppConfig()
  const [orders, setOrders] = useState<CCOrder[]>([])
  const [tokens, setTokens] = useState<CCTokenInfo[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // token directory (every chain) — resolves symbols/decimals for display
  useEffect(() => {
    fetch(`${backendUrl}/tokens?chainId=all`)
      .then(r => r.json())
      .then(d => setTokens(d.tokens ?? []))
      .catch(() => {})
  }, [backendUrl])

  const fetchOrders = useCallback(async () => {
    if (!wallet.account) { setOrders([]); return }
    try {
      const res = await fetch(`${backendUrl}/cc/session/${wallet.account}`)
      if (!res.ok) { setOrders([]); return }
      const data = await res.json()
      setOrders(data.orders ?? [])
    } catch { /* backend not reachable */ }
  }, [wallet.account, backendUrl])

  useEffect(() => { fetchOrders() }, [fetchOrders])

  const anyPending = orders.some(o => o.slots.some(s => s.status !== 'done'))
  useEffect(() => {
    if (anyPending && !pollRef.current) pollRef.current = setInterval(fetchOrders, 4000)
    if (!anyPending && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [anyPending, fetchOrders])

  // Nothing to show until a wallet is connected and it has cross-chain orders.
  if (!wallet.connected || orders.length === 0) return null

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Cross-Chain Orders</h2>
        <button className="ghost sm" style={{ marginTop: 0 }} onClick={fetchOrders}>↻ Refresh</button>
      </div>
      {orders.map(o => <CCOrderCard key={o.orderHash} order={o} tokens={tokens} />)}
    </div>
  )
}

// ── Order card — every hash shown in full; status / order hash highlighted ────
function CCOrderCard({ order, tokens }: { order: CCOrder; tokens: CCTokenInfo[] }) {
  const [open, setOpen] = useState(false)
  const byAddr = (a: string) => tokens.find(t => t.address.toLowerCase() === a.toLowerCase())
  const inT  = byAddr(order.inputToken)
  const outT = byAddr(order.outputToken)
  const done = order.slots.filter(s => s.status === 'done' || s.status === 'claimed').length
  const pct  = order.numSlots > 0 ? Math.min(100, (done / order.numSlots) * 100) : 0
  const status = done === order.numSlots ? 'filled' : order.slots.some(s => s.status !== 'available') ? 'active' : 'pending'

  return (
    <div className="slot-card" style={{ marginTop: 0, marginBottom: 12 }}>
      {/* headline: amounts + status badge */}
      <div className="flex-between">
        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
          {fromWei(BigInt(order.inputAmount), inT?.decimals ?? 18)} {inT?.symbol ?? '?'}
          <span className="uni-arrow"> → </span>
          {fromWei(BigInt(order.minOutput), outT?.decimals ?? 18)} {outT?.symbol ?? '?'}
        </span>
        <span className={`badge ${status}`}>{status}</span>
      </div>

      {/* progress */}
      <div className="uni-fill-track" style={{ marginTop: 10 }}>
        <div className="uni-fill-bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-muted" style={{ marginTop: 6, fontSize: '0.75rem' }}>
        {done}/{order.numSlots} slots filled · deadline <BlockEta target={order.deadline} showClock={false} /> · T2 <BlockEta target={order.t2Expiry} showClock={false} />
      </div>

      {/* the order hash — always visible, full + copyable */}
      <div style={{ marginTop: 10 }}>
        <HashRow label="Order" value={order.orderHash} accent />
      </div>

      <button className="ghost sm" style={{ marginTop: 4 }} onClick={() => setOpen(o => !o)}>
        {open ? '▲ hide slot hashes' : `▾ show ${order.numSlots} slot hashes`}
      </button>

      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {order.slots.map(slot => {
            const sCls = slot.status === 'locked' ? 'locked'
              : (slot.status === 'claimed' || slot.status === 'done') ? 'claimed' : 'available'
            const active = slot.status !== 'available' // a slot a filler has started → highlight it
            return (
              <div key={slot.index} style={{
                padding: '8px 10px', borderRadius: 8,
                background: active ? '#faf5ff' : '#f8fafc',
                border: `1px solid ${active ? '#e9d5ff' : '#e2e8f0'}`,
              }}>
                <div className="flex-between" style={{ marginBottom: 4 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Slot {slot.index}</span>
                  <span className={`tag ${sCls}`}>{slot.status}</span>
                </div>
                <HashRow label="Hashlock" value={slot.hashlock} />
                <HashRow label="Escrow"   value={slot.escrowAddr} />
                <HashRow label="Filler"   value={slot.assignedFiller} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
