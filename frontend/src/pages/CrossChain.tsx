import { useState, useEffect, useRef } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'

const CC_REACTOR_ABI = [
  'function createOrder(tuple(address swapper,address inputToken,uint256 inputAmount,address outputToken,uint256 minOutput,uint256 deadline,uint256 nonce,bytes32 merkleRoot,uint8 numSlots) info, bytes cosignerSig) external returns (bytes32)',
]

interface Slot {
  index:          number
  hashlock:       string
  proof:          string[]
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
  merkleRoot:  string
  cosignerSig: string
  t2Expiry:    number
  slots:       Slot[]
}

export default function CrossChain({ wallet }: { wallet: WalletState }) {
  const { backendUrl, crossChainReactor, chainId } = useAppConfig()

  const [cosignerAddr, setCosignerAddr] = useState('')
  const [sessionStatus, setSessionStatus] = useState<{ msg: string; cls: string } | null>(null)

  const [form, setForm] = useState({
    inputToken: '', inputAmount: '', outputToken: '', minOutput: '',
    deadline: String(wallet.blockNumber + 200), nonce: '1', t2Buffer: '50',
  })
  const [orderStatus, setOrderStatus] = useState<{ msg: string; cls: string } | null>(null)
  const [orders,  setOrders]  = useState<CCOrder[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  useEffect(() => {
    if (wallet.account) restoreSession()
  }, [wallet.account])

  async function initSession() {
    if (!wallet.account) return setSessionStatus({ msg: 'Connect wallet first', cls: 'bad' })
    setSessionStatus({ msg: 'Creating session…', cls: 'info' })
    try {
      const res  = await fetch(`${backendUrl}/cc/session`, {
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
      const res  = await fetch(`${backendUrl}/cc/session/${wallet.account}`)
      if (!res.ok) return
      const data = await res.json()
      setCosignerAddr(data.cosignerAddr)
      setOrders(data.orders ?? [])
    } catch { }
  }

  async function fetchOrders() {
    if (!wallet.account) return
    try {
      const res  = await fetch(`${backendUrl}/cc/session/${wallet.account}`)
      if (!res.ok) return
      const data = await res.json()
      setOrders(data.orders ?? [])
    } catch {}
  }

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

  async function createOrder() {
    if (!wallet.signer) return setOrderStatus({ msg: 'Connect wallet first', cls: 'bad' })
    if (!cosignerAddr)  return setOrderStatus({ msg: 'Init session first', cls: 'bad' })
    if (!crossChainReactor) return setOrderStatus({ msg: 'CrossChainReactor not configured — go to Admin → Config', cls: 'bad' })

    setOrderStatus({ msg: 'Requesting Merkle tree from backend…', cls: 'info' })
    try {
      const inputToken  = ethers.utils.getAddress(form.inputToken.trim())
      const outputToken = ethers.utils.getAddress(form.outputToken.trim())

      const res  = await fetch(`${backendUrl}/cc/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          swapper: wallet.account,
          inputToken,  inputAmount: form.inputAmount,
          outputToken, minOutput:   form.minOutput,
          deadline: parseInt(form.deadline), nonce: form.nonce,
          chainAId: parseInt(chainId), reactorAddr: crossChainReactor,
          t2Buffer: parseInt(form.t2Buffer),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setOrderStatus({ msg: `Merkle tree ready. Sending createOrder() tx…`, cls: 'info' })

      const reactor = new ethers.Contract(crossChainReactor, CC_REACTOR_ABI, wallet.signer)
      const tx = await reactor.createOrder(
        {
          swapper:     wallet.account,
          inputToken,  inputAmount: form.inputAmount,
          outputToken, minOutput:   form.minOutput,
          deadline:    parseInt(form.deadline), nonce: form.nonce,
          merkleRoot:  data.merkleRoot,   numSlots:    data.numSlots,
        },
        data.cosignerSig
      )
      await tx.wait()

      setOrderStatus({
        msg: `✔ Order created!\nHash:       ${data.orderHash}\nMerkle root: ${data.merkleRoot}\nSlots: ${data.numSlots}\nTx: ${tx.hash}`,
        cls: 'ok',
      })
      await fetchOrders()
    } catch (e: any) {
      setOrderStatus({ msg: e.reason ?? e.message, cls: 'bad' })
    }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">Cross-Chain Swap</div>
        <div className="page-sub">HTLC-based cross-chain fills via Merkle-tree slot allocation</div>
      </div>

      {!crossChainReactor && (
        <div className="status warn" style={{ marginBottom: 20 }}>
          ⚠ CrossChainReactor address not set. Go to <strong>Admin → Config</strong> after running <code>setup_cc.sh</code>.
        </div>
      )}

      {crossChainReactor && (
        <div className="status ok" style={{ marginBottom: 20, fontSize: '0.75rem' }}>
          Reactor: <code>{crossChainReactor}</code> &nbsp;|&nbsp; Chain ID: <code>{chainId}</code>
        </div>
      )}

      {/* Session */}
      <div className="card">
        <h2>CC-0 — Session</h2>
        <p className="sub">
          The backend generates a root secret for your wallet and stores it securely.
          All slot secrets are derived from it — the backend auto-claims on Chain B when a filler locks.
        </p>
        <button onClick={initSession}>Init / Restore Session</button>
        {cosignerAddr && (
          <p style={{ marginTop: 8, fontSize: '0.78rem', color: '#64748b' }}>
            Cosigner: <code>{cosignerAddr}</code>
          </p>
        )}
        {sessionStatus && <div className={`status ${sessionStatus.cls}`}>{sessionStatus.msg}</div>}
      </div>

      {/* Create order */}
      <div className="card">
        <h2>CC-1 — Create Order</h2>
        <p className="sub">Backend builds the Merkle tree and cosigns. You pay gas on Chain A via MetaMask.</p>
        <div className="row">
          <div><label>Input Token (Chain A, e.g. WETH)</label><input value={form.inputToken}  onChange={set('inputToken')}  placeholder="0x…" /></div>
          <div><label>Input Amount (wei)</label><input value={form.inputAmount} onChange={set('inputAmount')} placeholder="4000000000000000000" /></div>
        </div>
        <div className="row">
          <div><label>Output Token (Chain B, e.g. USDC)</label><input value={form.outputToken} onChange={set('outputToken')} placeholder="0x…" /></div>
          <div><label>Min Output Total (wei)</label><input value={form.minOutput}   onChange={set('minOutput')}   placeholder="9800000000" /></div>
        </div>
        <div className="row">
          <div><label>Deadline (Chain A block, T1)</label><input value={form.deadline} onChange={set('deadline')} /></div>
          <div><label>T2 Buffer (blocks)</label><input value={form.t2Buffer} onChange={set('t2Buffer')} className="short" /></div>
          <div><label>Nonce</label><input value={form.nonce} onChange={set('nonce')} className="short" /></div>
        </div>
        <button onClick={createOrder} disabled={!cosignerAddr}>Build Tree &amp; Create Order</button>
        {orderStatus && <div className={`status ${orderStatus.cls}`}>{orderStatus.msg}</div>}
      </div>

      {/* Slot monitor */}
      <div className="card">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>CC-2 — Active Orders &amp; Slots</h2>
          <button className="ghost sm" onClick={fetchOrders}>↻ Refresh</button>
        </div>

        {orders.some(o => o.slots.some(s => s.status !== 'claimed' && s.status !== 'refunded')) && (
          <div className="status bad" style={{ marginBottom: 12 }}>
            ⚠ Keep this tab and the backend running while your order is active.
            The backend watcher auto-reveals secrets when fillers lock on Chain B.
          </div>
        )}

        <p className="sub">Slot statuses update every 4s. Give hashlocks to fillers — they computeAddress + transfer + factory.deploy() on Chain B.</p>

        {orders.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px 0' }}>
            <div className="empty-icon">📦</div>
            No active orders
          </div>
        ) : (
          orders.map(order => <OrderCard key={order.orderHash} order={order} />)
        )}
      </div>
    </>
  )
}

function OrderCard({ order }: { order: CCOrder }) {
  const [open, setOpen] = useState(true)
  const filled  = order.slots.filter(s => s.status === 'claimed').length
  const minPer  = (BigInt(order.minOutput) / BigInt(order.numSlots)).toString()

  return (
    <div style={{ marginTop: 12, border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#f8fafc' }}>
        <span style={{ fontSize: '0.82rem' }}>
          <strong>Order</strong> <code>{order.orderHash.slice(0, 12)}…</code>
          &nbsp;
          <span className={`badge ${filled === order.numSlots ? 'filled' : 'active'}`}>
            {filled}/{order.numSlots} slots filled
          </span>
        </span>
        <button className="ghost sm" onClick={() => setOpen(o => !o)}>
          {open ? '▲ hide' : '▼ show'}
        </button>
      </div>

      {open && (
        <div style={{ padding: '12px 14px' }}>
          <p style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: 10 }}>
            inputAmount: <code>{order.inputAmount}</code> &nbsp;|&nbsp;
            deadline: <code>{order.deadline}</code> &nbsp;|&nbsp;
            T2 expiry: <code>{order.t2Expiry}</code>
          </p>
          {order.slots.map(slot => (
            <div key={slot.index} className={`slot-card ${slot.status}`}>
              <span className={`tag ${slot.status === 'locked' ? 'locked' : slot.status === 'claimed' ? 'claimed' : 'available'}`}>
                {slot.status}
              </span>
              &nbsp;<strong>Slot {slot.index}</strong>
              <br />
              <span style={{ color: '#64748b' }}>hashlock (H_i):</span>{' '}
              <code>{slot.hashlock}</code>
              <br />
              <span style={{ color: '#64748b' }}>minAmount:</span> <code>{minPer}</code>
              &nbsp;&nbsp;
              <span style={{ color: '#64748b' }}>expiry:</span> <code>block {order.t2Expiry}</code>
              {slot.escrowAddr && (
                <>
                  <br /><span style={{ color: '#64748b' }}>escrow (Chain B):</span> <code>{slot.escrowAddr}</code>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
