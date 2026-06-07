import { useState, useEffect, useRef } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'

const CC_REACTOR_ABI = [
  'function createOrder(tuple(address swapper,address inputToken,uint256 inputAmount,address outputToken,uint256 minOutput,uint256 deadline,uint256 nonce,bytes32 merkleRoot,uint8 numSlots) info, bytes cosignerSig) external returns (bytes32)',
]

interface Slot {
  index:          number
  hashlock:       string
  proof:          string[]
  status:         string
  assignedFiller: string | null
  escrowAddr:     string | null   // deployed EscrowDst clone on Chain B
}

interface CCOrder {
  orderHash:   string
  inputToken:  string
  inputAmount: string
  outputToken: string
  minOutput:   string
  deadline:    number
  numSlots:    number
  merkleRoot:  string
  cosignerSig: string
  t2Expiry:    number
  slots:       Slot[]
}

export default function CrossChain({ wallet }: { wallet: WalletState }) {
  const [backend,    setBackend]    = useState('http://localhost:3000')
  const [reactorAddr, setReactorAddr] = useState('')
  const [chainAId,   setChainAId]   = useState('31337')

  // Session
  const [cosignerAddr, setCosignerAddr] = useState('')
  const [sessionStatus, setSessionStatus] = useState<{ msg: string; cls: string } | null>(null)

  // Order form
  const [form, setForm] = useState({
    inputToken: '', inputAmount: '', outputToken: '', minOutput: '',
    deadline: String(wallet.blockNumber + 200), nonce: '1', t2Buffer: '50',
  })
  const [orderStatus, setOrderStatus] = useState<{ msg: string; cls: string } | null>(null)

  // Active orders (fetched from backend)
  const [orders,  setOrders]  = useState<CCOrder[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  // ── Session ────────────────────────────────────────────────────────────────
  // On connect, try to restore session automatically
  useEffect(() => {
    if (wallet.account) restoreSession()
  }, [wallet.account])

  async function initSession() {
    if (!wallet.account) return setSessionStatus({ msg: 'Connect wallet first', cls: 'bad' })
    setSessionStatus({ msg: 'Creating session...', cls: 'info' })
    try {
      const res  = await fetch(`${backend}/cc/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ swapper: wallet.account }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setCosignerAddr(data.cosignerAddr)
      setSessionStatus({
        msg: `Session ${data.isNew ? 'created' : 'restored'}.\nCosigner: ${data.cosignerAddr}\n\n` +
             `Deploy CrossChainReactor with cosigner = ${data.cosignerAddr}\n` +
             `Fund ${data.cosignerAddr} with ETH on Chain B for claim() gas.`,
        cls: 'ok',
      })
      await fetchOrders()
    } catch (e: any) { setSessionStatus({ msg: e.message, cls: 'bad' }) }
  }

  async function restoreSession() {
    try {
      const res  = await fetch(`${backend}/cc/session/${wallet.account}`)
      if (!res.ok) return
      const data = await res.json()
      setCosignerAddr(data.cosignerAddr)
      setOrders(data.orders ?? [])
    } catch { /* ignore — no session yet */ }
  }

  async function fetchOrders() {
    if (!wallet.account) return
    try {
      const res  = await fetch(`${backend}/cc/session/${wallet.account}`)
      if (!res.ok) return
      const data = await res.json()
      setOrders(data.orders ?? [])
    } catch {}
  }

  // Poll order statuses every 4 seconds when we have active orders
  useEffect(() => {
    if (orders.length > 0 && !pollRef.current) {
      pollRef.current = setInterval(fetchOrders, 4000)
    }
    if (orders.length === 0 && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [orders.length, wallet.account])

  // ── Create order ───────────────────────────────────────────────────────────
  async function createOrder() {
    if (!wallet.signer) return setOrderStatus({ msg: 'Connect wallet first', cls: 'bad' })
    if (!cosignerAddr)  return setOrderStatus({ msg: 'Init session first', cls: 'bad' })
    if (!reactorAddr)   return setOrderStatus({ msg: 'CrossChainReactor address required', cls: 'bad' })

    setOrderStatus({ msg: 'Requesting Merkle tree from backend...', cls: 'info' })
    try {
      // 1. Backend builds tree, cosigns, persists
      const res  = await fetch(`${backend}/cc/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          swapper: wallet.account,
          inputToken:  form.inputToken,  inputAmount: form.inputAmount,
          outputToken: form.outputToken, minOutput:   form.minOutput,
          deadline: parseInt(form.deadline), nonce: form.nonce,
          chainAId: parseInt(chainAId), reactorAddr, t2Buffer: parseInt(form.t2Buffer),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setOrderStatus({ msg: `Merkle tree ready. Sending createOrder() tx...`, cls: 'info' })

      // 2. Frontend calls CrossChainReactor.createOrder() — MetaMask signs & pays gas
      const reactor = new ethers.Contract(reactorAddr, CC_REACTOR_ABI, wallet.signer)
      const tx = await reactor.createOrder(
        {
          swapper:     wallet.account,
          inputToken:  form.inputToken,   inputAmount: form.inputAmount,
          outputToken: form.outputToken,  minOutput:   form.minOutput,
          deadline:    parseInt(form.deadline), nonce: form.nonce,
          merkleRoot:  data.merkleRoot,   numSlots:    data.numSlots,
        },
        data.cosignerSig
      )
      await tx.wait()

      setOrderStatus({
        msg: `✔ Order created!\nHash:      ${data.orderHash}\nMerkle root: ${data.merkleRoot}\nSlots: ${data.numSlots}\nTx: ${tx.hash}`,
        cls: 'ok',
      })
      await fetchOrders()
    } catch (e: any) {
      setOrderStatus({ msg: e.reason ?? e.message, cls: 'bad' })
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Config */}
      <h2 className="green">Config</h2>
      <label>Backend URL</label>
      <input value={backend} onChange={e => setBackend(e.target.value)} />
      <div className="row">
        <div>
          <label>CrossChainReactor (Chain A)</label>
          <input value={reactorAddr} onChange={e => setReactorAddr(e.target.value)} placeholder="0x..." />
        </div>
        <div>
          <label>Chain A ID</label>
          <input value={chainAId} onChange={e => setChainAId(e.target.value)} className="short" />
        </div>
      </div>

      {/* Session */}
      <hr />
      <h2 className="green">CC-0 — Session</h2>
      <p className="sub">
        The backend generates a root secret for your wallet and stores it securely.
        All slot secrets are derived from it on demand — the backend handles claim() on Chain B automatically.
      </p>
      <button onClick={initSession}>Init / Restore Session</button>
      {cosignerAddr && (
        <p style={{ marginTop: 8, fontSize: '0.8em', color: '#6b7280' }}>
          Cosigner: <code>{cosignerAddr}</code>
        </p>
      )}
      {sessionStatus && <div className={`status ${sessionStatus.cls}`}>{sessionStatus.msg}</div>}

      {/* Create order */}
      <hr />
      <h2 className="green">CC-1 — Create Order</h2>
      <p className="sub">Backend builds the Merkle tree and cosigns. You pay gas on Chain A via MetaMask.</p>
      <div className="row">
        <div><label>Input Token (Chain A, e.g. WETH)</label><input value={form.inputToken}  onChange={set('inputToken')}  placeholder="0x..." /></div>
        <div><label>Input Amount (wei)</label><input value={form.inputAmount} onChange={set('inputAmount')} placeholder="4000000000000000000" /></div>
      </div>
      <div className="row">
        <div><label>Output Token (Chain B, e.g. USDC)</label><input value={form.outputToken} onChange={set('outputToken')} placeholder="0x..." /></div>
        <div><label>Min Output Total (wei)</label><input value={form.minOutput}   onChange={set('minOutput')}   placeholder="9800000000" /></div>
      </div>
      <div className="row">
        <div><label>Deadline (Chain A block, T1)</label><input value={form.deadline} onChange={set('deadline')} /></div>
        <div><label>T2 Buffer (blocks)</label><input value={form.t2Buffer} onChange={set('t2Buffer')} className="short" /></div>
        <div><label>Nonce</label><input value={form.nonce} onChange={set('nonce')} className="short" /></div>
      </div>
      <button onClick={createOrder} disabled={!cosignerAddr}>Build Tree &amp; Create Order</button>
      {orderStatus && <div className={`status ${orderStatus.cls}`}>{orderStatus.msg}</div>}

      {/* Slot monitor */}
      <hr />
      <h2 className="green">CC-2 — Orders &amp; Slots</h2>

      {/* Liveness warning — shown only when there are active (non-fully-claimed) orders */}
      {orders.some(o => o.slots.some(s => s.status !== 'claimed' && s.status !== 'refunded')) && (
        <div className="status bad" style={{ marginBottom: 12 }}>
          ⚠ Keep this tab and the backend running while your order is active.<br />
          The backend watcher automatically reveals secrets when fillers lock on Chain B.
          If the backend goes offline, fillers who already locked tokens will be stuck
          until their T2 timeout expires — they cannot get their funds back sooner.
        </div>
      )}

      <p className="sub">
        Slot statuses update every 4 s. The backend watcher auto-claims on Chain B when a filler locks.
        Give slot hashlocks to fillers — they computeAddress + transfer + factory.deploy() on Chain B.
      </p>
      <button className="sm" onClick={fetchOrders}>Refresh</button>

      {orders.length === 0 ? (
        <div className="status info" style={{ marginTop: 12 }}>No orders yet.</div>
      ) : (
        orders.map(order => <OrderCard key={order.orderHash} order={order} />)
      )}
    </>
  )
}

function OrderCard({ order }: { order: CCOrder }) {
  const [open, setOpen] = useState(true)
  const filled  = order.slots.filter(s => s.status === 'claimed').length
  const minPer  = (BigInt(order.minOutput) / BigInt(order.numSlots)).toString()

  return (
    <div style={{ marginTop: 16, border: '1px solid #2d2d2d', borderRadius: 6, padding: '10px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.82em' }}>
          <strong>Order</strong> <code>{order.orderHash.slice(0,12)}…</code>
          &nbsp;{filled}/{order.numSlots} slots filled
        </span>
        <button className="sm" onClick={() => setOpen(o => !o)} style={{ marginTop: 0 }}>
          {open ? '▲ hide' : '▼ show'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: '0.78em', color: '#9ca3af', marginBottom: 8 }}>
            inputAmount: {order.inputAmount} &nbsp;|&nbsp; deadline block: {order.deadline} &nbsp;|&nbsp; T2 expiry: {order.t2Expiry}
          </p>
          {order.slots.map(slot => (
            <div key={slot.index} className={`slot-card ${slot.status}`}>
              <span className={`tag ${slot.status}`}>{slot.status}</span>
              &nbsp;<strong>Slot {slot.index}</strong>
              <br />
              <span style={{ color: '#9ca3af' }}>hashlock (H_i):</span>{' '}
              <code>{slot.hashlock}</code>
              <br />
              <span style={{ color: '#9ca3af' }}>lock params for filler:</span>
              <br />
              &nbsp;&nbsp;recipient: <code>{order.inputToken /* actually swapper addr — shown for reference */}</code>
              &nbsp;&nbsp;minAmount: <code>{minPer}</code>
              &nbsp;&nbsp;expiry: <code>block {order.t2Expiry}</code>
              {slot.escrowAddr && (
                <>
                  <br /><span style={{ color: '#9ca3af' }}>escrow (Chain B):</span> <code>{slot.escrowAddr}</code>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
