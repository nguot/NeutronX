import { useState, useEffect, useCallback, useRef } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const P2_ABI  = ['function allowance(address,address,address) view returns (uint160,uint48,uint48)', 'function approve(address,address,uint160,uint48)']
const ERC_ABI = ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']

function toWei(val: string, dec: number): bigint {
  try { return ethers.utils.parseUnits(val || '0', dec).toBigInt() } catch { return 0n }
}
function fromWei(wei: bigint, dec: number): string {
  return parseFloat(ethers.utils.formatUnits(wei.toString(), dec)).toLocaleString(undefined, { maximumFractionDigits: 6 })
}
function short(addr: string) { return addr ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : '—' }

interface CCTokenInfo { symbol: string; address: string; decimals: number; chainId: number }

interface Slot {
  index:          number
  hashlock:       string
  status:         string
  assignedFiller: string | null
  escrowAddr:     string | null
}

interface CCOrder {
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

type Step = 'idle' | 'checking' | 'erc20' | 'p2' | 'ready' | 'busy'

export default function CrossChain({ wallet }: { wallet: WalletState }) {
  const { backendUrl, crossChainReactor } = useAppConfig()

  const [inputTokens,  setInputTokens]  = useState<CCTokenInfo[]>([])
  const [outputTokens, setOutputTokens] = useState<CCTokenInfo[]>([])
  const [inKey,  setInKey]  = useState('')
  const [outKey, setOutKey] = useState('')
  const [inAmt,  setInAmt]  = useState('')
  const [outAmt, setOutAmt] = useState('')

  const [adv, setAdv] = useState({ deadline: '', t2Buffer: '50', nonce: String(Date.now() % 1000000) })
  const setAdvField = (k: keyof typeof adv) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setAdv(a => ({ ...a, [k]: e.target.value }))

  const [showInfo, setShowInfo] = useState(false)
  const [cosignerAddr, setCosignerAddr] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [msg,  setMsg]  = useState('')
  const [err,  setErr]  = useState('')
  const [orderStatus, setOrderStatus] = useState<{ msg: string; cls: string } | null>(null)
  const [orders, setOrders] = useState<CCOrder[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const inT  = inputTokens.find(t => t.symbol === inKey)
  const outT = outputTokens.find(t => t.symbol === outKey)
  const inW  = inT  ? toWei(inAmt,  inT.decimals)  : 0n
  const outW = outT ? toWei(outAmt, outT.decimals) : 0n

  // ── token directory ─────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${backendUrl}/cc/tokens`)
      .then(r => r.json())
      .then(data => {
        setInputTokens(data.inputTokens ?? [])
        setOutputTokens(data.outputTokens ?? [])
        if (data.inputTokens?.[0])  setInKey(data.inputTokens[0].symbol)
        if (data.outputTokens?.[0]) setOutKey(data.outputTokens[0].symbol)
      })
      .catch(() => {})
  }, [backendUrl])

  // ── approvals (Permit2, same pattern as the Swap page) ──────────────────────
  const checkApproval = useCallback(async () => {
    if (!wallet.provider || !wallet.account || !crossChainReactor || !inT) return
    setStep('checking')
    try {
      const erc = new ethers.Contract(inT.address, ERC_ABI, wallet.provider)
      const p2  = new ethers.Contract(PERMIT2, P2_ABI, wallet.provider)
      const ea  = await erc.allowance(wallet.account, PERMIT2)
      const [pa, pe] = await p2.allowance(wallet.account, inT.address, crossChainReactor)
      const eOk = ea.gte(ethers.utils.parseUnits('1000000', inT.decimals))
      const pOk = pa.gt(0) && Number(pe) > Date.now() / 1000
      setStep(!eOk ? 'erc20' : !pOk ? 'p2' : 'ready')
    } catch { setStep('idle') }
  }, [wallet.provider, wallet.account, crossChainReactor, inT?.address])

  useEffect(() => {
    if (wallet.connected && crossChainReactor && inT) checkApproval()
  }, [wallet.connected, crossChainReactor, inT?.address, checkApproval])

