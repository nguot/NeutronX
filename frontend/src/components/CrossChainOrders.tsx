import { useState, useEffect, useRef, useCallback } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'
import { fromWei } from '../lib/tokens'
import { TimeEta } from '../lib/blocktime'

export interface CCTokenInfo { symbol: string; address: string; decimals: number; chainId: number }

interface CCFill {
  fillId:        number
  filler:        string
  fillAmount:    string
  hashlock:      string
  t1:            number
  t2:            number
  rate:          string | null
  bondAmount:    string | null
  escrowSrcAddr: string | null
  escrowDstAddr: string | null
  swapperSig:    string | null
  secret:        string | null
  status:        string
}

export interface CCOrder {
  orderHash:    string
  swapper:      string
  inputToken:   string
  inputAmount:  string
  outputToken:  string
  minOutput:    string
  deadlineBase: number
  feeTier:      number
  swapperSig:   string | null
  reactorAddr:  string
  chainAId:     number
  dstChainId:   number
  status:       string
  fills:        CCFill[]
}

const DONE_STATUSES = new Set(['claimed', 'aborted', 'slashed'])
const ESCROW_DST_ABI = [
  'function claim(bytes32 secret) external',
  'function amount() view returns (uint256)',
]

type Visual = 'empty' | 'needs-sign' | 'locked' | 'revealed' | 'claimed' | 'failed'
function fillVisual(status: string): Visual {
  if (status === 'dst_funded') return 'needs-sign'
  if (status === 'authorized' || status === 'src_locked') return 'locked'
  if (status === 'revealed') return 'revealed'
  if (status === 'claimed') return 'claimed'
  if (status === 'aborted' || status === 'slashed') return 'failed'
  return 'empty'
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

interface CrossChainOrdersProps {
  wallet: WalletState
  switchNetwork: (chainId: number) => Promise<void>
}

// ── Cross-chain order list for the connected wallet (used on the Orders page) ──
export default function CrossChainOrders({ wallet, switchNetwork }: CrossChainOrdersProps) {
  const { backendUrl } = useAppConfig()
  const [orders, setOrders] = useState<CCOrder[]>([])
  const [tokens, setTokens] = useState<CCTokenInfo[]>([])
  const [busyFillId, setBusyFillId] = useState<number | null>(null)
  const [actionErr, setActionErr] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // token directory (every chain) — resolves symbols/decimals for display
  useEffect(() => {
    fetch(`${backendUrl}/cc/tokens`)
      .then(r => r.json())
      .then((data: Record<number, CCTokenInfo[]>) => setTokens(Object.values(data ?? {}).flat()))
      .catch(() => {})
  }, [backendUrl])

  const fetchOrders = useCallback(async () => {
    if (!wallet.account) { setOrders([]); return }
    try {
      const res = await fetch(`${backendUrl}/cc/orders`)
      if (!res.ok) { setOrders([]); return }
      const data = await res.json()
      const mine: { orderHash: string }[] = (data.orders ?? [])
        .filter((o: any) => o.swapper?.toLowerCase() === wallet.account.toLowerCase())
      const details = await Promise.all(mine.map(async o => {
        const r = await fetch(`${backendUrl}/cc/orders/${o.orderHash}`)
        return r.ok ? await r.json() as CCOrder : null
      }))
      setOrders(details.filter((o): o is CCOrder => !!o))
    } catch { /* backend not reachable */ }
  }, [wallet.account, backendUrl])

  useEffect(() => { fetchOrders() }, [fetchOrders])

  const anyPending = orders.some(o => o.fills.some(f => !DONE_STATUSES.has(f.status)))
  useEffect(() => {
    if (anyPending && !pollRef.current) pollRef.current = setInterval(fetchOrders, 4000)
    if (!anyPending && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [anyPending, fetchOrders])

  // `t1` lets the swapper SHORTEN (never extend) the filler's proposed T1 —
  // see setFillSwapperSig on the backend for why extending isn't allowed.
  async function signFill(order: CCOrder, fill: CCFill, t1: number) {
    if (!wallet.signer) return
    setActionErr(''); setBusyFillId(fill.fillId)
    try {
      const domain = { name: 'NeutronX CrossChain', chainId: order.chainAId, verifyingContract: order.reactorAddr }
      const types = {
        CrossChainFill: [
          { name: 'orderHash',  type: 'bytes32' },
          { name: 'hashlock',   type: 'bytes32' },
          { name: 'fillAmount', type: 'uint256' },
          { name: 't1',         type: 'uint256' },
          { name: 't2',         type: 'uint256' },
        ],
      }
      const value = { orderHash: order.orderHash, hashlock: fill.hashlock, fillAmount: fill.fillAmount, t1, t2: fill.t2 }
      const swapperSig = await (wallet.signer as ethers.providers.JsonRpcSigner)._signTypedData(domain, types, value)
      const res = await fetch(`${backendUrl}/cc/fills/${fill.fillId}/swapperSig`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ swapperSig, t1 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      await fetchOrders()
    } catch (e: any) { setActionErr(e.message) }
    setBusyFillId(null)
  }

  // Fallback path — normally the relayer claims with the now-public secret.
  // If it hasn't yet, the swapper can claim directly (recipient is fixed to
  // swapper on-chain, so this can't be redirected).
  async function claimFill(order: CCOrder, fill: CCFill) {
    if (!wallet.signer || !fill.escrowDstAddr || !fill.secret) return
    setActionErr(''); setBusyFillId(fill.fillId)
    try {
      if (wallet.chainId !== order.dstChainId) await switchNetwork(order.dstChainId)
      const esc = new ethers.Contract(fill.escrowDstAddr, ESCROW_DST_ABI, wallet.signer)
      await (await esc.claim(fill.secret)).wait()
      await fetchOrders()
    } catch (e: any) { setActionErr(e.reason ?? e.message) }
    setBusyFillId(null)
  }

  // Nothing to show until a wallet is connected and it has cross-chain orders.
  if (!wallet.connected || orders.length === 0) return null

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Cross-Chain Orders</h2>
        <button className="ghost sm" style={{ marginTop: 0 }} onClick={fetchOrders}>↻ Refresh</button>
      </div>

      {actionErr && <div className="uni-err" style={{ marginBottom: 10 }}>{actionErr}</div>}

      {orders.map(o => (
        <CCOrderCard key={o.orderHash} order={o} tokens={tokens} busyFillId={busyFillId}
          onSign={(fill, t1) => signFill(o, fill, t1)} onClaim={fill => claimFill(o, fill)} />
      ))}
    </div>
  )
}

// The dest escrow's real on-chain `amount()` — fill.fillAmount is the INPUT
// side (chain A) only, so this is the one place that knows what the swapper
// actually receives on chain B.
function useDstAmount(escrowDstAddr: string | null, dstChainId: number): bigint | null {
  const { chains } = useAppConfig()
  const [amount, setAmount] = useState<bigint | null>(null)
  useEffect(() => {
    setAmount(null)
    if (!escrowDstAddr) return
    const rpc = chains.find(c => c.id === dstChainId)?.rpc
    if (!rpc) return
    let cancelled = false
    new ethers.Contract(escrowDstAddr, ESCROW_DST_ABI, new ethers.providers.JsonRpcProvider(rpc))
      .amount().then((v: ethers.BigNumber) => { if (!cancelled) setAmount(v.toBigInt()) }).catch(() => {})
    return () => { cancelled = true }
  }, [escrowDstAddr, dstChainId, chains])
  return amount
}

// ── Inline "sign" form — appears in place of the read-only detail panel when
// a fill's dest escrow is confirmed and waiting on the swapper. T1 can only
// be SHORTENED, never extended past what the filler proposed: a short T1 is
// what forces the filler to reveal early instead of sitting on a locked
// source escrow deciding whether the trade is still worth it (doc §3-4,
// "late-reveal double-dip") — letting the swapper loosen it would undo that. ──
function SignForm({ order, fill, tokens, busy, onSign }: {
  order: CCOrder; fill: CCFill; tokens: CCTokenInfo[]; busy: boolean; onSign: (t1: number) => void
}) {
  const inT  = tokens.find(t => t.address.toLowerCase() === order.inputToken.toLowerCase())
  const outT = tokens.find(t => t.address.toLowerCase() === order.outputToken.toLowerCase())
  const dstAmount = useDstAmount(fill.escrowDstAddr, order.dstChainId)

  // Max = however long is left until the filler's own proposed T1 — the
  // ceiling never moves, so `minutes` is reclamped down as time passes.
  const maxMin = () => Math.max(0, Math.floor((fill.t1 - Math.floor(Date.now() / 1000)) / 60))
  const [minutes, setMinutes] = useState(maxMin)
  useEffect(() => {
    const id = setInterval(() => setMinutes(m => Math.min(m, maxMin())), 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill.t1])
  const cap = maxMin()
  const nowSec = Math.floor(Date.now() / 1000)
  // Always clamp to fill.t1 itself as a hard ceiling, regardless of rounding.
  const t1 = Math.min(fill.t1, nowSec + minutes * 60)

  return (
    <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a' }}>
      <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>
        ✍ {fromWei(BigInt(fill.fillAmount), inT?.decimals ?? 18)} {inT?.symbol ?? '?'}
        <span className="uni-arrow"> → </span>
        {dstAmount != null ? `${fromWei(dstAmount, outT?.decimals ?? 18)} ${outT?.symbol ?? '?'}` : '…'}
      </div>
      <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 2 }}>filler <span className="mono">{fill.filler}</span></div>
      <HashRow label="Hashlock" value={fill.hashlock} />
      <HashRow label="Dst escrow" value={fill.escrowDstAddr} accent />

      {cap < 1 ? (
        <div className="uni-err">Too close to filler's proposed T1 — no longer safe to sign.</div>
      ) : (
        <>
          <div className="uni-detail-row" style={{ padding: '2px 0' }}>
            <span className="uni-detail-label">T1 <span className="uni-label-muted">(minutes from now, max {cap})</span></span>
            <input className="uni-detail-input" type="number" min={1} max={cap} value={minutes}
              onChange={e => setMinutes(Math.min(cap, Math.max(1, parseInt(e.target.value) || 1)))} />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <span className="uni-label-muted" style={{ fontSize: '0.72rem' }}>T1 {minutes < cap ? 'shortened to' : 'kept at'} <TimeEta target={t1} /></span>
            <span className="uni-label-muted" style={{ fontSize: '0.72rem' }}>T2 <TimeEta target={fill.t2} /></span>
          </div>
        </>
      )}

      <button className="ghost active sm" disabled={busy || cap < 1} onClick={() => onSign(t1)}>
        {busy ? '…' : 'Sign & confirm'}
      </button>
    </div>
  )
}

// ── Inline "claim" form — self-claim fallback for a revealed fill. ─────────
function ClaimForm({ order, fill, tokens, busy, onClaim }: {
  order: CCOrder; fill: CCFill; tokens: CCTokenInfo[]; busy: boolean; onClaim: () => void
}) {
  const outT = tokens.find(t => t.address.toLowerCase() === order.outputToken.toLowerCase())
  const dstAmount = useDstAmount(fill.escrowDstAddr, order.dstChainId)
  return (
    <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
      <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>
        🔑 {dstAmount != null ? `${fromWei(dstAmount, outT?.decimals ?? 18)} ${outT?.symbol ?? '?'}` : '…'} ready to claim
      </div>
      <HashRow label="Key (S)" value={fill.secret} accent />
      <HashRow label="Dst escrow" value={fill.escrowDstAddr} />
      <button className="ghost active sm" disabled={busy} onClick={onClaim}>
        {busy ? '…' : 'Claim'}
      </button>
    </div>
  )
}

const ICON: Record<Visual, string> = {
  empty: '＋', 'needs-sign': '✍', locked: '🔒', revealed: '🔑', claimed: '✓', failed: '✕',
}
const TAG_CLASS: Record<Visual, string> = {
  empty: 'available', 'needs-sign': 'needs-sign', locked: 'locked', revealed: 'revealed', claimed: 'claimed', failed: 'refunded',
}

interface CCOrderCardProps {
  order: CCOrder
  tokens: CCTokenInfo[]
  busyFillId: number | null
  onSign: (fill: CCFill, t1: number) => void
  onClaim: (fill: CCFill) => void
}

// ── Order card — headline + a two-rail timeline (§7 mockup): one column per
// fill, Chain A dot on top / Chain B dot on bottom, state icon in between.
// Column width ∝ fill amount, so the timeline doubles as the progress bar.
// Fills that need the swapper (dst_funded / revealed) pulse and auto-open
// their inline sign/claim form — no separate "action needed" banner. ──────
function CCOrderCard({ order, tokens, busyFillId, onSign, onClaim }: CCOrderCardProps) {
  const byAddr = (a: string) => tokens.find(t => t.address.toLowerCase() === a.toLowerCase())
  const inT  = byAddr(order.inputToken)
  const outT = byAddr(order.outputToken)
  const needsAction = (f: CCFill) => f.status === 'dst_funded' || f.status === 'revealed'
  const [openFillId, setOpenFillId] = useState<number | null>(() => order.fills.find(needsAction)?.fillId ?? null)
  // Keep auto-surfacing the next fill that needs attention if nothing is open.
  useEffect(() => {
    if (openFillId != null && order.fills.some(f => f.fillId === openFillId)) return
    const next = order.fills.find(needsAction)
    if (next) setOpenFillId(next.fillId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.fills])

  const filledAmt = order.fills.filter(f => f.status === 'claimed').reduce((s, f) => s + BigInt(f.fillAmount), 0n)
  const total = BigInt(order.inputAmount || '0')
  const status = order.fills.length === 0 ? 'pending'
    : filledAmt === total && total > 0n ? 'filled'
    : order.fills.some(f => !DONE_STATUSES.has(f.status)) ? 'active' : 'pending'
  const totalFillAmt = order.fills.reduce((s, f) => s + BigInt(f.fillAmount), 0n)
  const openFill = order.fills.find(f => f.fillId === openFillId) ?? null

  // Amount still up for grabs: total minus everything committed to a fill
  // that hasn't been freed back up by an abort/slash.
  const committedAmt = order.fills
    .filter(f => f.status !== 'aborted' && f.status !== 'slashed')
    .reduce((s, f) => s + BigInt(f.fillAmount), 0n)
  const remainingIn = total > committedAmt ? total - committedAmt : 0n
  const minOutTotal = BigInt(order.minOutput || '0')
  const remainingOut = total > 0n ? (minOutTotal * remainingIn) / total : 0n

  return (
    <div className="slot-card" style={{ marginTop: 0, marginBottom: 12 }}>
      <div className="flex-between">
        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
          {fromWei(remainingIn, inT?.decimals ?? 18)} {inT?.symbol ?? '?'}
          <span className="uni-arrow"> → </span>
          {fromWei(remainingOut, outT?.decimals ?? 18)} {outT?.symbol ?? '?'}
          {committedAmt > 0n && (
            <span className="uni-label-muted" style={{ fontSize: '0.72rem', fontWeight: 400, marginLeft: 6 }}>
              remaining (of {fromWei(total, inT?.decimals ?? 18)} {inT?.symbol ?? '?'})
            </span>
          )}
        </span>
        <span className={`badge ${status}`}>{status}</span>
      </div>
      <div className="text-muted" style={{ marginTop: 4, fontSize: '0.75rem' }}>
        deadline <TimeEta target={order.deadlineBase} showClock={false} />
      </div>

      {order.fills.length === 0 ? (
        <div className="uni-label-muted" style={{ fontSize: '0.78rem', marginTop: 10 }}>No filler quotes yet.</div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div className="cc-rail-label">{inT?.symbol ?? '?'} · Chain A</div>
          <div className="cc-timeline-track">
            {order.fills.map(f => {
              const v = fillVisual(f.status)
              const weight = totalFillAmt > 0n ? Number((BigInt(f.fillAmount) * 1000n) / totalFillAmt) : 1
              const pulse = v === 'needs-sign' || v === 'revealed'
              return (
                <div key={f.fillId} className="cc-timeline-col"
                     style={{ flexGrow: Math.max(weight, 60), outline: openFillId === f.fillId ? '2px solid #7c3aed' : 'none', borderRadius: 6 }}
                     onClick={() => setOpenFillId(id => id === f.fillId ? null : f.fillId)}
                     title={f.status.replace('_', ' ')}>
                  <span className={`cc-dot ${v}${pulse ? ' pulse' : ''}`} />
                  <span className="cc-rail" />
                  <span style={{ fontSize: '0.85rem' }}>{ICON[v]}</span>
                  <span className="cc-rail" />
                  <span className={`cc-dot ${v === 'revealed' ? 'empty' : v}${v === 'revealed' ? ' pulse' : ''}`} />
                </div>
              )
            })}
          </div>
          <div className="cc-rail-label">{outT?.symbol ?? '?'} · Chain B</div>
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <HashRow label="Order" value={order.orderHash} accent />
      </div>

      {openFill && openFill.status === 'dst_funded' && (
        <SignForm order={order} fill={openFill} tokens={tokens} busy={busyFillId === openFill.fillId}
          onSign={t1 => onSign(openFill, t1)} />
      )}
      {openFill && openFill.status === 'revealed' && (
        <ClaimForm order={order} fill={openFill} tokens={tokens} busy={busyFillId === openFill.fillId}
          onClaim={() => onClaim(openFill)} />
      )}
      {openFill && !needsAction(openFill) && <FillDetail fill={openFill} />}
    </div>
  )
}

// Read-only detail panel for a fill that isn't currently waiting on the swapper.
function FillDetail({ fill }: { fill: CCFill }) {
  const v = fillVisual(fill.status)
  return (
    <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
      <div className="flex-between" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Fill {fill.fillId}</span>
        <span className={`tag ${TAG_CLASS[v]}`}>{fill.status.replace('_', ' ')}</span>
      </div>
      <HashRow label="Hashlock" value={fill.hashlock} />
      <HashRow label="Filler" value={fill.filler} />
      <HashRow label="Src escrow" value={fill.escrowSrcAddr} />
      <HashRow label="Dst escrow" value={fill.escrowDstAddr} />
      <HashRow label="Key (S)" value={fill.secret ?? undefined} accent={!!fill.secret} />
      <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
        <span className="uni-label-muted" style={{ fontSize: '0.72rem' }}>T1 <TimeEta target={fill.t1} showClock={false} /></span>
        <span className="uni-label-muted" style={{ fontSize: '0.72rem' }}>T2 <TimeEta target={fill.t2} showClock={false} /></span>
      </div>
    </div>
  )
}
