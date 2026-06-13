import { useState, useEffect, useCallback } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'
import { HashRow } from '../components/CrossChainOrders'

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const P2_ABI  = ['function allowance(address,address,address) view returns (uint160,uint48,uint48)', 'function approve(address,address,uint160,uint48)']
const ERC_ABI = ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']

function toWei(val: string, dec: number): bigint {
  try { return ethers.utils.parseUnits(val || '0', dec).toBigInt() } catch { return 0n }
}
function short(addr: string) { return addr ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : '—' }

interface CCTokenInfo { symbol: string; address: string; decimals: number; chainId: number }

type Step = 'idle' | 'checking' | 'erc20' | 'p2' | 'ready' | 'busy'

export default function CrossChain({ wallet }: { wallet: WalletState }) {
  const { backendUrl, crossChainReactor, chainId } = useAppConfig()

  const [allTokens, setAllTokens] = useState<CCTokenInfo[]>([])
  const [srcChain, setSrcChain] = useState(0)
  const [dstChain, setDstChain] = useState(0)
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

  const chains       = [...new Set(allTokens.map(t => t.chainId))].sort((a, b) => a - b)
  const inputTokens  = allTokens.filter(t => t.chainId === srcChain)
  const outputTokens = allTokens.filter(t => t.chainId === dstChain)
  const inT  = inputTokens.find(t => t.symbol === inKey)
  const outT = outputTokens.find(t => t.symbol === outKey)
  const inW  = inT  ? toWei(inAmt,  inT.decimals)  : 0n
  const outW = outT ? toWei(outAmt, outT.decimals) : 0n

  // Pick a source chain (must host the reactor) and a different destination chain.
  const chooseSrc = (c: number) => {
    setSrcChain(c); setStep('idle')
    if (c === dstChain) { const o = chains.find(x => x !== c); if (o !== undefined) setDstChain(o) }
  }
  const chooseDst = (c: number) => {
    setDstChain(c)
    if (c === srcChain) { const o = chains.find(x => x !== c); if (o !== undefined) setSrcChain(o) }
  }

  // ── token directory (every chain, straight from the DB) ──────────────────────
  useEffect(() => {
    fetch(`${backendUrl}/tokens?chainId=all`)
      .then(r => r.json())
      .then(data => {
        const toks: CCTokenInfo[] = data.tokens ?? []
        setAllTokens(toks)
        const cs = [...new Set(toks.map(t => t.chainId))].sort((a, b) => a - b)
        // Source must host the reactor (the configured Chain A); destination is another chain.
        const src = cs.includes(Number(chainId)) ? Number(chainId) : (cs[0] ?? 0)
        const dst = cs.find(c => c !== src) ?? src
        setSrcChain(src); setDstChain(dst)
        const fi = toks.find(t => t.chainId === src); if (fi) setInKey(fi.symbol)
        const fo = toks.find(t => t.chainId === dst); if (fo) setOutKey(fo.symbol)
      })
      .catch(() => {})
  }, [backendUrl, chainId])

  // Keep the selected token valid when its chain changes.
  useEffect(() => {
    if (inputTokens.length && !inputTokens.some(t => t.symbol === inKey)) setInKey(inputTokens[0].symbol)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcChain, allTokens])
  useEffect(() => {
    if (outputTokens.length && !outputTokens.some(t => t.symbol === outKey)) setOutKey(outputTokens[0].symbol)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dstChain, allTokens])

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
  // Submitted orders are listed on the Orders page (<CrossChainOrders/>); here we
  // only need the cosigner address for signing.
  const ensureSession = useCallback(async () => {
    if (!wallet.account) return
    try {
      const res = await fetch(`${backendUrl}/cc/session/${wallet.account}`)
      if (res.ok) { setCosignerAddr((await res.json()).cosignerAddr); return }
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

  // ── submit ───────────────────────────────────────────────────────────────────
  async function doSwap() {
    if (!wallet.signer || !crossChainReactor || !inT || !outT) return
    if (!cosignerAddr) { setErr('Session is still being set up — try again in a moment.'); return }
    if (srcChain !== Number(chainId)) {
      setErr(`Source must be ${chainLabel(Number(chainId))} — the chain hosting the cross-chain reactor. Settlement locks funds there.`)
      return
    }
    if (srcChain === dstChain) { setErr('Source and destination must be different chains.'); return }

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
          chainAId: srcChain, reactorAddr: crossChainReactor,
          t2Buffer: parseInt(adv.t2Buffer || '50'),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      // Sign the order with the swapper's wallet (EIP-712) — no on-chain tx.
      // EscrowSrcFactory registers the order lazily on the first fillSlot()
      // call by a filler, which requires both this signature and cosignerSig.
      setMsg('Sign order in wallet…')
      const domain = { name: 'NeutronX CrossChain', chainId: srcChain, verifyingContract: crossChainReactor }
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

      setOrderStatus({ msg: `✔ Order signed — ${data.numSlots} slots, ready for fillers · ${short(data.orderHash)} · track it on the Orders page`, cls: 'ok' })
      setInAmt(''); setOutAmt('')
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
      </div>

      {!crossChainReactor && (
        <div className="status warn" style={{ maxWidth: 464, margin: '0 auto 16px' }}>
          ⚠ Cross-chain swap is not configured yet.
        </div>
      )}

      <div className="uni-page">
        <div className="uni-card">
          <div className="uni-header">
            <span className="uni-title">Swap</span>
            <button className="uni-info-btn" title="Session &amp; contract details" onClick={() => setShowInfo(s => !s)}>ⓘ</button>
          </div>

          {showInfo && (
            <div className="uni-info-panel">
              <HashRow label="Reactor" value={crossChainReactor} accent />
              <HashRow label="Cosigner" value={cosignerAddr} />
            </div>
          )}

          {/* Send box — source chain + token */}
          <div className="uni-input-box">
            <div className="uni-input-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>You send</span>
              <ChainPill chains={chains} value={srcChain} onChange={chooseSrc} />
            </div>
            <div className="uni-input-row">
              <input className="uni-amount" type="number" placeholder="0" value={inAmt}
                onChange={e => setInAmt(e.target.value)} />
              <CCTokenPill tokens={inputTokens} value={inKey}
                onChange={k => { setInKey(k); setStep('idle') }} />
            </div>
          </div>

          <div className="uni-flip-wrap">
            <div className="uni-flip" style={{ cursor: 'default' }} title={`${chainLabel(srcChain)} → ${chainLabel(dstChain)}`}>↓</div>
          </div>

          {/* Receive box — destination chain + token */}
          <div className="uni-input-box">
            <div className="uni-input-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>You receive <span className="uni-label-muted">(minimum)</span></span>
              <ChainPill chains={chains} value={dstChain} onChange={chooseDst} />
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
    </div>
  )
}

// ── Chain selector ─────────────────────────────────────────────────────────
const CHAIN_NAMES: Record<number, string> = { 31337: 'Chain A', 31338: 'Chain B' }
function chainLabel(id: number) {
  if (!id) return '—'
  return CHAIN_NAMES[id] ? `${CHAIN_NAMES[id]} · ${id}` : `Chain ${id}`
}

function ChainPill({ chains, value, onChange }: { chains: number[]; value: number; onChange: (c: number) => void }) {
  return (
    <div className="uni-token-pill" style={{ background: '#eef2ff' }}>
      <select value={value} onChange={e => onChange(Number(e.target.value))}>
        {chains.map(c => <option key={c} value={c}>{chainLabel(c)}</option>)}
      </select>
      <span className="uni-pill-arrow">▾</span>
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