  async function doApproveERC20() {
    if (!wallet.signer || !inT) return
    setStep('busy'); setMsg('Approving…')
    try { await (await new ethers.Contract(inT.address, ERC_ABI, wallet.signer).approve(PERMIT2, ethers.constants.MaxUint256)).wait(); await checkApproval() }
    catch (e: any) { setErr(e.message); setStep('erc20') }
    setMsg('')
  }
  async function doApproveP2() {
    if (!wallet.signer || !inT || !crossChainReactor) return
    setStep('busy'); setMsg('Approving Permit2…')
    try {
      const p2 = new ethers.Contract(PERMIT2, P2_ABI, wallet.signer)
      await (await p2.approve(inT.address, crossChainReactor, ethers.BigNumber.from('0xffffffffffffffffffffffffffffffff'), ethers.BigNumber.from('0xffffffffffff'))).wait()
      await checkApproval()
    } catch (e: any) { setErr(e.message); setStep('p2') }
    setMsg('')
  }

  // ── session (auto init/restore — no manual button) ──────────────────────────
  const ensureSession = useCallback(async () => {
    if (!wallet.account) return
    try {
      const res = await fetch(`${backendUrl}/cc/session/${wallet.account}`)
      if (res.ok) {
        const data = await res.json()
        setCosignerAddr(data.cosignerAddr)
        setOrders(data.orders ?? [])
        return
      }
    } catch { /* fall through to create */ }
    try {
      const res  = await fetch(`${backendUrl}/cc/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ swapper: wallet.account }),
      })
      const data = await res.json()
      if (res.ok) setCosignerAddr(data.cosignerAddr)
    } catch { /* backend not reachable */ }
  }, [wallet.account, backendUrl])

  useEffect(() => { ensureSession() }, [ensureSession])

  const fetchOrders = useCallback(async () => {
    if (!wallet.account) return
    try {
      const res  = await fetch(`${backendUrl}/cc/session/${wallet.account}`)
      if (!res.ok) return
      const data = await res.json()
      setOrders(data.orders ?? [])
    } catch {}
  }, [wallet.account, backendUrl])

  const anyPending = orders.some(o => o.slots.some(s => s.status !== 'done'))
  useEffect(() => {
    if (anyPending && !pollRef.current) pollRef.current = setInterval(fetchOrders, 4000)
    if (!anyPending && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [anyPending, fetchOrders])

  // ── submit ───────────────────────────────────────────────────────────────────
  async function doSwap() {
    if (!wallet.signer || !crossChainReactor || !inT || !outT) return
    if (!cosignerAddr) { setErr('Session is still being set up — try again in a moment.'); return }

    setErr(''); setStep('busy'); setMsg('Requesting Merkle tree…')
    const deadline = adv.deadline ? parseInt(adv.deadline) : wallet.blockNumber + 200
    const nonce    = adv.nonce || String(Date.now() % 1000000)

    try {
      const res  = await fetch(`${backendUrl}/cc/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          swapper: wallet.account,
          inputToken: inT.address, inputAmount: inW.toString(),
          outputToken: outT.address, minOutput: outW.toString(),
          deadline, nonce,
          chainAId: inT.chainId, reactorAddr: crossChainReactor,
          t2Buffer: parseInt(adv.t2Buffer || '50'),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      // Sign the order with the swapper's wallet (EIP-712) — no on-chain tx.
      // EscrowSrcFactory registers the order lazily on the first fillSlot()
      // call by a filler, which requires both this signature and cosignerSig.
      setMsg('Sign order in wallet…')
      const domain = { name: 'NeutronX CrossChain', chainId: inT.chainId, verifyingContract: crossChainReactor }
      const types = {
        CrossChainOrder: [
          { name: 'swapper',     type: 'address' },
          { name: 'inputToken',  type: 'address' },
          { name: 'inputAmount', type: 'uint256' },
          { name: 'outputToken', type: 'address' },
          { name: 'minOutput',   type: 'uint256' },
          { name: 'deadline',    type: 'uint256' },
          { name: 'nonce',       type: 'uint256' },
          { name: 'merkleRoot',  type: 'bytes32' },
          { name: 'numSlots',    type: 'uint8' },
        ],
      }
      const value = {
        swapper: wallet.account,
        inputToken: inT.address, inputAmount: inW.toString(),
        outputToken: outT.address, minOutput: outW.toString(),
        deadline, nonce,
        merkleRoot: data.merkleRoot, numSlots: data.numSlots,
      }
      const swapperSig = await (wallet.signer as ethers.providers.JsonRpcSigner)._signTypedData(domain, types, value)

      setMsg('Saving signature…')
      const sigRes = await fetch(`${backendUrl}/cc/orders/${data.orderHash}/swapperSig`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ swapperSig }),
      })
      const sigData = await sigRes.json()
      if (!sigRes.ok) throw new Error(sigData.error)

      setOrderStatus({ msg: `✔ Order signed — ${data.numSlots} slots, ready for fillers · ${short(data.orderHash)}`, cls: 'ok' })
      setInAmt(''); setOutAmt('')
      await fetchOrders()
    } catch (e: any) {
      setErr(e.reason ?? e.message)
    }
    setStep('ready'); setMsg('')
  }

  function SwapButton() {
    if (!wallet.connected)   return <button className="uni-btn" disabled>Connect wallet</button>
    if (!crossChainReactor)  return <button className="uni-btn" disabled>Cross-chain not configured</button>
    if (!inT || !outT)       return <button className="uni-btn" disabled>Loading tokens…</button>
    if (!cosignerAddr)       return <button className="uni-btn" disabled>Setting up session…</button>
    if (step === 'checking') return <button className="uni-btn" disabled>Checking…</button>
    if (step === 'busy')     return <button className="uni-btn" disabled>{msg}</button>
    if (step === 'erc20')    return <button className="uni-btn" onClick={doApproveERC20}>Approve {inT.symbol}</button>
    if (step === 'p2')       return <button className="uni-btn" onClick={doApproveP2}>Enable spending</button>
    if (!(inW > 0n && outW > 0n)) return <button className="uni-btn" disabled>Enter amounts</button>
    return <button className="uni-btn active" onClick={doSwap}>Swap</button>
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Cross-Chain Swap</div>
        <div className="page-sub">Lock on Chain A, claim on Chain B — settled via HTLC slot escrows</div>
      </div>

      {!crossChainReactor && (
        <div className="status warn" style={{ maxWidth: 464, margin: '0 auto 16px' }}>
          ⚠ Cross-chain swap is not configured yet.
        </div>
      )}

      <div className="uni-page">
        <div className="uni-card">
          <div className="uni-header">
            <span className="uni-title">Cross-Chain Swap</span>
            <button className="uni-info-btn" title="Session &amp; contract details" onClick={() => setShowInfo(s => !s)}>ⓘ</button>
          </div>

          {showInfo && (
            <div className="uni-info-panel">
              <div>Reactor (Chain A): <code>{crossChainReactor || '—'}</code></div>
              {cosignerAddr && <div>Cosigner: <code>{cosignerAddr}</code></div>}
              {inT  && <div>Input chain id: <code>{inT.chainId}</code></div>}
              {outT && <div>Output chain id: <code>{outT.chainId}</code></div>}
            </div>
          )}

          {/* Send box (Chain A) */}
          <div className="uni-input-box">
            <div className="uni-input-label">
              You send <span className="uni-label-muted">· Chain {inT?.chainId ?? '—'}</span>
            </div>
            <div className="uni-input-row">
              <input className="uni-amount" type="number" placeholder="0" value={inAmt}
                onChange={e => setInAmt(e.target.value)} />
              <CCTokenPill tokens={inputTokens} value={inKey}
                onChange={k => { setInKey(k); setStep('idle') }} />
            </div>
          </div>

          <div className="uni-flip-wrap">
            <div className="uni-flip" style={{ cursor: 'default' }} title="Chain A → Chain B">↓</div>
          </div>

          {/* Receive box (Chain B) */}
          <div className="uni-input-box">
            <div className="uni-input-label">
              You receive <span className="uni-label-muted">(minimum) · Chain {outT?.chainId ?? '—'}</span>
            </div>
            <div className="uni-input-row">
              <input className="uni-amount" type="number" placeholder="0" value={outAmt}
                onChange={e => setOutAmt(e.target.value)} />
              <CCTokenPill tokens={outputTokens} value={outKey} onChange={setOutKey} />
            </div>
          </div>

          {/* Advanced — collapsed by default */}
          <details className="uni-advanced">
            <summary>Advanced</summary>
            <div className="uni-detail-row">
              <span className="uni-detail-label">Deadline <span className="uni-label-muted">(Chain A block)</span></span>
              <input className="uni-detail-input" type="number" placeholder={String(wallet.blockNumber + 200)}
                value={adv.deadline} onChange={setAdvField('deadline')} />
            </div>
            <div className="uni-detail-row">
              <span className="uni-detail-label">T2 buffer <span className="uni-label-muted">(blocks)</span></span>
              <input className="uni-detail-input" type="number" min="0" value={adv.t2Buffer} onChange={setAdvField('t2Buffer')} />
            </div>
            <div className="uni-detail-row">
              <span className="uni-detail-label">Nonce</span>
              <input className="uni-detail-input" value={adv.nonce} onChange={setAdvField('nonce')} />
            </div>
          </details>

          {err && <div className="uni-err">{err}</div>}

          <SwapButton />
          {orderStatus && <div className={`status ${orderStatus.cls}`}>{orderStatus.msg}</div>}
        </div>
      </div>

      {/* Active orders */}
      {orders.length > 0 && (
        <div className="card" style={{ maxWidth: 464, margin: '20px auto 0' }}>
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Your Cross-Chain Orders</h2>
            <button className="ghost sm" onClick={fetchOrders}>↻ Refresh</button>
          </div>
          {anyPending && (
            <div className="status info" style={{ marginBottom: 12, fontSize: '0.78rem' }}>
              Keep this tab and the backend running — secrets are auto-revealed when fillers lock on Chain B.
            </div>
          )}
          {orders.map(o => (
            <CCOrderCard key={o.orderHash} order={o} inputTokens={inputTokens} outputTokens={outputTokens} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Token pill ───────────────────────────────────────────────────────────────
function CCTokenPill({ tokens, value, onChange }: { tokens: CCTokenInfo[]; value: string; onChange: (s: string) => void }) {
  return (
    <div className="uni-token-pill">
      <select value={value} onChange={e => onChange(e.target.value)}>
        {tokens.map(t => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
      </select>
      <span className="uni-pill-arrow">▾</span>
    </div>
  )
}

// ── Order card — slot/HTLC details hidden behind a toggle ────────────────────
function CCOrderCard({ order, inputTokens, outputTokens }: {
  order: CCOrder; inputTokens: CCTokenInfo[]; outputTokens: CCTokenInfo[]
}) {
  const [open, setOpen] = useState(false)
  const inT  = inputTokens.find(t => t.address.toLowerCase() === order.inputToken.toLowerCase())
  const outT = outputTokens.find(t => t.address.toLowerCase() === order.outputToken.toLowerCase())
  const done = order.slots.filter(s => s.status === 'done' || s.status === 'claimed').length
  const pct  = order.numSlots > 0 ? Math.min(100, (done / order.numSlots) * 100) : 0
  const status = done === order.numSlots ? 'filled' : order.slots.some(s => s.status !== 'available') ? 'active' : 'pending'

  return (
    <div className="slot-card" style={{ marginTop: 0, marginBottom: 10 }}>
      <div className="flex-between">
        <span style={{ fontSize: '0.85rem' }}>
          {fromWei(BigInt(order.inputAmount), inT?.decimals ?? 18)} <strong>{inT?.symbol ?? '?'}</strong>
          <span className="uni-arrow"> → </span>
          min {fromWei(BigInt(order.minOutput), outT?.decimals ?? 18)} <strong>{outT?.symbol ?? '?'}</strong>
        </span>
        <span className={`uni-status ${status}`}>{status}</span>
      </div>

      <div className="uni-fill-track" style={{ marginTop: 10 }}>
        <div className="uni-fill-bar" style={{ width: `${pct}%` }} />
      </div>

      <div className="flex-between" style={{ marginTop: 8 }}>
        <span className="text-muted">{done}/{order.numSlots} slots done · <code>{short(order.orderHash)}</code></span>
        <button className="ghost sm" onClick={() => setOpen(o => !o)}>{open ? '▲ hide' : '▾ details'}</button>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          <div className="text-muted" style={{ marginBottom: 6 }}>T2 expiry: block {order.t2Expiry} · deadline: block {order.deadline}</div>
          {order.slots.map(slot => (
            <div key={slot.index} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: '0.78rem' }}>
              <span className={`tag ${slot.status === 'locked' ? 'locked' : (slot.status === 'claimed' || slot.status === 'done') ? 'claimed' : 'available'}`}>
                {slot.status}
              </span>
              <span>Slot {slot.index}</span>
              {slot.escrowAddr && <code style={{ marginLeft: 'auto' }}>{short(slot.escrowAddr)}</code>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
