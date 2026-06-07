import { useState } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'

const PERMIT2_ABI = [
  'function allowance(address,address,address) view returns (uint160,uint48,uint48)',
  'function approve(address,address,uint160,uint48)',
]
const ERC20_ABI = [
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]

const PERMIT2_ADDR = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

export default function DutchAuction({ wallet }: { wallet: WalletState }) {
  const [backend,  setBackend]  = useState('http://localhost:3000')
  const [reactor,  setReactor]  = useState('')

  // Permit2
  const [p2Token,  setP2Token]  = useState('')
  const [p2Status, setP2Status] = useState<{ msg: string; cls: string } | null>(null)

  // Order form
  const [form, setForm] = useState({
    inputToken: '', inputAmount: '', outputToken: '', minOutput: '',
    deadline: String(wallet.blockNumber + 100), nonce: '1',
    minFillBps: '1000', feeTier: '500', startPrice: '', decayPerBlock: '0',
  })
  const [orderStatus, setOrderStatus] = useState<{ msg: string; cls: string } | null>(null)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  // ── Permit2 ────────────────────────────────────────────────────────────────
  async function checkPermit2() {
    if (!wallet.provider || !wallet.account) return setP2Status({ msg: 'Connect wallet first', cls: 'bad' })
    try {
      const erc20 = new ethers.Contract(p2Token, ERC20_ABI, wallet.provider)
      const p2    = new ethers.Contract(PERMIT2_ADDR, PERMIT2_ABI, wallet.provider)
      const erc20Allow            = await erc20.allowance(wallet.account, PERMIT2_ADDR)
      const [p2Amount, p2Expiry]  = await p2.allowance(wallet.account, p2Token, reactor)
      const erc20Ok = erc20Allow.gte(ethers.utils.parseUnits('1000000', 18))
      const p2Ok    = p2Amount.gt(0) && Number(p2Expiry) > Math.floor(Date.now() / 1000)
      setP2Status({
        msg: `ERC-20 → Permit2 : ${erc20Ok ? '✓ approved' : '✗ needs approval'}\nPermit2 → Reactor : ${p2Ok ? '✓ approved' : '✗ needs approval'}`,
        cls: erc20Ok && p2Ok ? 'ok' : 'bad',
      })
    } catch (e: any) { setP2Status({ msg: e.message, cls: 'bad' }) }
  }

  async function approveERC20() {
    if (!wallet.signer) return
    setP2Status({ msg: 'Waiting for ERC-20 approval tx...', cls: 'info' })
    const erc20 = new ethers.Contract(p2Token, ERC20_ABI, wallet.signer)
    await (await erc20.approve(PERMIT2_ADDR, ethers.constants.MaxUint256)).wait()
    checkPermit2()
  }

  async function approvePermit2() {
    if (!wallet.signer) return
    setP2Status({ msg: 'Waiting for Permit2 approval tx...', cls: 'info' })
    const p2 = new ethers.Contract(PERMIT2_ADDR, PERMIT2_ABI, wallet.signer)
    const MAX160 = ethers.BigNumber.from('0xffffffffffffffffffffffffffffffff')
    const MAX48  = ethers.BigNumber.from('0xffffffffffff')
    await (await p2.approve(p2Token, reactor, MAX160, MAX48)).wait()
    checkPermit2()
  }

  // ── Submit order ───────────────────────────────────────────────────────────
  async function submitOrder() {
    if (!wallet.signer) return setOrderStatus({ msg: 'Connect wallet first', cls: 'bad' })
    if (!reactor)       return setOrderStatus({ msg: 'Reactor address required', cls: 'bad' })

    const order = {
      swapper: wallet.account, inputToken: form.inputToken, inputAmount: form.inputAmount,
      outputToken: form.outputToken, minOutputAmount: form.minOutput,
      deadline: parseInt(form.deadline), nonce: parseInt(form.nonce),
      minFillBps: parseInt(form.minFillBps), startPrice: form.startPrice,
      decayPerBlock: parseInt(form.decayPerBlock), feeTier: parseInt(form.feeTier),
    }

    setOrderStatus({ msg: 'Waiting for signature...', cls: 'info' })
    try {
      const sig = await (wallet.signer as ethers.providers.JsonRpcSigner)._signTypedData(
        { name: 'NeutronX', chainId: 31337, verifyingContract: reactor },
        { PartialFillOrder: [
            { name: 'swapper', type: 'address' }, { name: 'inputToken', type: 'address' },
            { name: 'inputAmount', type: 'uint256' }, { name: 'outputToken', type: 'address' },
            { name: 'minOutputAmount', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
            { name: 'nonce', type: 'uint256' }, { name: 'minFillBps', type: 'uint16' },
          ]},
        { swapper: order.swapper, inputToken: order.inputToken, inputAmount: order.inputAmount,
          outputToken: order.outputToken, minOutputAmount: order.minOutputAmount,
          deadline: order.deadline, nonce: order.nonce, minFillBps: order.minFillBps }
      )
      setOrderStatus({ msg: 'Submitting to backend...', cls: 'info' })
      const res  = await fetch(`${backend}/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order, signature: sig }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Backend error')
      setOrderStatus({ msg: `Order submitted!\nHash: ${data.orderHash}\nStatus: ${data.status}`, cls: 'ok' })
    } catch (e: any) {
      setOrderStatus({ msg: e.message, cls: 'bad' })
    }
  }

  return (
    <>
      <h2>Config</h2>
      <label>Backend URL</label>
      <input value={backend} onChange={e => setBackend(e.target.value)} />
      <div className="row">
        <div>
          <label>PartialFillReactor Address</label>
          <input value={reactor} onChange={e => setReactor(e.target.value)} placeholder="0x..." />
        </div>
        <div>
          <label>Permit2 (read-only)</label>
          <input value={PERMIT2_ADDR} readOnly style={{ opacity: 0.5 }} />
        </div>
      </div>

      <hr />
      <h2>Permit2 Setup</h2>
      <p className="sub">Two one-time approvals: (a) ERC-20 → Permit2, (b) Permit2 → Reactor</p>
      <label>Token to approve</label>
      <input value={p2Token} onChange={e => setP2Token(e.target.value)} placeholder="0x..." />
      <button onClick={checkPermit2}>Check Allowances</button>
      {p2Status && <div className={`status ${p2Status.cls}`}>{p2Status.msg}</div>}
      <br />
      <button className="sm" onClick={approveERC20}>① Approve ERC-20 → Permit2</button>
      <button className="sm" onClick={approvePermit2} style={{ marginLeft: 8 }}>② Approve Permit2 → Reactor</button>

      <hr />
      <h2>Submit Order</h2>
      <div className="row">
        <div><label>Input Token</label><input value={form.inputToken}  onChange={set('inputToken')}  placeholder="0x..." /></div>
        <div><label>Input Amount (wei)</label><input value={form.inputAmount} onChange={set('inputAmount')} placeholder="e.g. 4000000000000000000" /></div>
      </div>
      <div className="row">
        <div><label>Output Token</label><input value={form.outputToken} onChange={set('outputToken')} placeholder="0x..." /></div>
        <div><label>Min Output (wei)</label><input value={form.minOutput}   onChange={set('minOutput')}   placeholder="e.g. 9500000000" /></div>
      </div>
      <div className="row">
        <div><label>Deadline (block)</label><input value={form.deadline}     onChange={set('deadline')} /></div>
        <div><label>Nonce</label><input value={form.nonce}         onChange={set('nonce')} /></div>
      </div>
      <div className="row">
        <div><label>Min Fill Bps (1000 = 10%)</label><input value={form.minFillBps} onChange={set('minFillBps')} /></div>
        <div><label>Fee Tier (500/3000/10000)</label><input value={form.feeTier}    onChange={set('feeTier')} /></div>
      </div>
      <div className="row">
        <div><label>Start Price (scaled 1e18)</label><input value={form.startPrice} onChange={set('startPrice')} /></div>
        <div><label>Decay Per Block</label><input value={form.decayPerBlock} onChange={set('decayPerBlock')} /></div>
      </div>
      <button onClick={submitOrder}>Sign &amp; Submit Order</button>
      {orderStatus && <div className={`status ${orderStatus.cls}`}>{orderStatus.msg}</div>}
    </>
  )
}
