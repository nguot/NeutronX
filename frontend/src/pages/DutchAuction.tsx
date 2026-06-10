import { useState, useEffect, useCallback, useRef } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'

const TOKENS = {
  WETH: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  USDC: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6  },
  USDT: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6  },
  DAI:  { symbol: 'DAI',  address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
}
type TK = keyof typeof TOKENS

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const P2_ABI  = ['function allowance(address,address,address) view returns (uint160,uint48,uint48)', 'function approve(address,address,uint160,uint48)']
const ERC_ABI = ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']

function toWei(val: string, dec: number): bigint {
  try { return ethers.utils.parseUnits(val || '0', dec).toBigInt() } catch { return 0n }
}
function fromWei(wei: bigint, dec: number): string {
  return parseFloat(ethers.utils.formatUnits(wei.toString(), dec)).toLocaleString(undefined, { maximumFractionDigits: 6 })
}
// startPrice_contract = (outWei / inWei) * 1e18
function calcStartPrice(inWei: bigint, outWei: bigint): bigint {
  if (inWei === 0n) return 0n
  return (outWei * BigInt(1e18)) / inWei
}
// humanDecay (output/input per block) → contract decay
// contract units same as startPrice: decay_contract = humanDecay * 10^(outDec - inDec + 18) / 1e18
// simpler: decay_contract = (decayOutWei_per_inWei_per_block) * 1e18 / 1e18
// For USDC/WETH: humanDecay * 10^6 (per 1 input token)  → divide by 10^inDec then *1e18
function humanDecayToContract(humanDecay: number, inDec: number, outDec: number): bigint {
  // startPrice units = outWei / inWei * 1e18
  // For 1 human output/input drop per block: = 10^outDec / 10^inDec * 1e18
  const num = BigInt(Math.round(humanDecay * 1e6)) * BigInt(10 ** outDec) * BigInt(10 ** 12)
  const den = BigInt(10 ** inDec) * BigInt(1e6)
  return num / den
}
function contractToHumanPrice(price: bigint, inDec: number, outDec: number): number {
  // humanPrice = price / 1e18 * 10^inDec / 10^outDec
  return Number(price) / 1e18 * (10 ** inDec) / (10 ** outDec)
}

interface Fill { id: number; filler: string; fillAmount: string; blockNumber: number | null; createdAt: string }
interface ActiveOrder {
  hash: string; startBlock: number; deadline: number
  startPriceContract: bigint; decayContract: bigint
  inWei: bigint; outWei: bigint; inKey: TK; outKey: TK
  fills: Fill[]; status: string; curBlock: number
}

type Step = 'idle' | 'checking' | 'erc20' | 'p2' | 'ready' | 'busy'

export default function DutchAuction({ wallet }: { wallet: WalletState }) {
  const { backendUrl, partialFillReactor } = useAppConfig()

  const [inKey,  setInKey]  = useState<TK>('WETH')
  const [outKey, setOutKey] = useState<TK>('USDC')
  const [inAmt,  setInAmt]  = useState('')
  const [quoting, setQuoting] = useState(false)
  const [quote,   setQuote]   = useState<{ rate: string; impact: string | null; source: string } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [outAmt, setOutAmt] = useState('')
  const [decay,  setDecay]  = useState('0')        // human output/input per block
  const [step,   setStep]   = useState<Step>('idle')
  const [msg,    setMsg]    = useState('')
  const [err,    setErr]    = useState('')
  const [order,  setOrder]  = useState<ActiveOrder | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  const inT = TOKENS[inKey], outT = TOKENS[outKey]
  const inW = toWei(inAmt, inT.decimals), outW = toWei(outAmt, outT.decimals)

  // ── approvals ──────────────────────────────────────────────────────────────
  const checkApproval = useCallback(async () => {
    if (!wallet.provider || !wallet.account || !partialFillReactor) return
    setStep('checking')
    try {
      const erc = new ethers.Contract(inT.address, ERC_ABI, wallet.provider)
      const p2  = new ethers.Contract(PERMIT2, P2_ABI, wallet.provider)
      const ea  = await erc.allowance(wallet.account, PERMIT2)
      const [pa, pe] = await p2.allowance(wallet.account, inT.address, partialFillReactor)
      const eOk = ea.gte(ethers.utils.parseUnits('1000000', inT.decimals))
      const pOk = pa.gt(0) && Number(pe) > Date.now() / 1000
      setStep(!eOk ? 'erc20' : !pOk ? 'p2' : 'ready')
    } catch { setStep('idle') }
  }, [wallet.provider, wallet.account, partialFillReactor, inT.address])

  useEffect(() => { if (wallet.connected && partialFillReactor && !order) checkApproval() }, [wallet.connected, partialFillReactor, inKey, order])

  // ── auto-quote ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const amt = parseFloat(inAmt)
    if (!inAmt || isNaN(amt) || amt <= 0) { setQuote(null); setOutAmt(''); return }

    debounceRef.current = setTimeout(async () => {
      setQuoting(true)
      try {
        const params = new URLSearchParams({
          inputToken:    inT.address,
          outputToken:   outT.address,
          inputAmount:   toWei(inAmt, inT.decimals).toString(),
          inputDecimals: String(inT.decimals),
          outputDecimals:String(outT.decimals),
          inputSymbol:   inT.symbol,
          outputSymbol:  outT.symbol,
        })
        const res  = await fetch(`${backendUrl}/quote?${params}`)
        const data = await res.json()
        if (res.ok) {
          setOutAmt(data.estimatedOutputHuman)
          setQuote({ rate: data.marketRate, impact: data.priceImpact, source: data.source })
        } else {
          setQuote(null)
        }
      } catch { setQuote(null) }
      setQuoting(false)
    }, 500)
  }, [inAmt, inKey, outKey, backendUrl])

  async function doApproveERC20() {
    if (!wallet.signer) return
    setStep('busy'); setMsg('Approving…')
    try { await (await new ethers.Contract(inT.address, ERC_ABI, wallet.signer).approve(PERMIT2, ethers.constants.MaxUint256)).wait(); await checkApproval() }
    catch (e: any) { setErr(e.message); setStep('erc20') }
    setMsg('')
  }
  async function doApproveP2() {
    if (!wallet.signer) return
    setStep('busy'); setMsg('Approving Permit2…')
    try {
      const p2 = new ethers.Contract(PERMIT2, P2_ABI, wallet.signer)
      await (await p2.approve(inT.address, partialFillReactor, ethers.BigNumber.from('0xffffffffffffffffffffffffffffffff'), ethers.BigNumber.from('0xffffffffffff'))).wait()
      await checkApproval()
    } catch (e: any) { setErr(e.message); setStep('p2') }
    setMsg('')
  }

  // ── submit ─────────────────────────────────────────────────────────────────
  async function doSwap() {
    if (!wallet.signer || !partialFillReactor) return
    setErr(''); setStep('busy'); setMsg('Sign in wallet…')
    const deadline = wallet.blockNumber + 200
    const sp = calcStartPrice(inW, outW)
    const dp = humanDecayToContract(parseFloat(decay || '0'), inT.decimals, outT.decimals)
    const orderBody = {
      swapper: wallet.account, inputToken: inT.address, inputAmount: inW.toString(),
      outputToken: outT.address, minOutputAmount: outW.toString(),
      deadline, nonce: Date.now() % 1000000, minFillBps: 1000,
      startPrice: sp.toString(), decayPerBlock: dp.toString(), feeTier: 3000,
    }
    try {
      const sig = await (wallet.signer as ethers.providers.JsonRpcSigner)._signTypedData(
        { name: 'NeutronX', chainId: 31337, verifyingContract: partialFillReactor },
        { PartialFillOrder: [
          { name: 'swapper', type: 'address' }, { name: 'inputToken', type: 'address' },
          { name: 'inputAmount', type: 'uint256' }, { name: 'outputToken', type: 'address' },
          { name: 'minOutputAmount', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
          { name: 'nonce', type: 'uint256' }, { name: 'minFillBps', type: 'uint16' },
        ]},
        { swapper: orderBody.swapper, inputToken: orderBody.inputToken, inputAmount: orderBody.inputAmount,
          outputToken: orderBody.outputToken, minOutputAmount: orderBody.minOutputAmount,
          deadline: orderBody.deadline, nonce: orderBody.nonce, minFillBps: orderBody.minFillBps }
      )
      setMsg('Submitting…')
      const res  = await fetch(`${backendUrl}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: orderBody, signature: sig }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setOrder({ hash: data.orderHash, startBlock: wallet.blockNumber, deadline, startPriceContract: sp, decayContract: dp, inWei: inW, outWei: outW, inKey, outKey, fills: [], status: 'pending', curBlock: wallet.blockNumber })
    } catch (e: any) { setErr(e.message); setStep('ready') }
    setMsg('')
  }

  // ── poll active order ──────────────────────────────────────────────────────
  const doPoll = useCallback(async () => {
    if (!order) return
    try {
      const [or, br] = await Promise.all([fetch(`${backendUrl}/orders/${order.hash}`), fetch(`${backendUrl}/admin/blocks`)])
      const [od, bd] = await Promise.all([or.json(), br.json()])
      setOrder(p => p ? { ...p, fills: od.fills ?? p.fills, status: od.status ?? p.status, curBlock: bd.chainA ?? p.curBlock } : null)
    } catch {}
  }, [order?.hash, backendUrl])

  useEffect(() => {
    if (!order) { if (poll.current) { clearInterval(poll.current); poll.current = null } return }
    poll.current = setInterval(doPoll, 3000)
    return () => { if (poll.current) clearInterval(poll.current) }
  }, [!!order, doPoll])

  // ── render: active order ───────────────────────────────────────────────────
  if (order) {
    const inDec = TOKENS[order.inKey].decimals, outDec = TOKENS[order.outKey].decimals
    const filled = order.fills.reduce((s, f) => s + BigInt(f.fillAmount), 0n)
    const pct    = order.inWei > 0n ? Number(filled * 100n / order.inWei) : 0
    const curPrice = contractToHumanPrice(
      order.startPriceContract > order.decayContract * BigInt(Math.max(0, order.curBlock - order.startBlock))
        ? order.startPriceContract - order.decayContract * BigInt(Math.max(0, order.curBlock - order.startBlock))
        : 0n,
      inDec, outDec
    )

    return (
      <div className="uni-page">
        <div className="uni-card">
          {/* top bar */}
          <div className="uni-header">
            <button className="uni-back" onClick={() => { setOrder(null); setStep('idle') }}>←</button>
            <span className="uni-hash">{order.hash.slice(0, 8)}…{order.hash.slice(-6)}</span>
            <span className={`uni-status ${order.status}`}>{order.status}</span>
          </div>

          {/* summary */}
          <div className="uni-summary">
            <span className="uni-summary-amt">{fromWei(order.inWei, inDec)} <b>{TOKENS[order.inKey].symbol}</b></span>
            <span className="uni-arrow">→</span>
            <span className="uni-summary-amt out">min {fromWei(order.outWei, outDec)} <b>{TOKENS[order.outKey].symbol}</b></span>
          </div>

          {/* chart */}
          <AuctionChart order={order} inDec={inDec} outDec={outDec} curPrice={curPrice} />

          {/* fill bar */}
          <div className="uni-fill-section">
            <div className="uni-fill-label">
              <span>Filled</span>
              <span>{fromWei(filled, inDec)} / {fromWei(order.inWei, inDec)} {TOKENS[order.inKey].symbol} <strong>{pct.toFixed(0)}%</strong></span>
            </div>
            <div className="uni-fill-track">
              <div className="uni-fill-bar" style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </div>

          {/* fill list */}
          {order.fills.length === 0
            ? <p className="uni-waiting">Waiting for fillers…</p>
            : order.fills.map(f => (
              <div key={f.id} className="uni-fill-row">
                <span className="uni-fill-dot" />
                <span className="uni-fill-filler">{f.filler.slice(0, 8)}…{f.filler.slice(-4)}</span>
                <span className="uni-fill-info">{fromWei(BigInt(f.fillAmount), inDec)} {TOKENS[order.inKey].symbol}</span>
                <span className="uni-fill-block">{f.blockNumber ? `#${f.blockNumber}` : new Date(f.createdAt).toLocaleTimeString()}</span>
              </div>
            ))
          }
        </div>
      </div>
    )
  }

  // ── render: swap form ──────────────────────────────────────────────────────
  const canSwap = wallet.connected && !!partialFillReactor && inW > 0n && outW > 0n && step === 'ready'

  function SwapButton() {
    if (!wallet.connected)      return <button className="uni-btn" disabled>Connect wallet</button>
    if (!partialFillReactor)    return <button className="uni-btn" disabled>Reactor not configured</button>
    if (step === 'checking')    return <button className="uni-btn" disabled>Checking…</button>
    if (step === 'busy')        return <button className="uni-btn" disabled>{msg}</button>
    if (step === 'erc20')       return <button className="uni-btn" onClick={doApproveERC20}>Approve {inT.symbol}</button>
    if (step === 'p2')          return <button className="uni-btn" onClick={doApproveP2}>Enable spending</button>
    if (!canSwap)               return <button className="uni-btn" disabled>Enter amounts</button>
    return <button className="uni-btn active" onClick={doSwap}>Swap</button>
  }

  return (
    <div className="uni-page">
      <div className="uni-card">
        <div className="uni-header"><span className="uni-title">Swap</span></div>

        {/* Sell box */}
        <div className="uni-input-box">
          <div className="uni-input-label">You sell</div>
          <div className="uni-input-row">
            <input className="uni-amount" type="number" placeholder="0" value={inAmt}
              onChange={e => setInAmt(e.target.value)} />
            <TokenPill value={inKey} exclude={outKey}
              onChange={k => { setInKey(k); setStep('idle') }} />
          </div>
        </div>

        {/* Flip */}
        <div className="uni-flip-wrap">
          <button className="uni-flip" onClick={() => {
            setInKey(outKey); setOutKey(inKey)
            setInAmt(outAmt); setOutAmt(inAmt)
            setStep('idle')
          }}>↕</button>
        </div>

        {/* Buy box */}
        <div className="uni-input-box">
          <div className="uni-input-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>You receive <span className="uni-label-muted">(minimum)</span></span>
            {quoting && <span className="uni-quoting">fetching price…</span>}
            {!quoting && quote && (
              <span className="uni-quote-src">via {quote.source === 'alpha_router' ? 'Uniswap V3' : 'CoinGecko'}</span>
            )}
          </div>
          <div className="uni-input-row">
            <input className="uni-amount" type="number" placeholder="0" value={outAmt}
              onChange={e => { setOutAmt(e.target.value); setQuote(null) }} />
            <TokenPill value={outKey} exclude={inKey} onChange={k => { setOutKey(k); setQuote(null) }} />
          </div>
        </div>

        {/* Rate + impact */}
        {quote && (
          <div className="uni-rate">
            1 {inT.symbol} = {quote.rate} {outT.symbol}
            {quote.impact && (
              <span className={`uni-impact ${parseFloat(quote.impact) > 3 ? 'high' : ''}`}>
                &nbsp;· {quote.impact}% impact
              </span>
            )}
          </div>
        )}

        {/* Decay — shown once we have amounts */}
        {inW > 0n && outW > 0n && (
          <div className="uni-detail-row">
            <span className="uni-detail-label">
              Price decay <span className="uni-label-muted">({outT.symbol}/{inT.symbol}/block)</span>
            </span>
            <input className="uni-detail-input" type="number" min="0" placeholder="0"
              value={decay} onChange={e => setDecay(e.target.value)} />
          </div>
        )}

        {err && <div className="uni-err">{err}</div>}

        <SwapButton />
      </div>
    </div>
  )
}

// ── Auction SVG chart ────────────────────────────────────────────────────────
function AuctionChart({ order, inDec, outDec, curPrice }: {
  order: ActiveOrder; inDec: number; outDec: number; curPrice: number
}) {
  const W = 440, H = 160
  const PL = 8, PR = 8, PT = 12, PB = 28
  const cW = W - PL - PR, cH = H - PT - PB

  const { startBlock, deadline, startPriceContract, decayContract, curBlock } = order
  const span = Math.max(1, deadline - startBlock)

  const startP = contractToHumanPrice(startPriceContract, inDec, outDec)

  const bx = (b: number) => PL + Math.min(1, Math.max(0, (b - startBlock) / span)) * cW
  const py = (p: number) => PT + (1 - Math.min(1, Math.max(0, p / startP))) * cH

  // curve points
  const pts: string[] = []
  for (let i = 0; i <= 60; i++) {
    const b = startBlock + (i / 60) * span
    const dc = decayContract * BigInt(Math.round(b - startBlock))
    const pc = startPriceContract > dc ? startPriceContract - dc : 0n
    const ph = contractToHumanPrice(pc, inDec, outDec)
    pts.push(`${bx(b).toFixed(1)},${py(ph).toFixed(1)}`)
    if (ph <= 0) break
  }

  const cx = bx(Math.min(deadline, Math.max(startBlock, curBlock)))
  const cy = py(Math.max(0, curPrice))

  const inSym  = TOKENS[order.inKey].symbol
  const outSym = TOKENS[order.outKey].symbol

  return (
    <div className="uni-chart-wrap">
      <div className="uni-chart-label">
        <span>Price decay</span>
        <span className="uni-chart-price">{curPrice.toFixed(2)} {outSym}/{inSym}</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* fill */}
        {pts.length > 1 && (
          <path d={`M ${pts.join(' L ')} L ${pts[pts.length-1].split(',')[0]},${PT+cH} L ${PL},${PT+cH} Z`} fill="url(#cg)" />
        )}
        {/* line */}
        {pts.length > 1 && (
          <polyline points={pts.join(' ')} fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" />
        )}

        {/* fill event dots */}
        {order.fills.map(f => {
          if (!f.blockNumber || f.blockNumber < startBlock || f.blockNumber > deadline) return null
          const fb = f.blockNumber
          const dc = decayContract * BigInt(fb - startBlock)
          const pc = startPriceContract > dc ? startPriceContract - dc : 0n
          return <circle key={f.id} cx={bx(fb)} cy={py(contractToHumanPrice(pc, inDec, outDec))} r={4} fill="#16a34a" stroke="white" strokeWidth={1.5} />
        })}

        {/* current dot */}
        <circle cx={cx} cy={cy} r={9} fill="#7c3aed" opacity={0.12}>
          <animate attributeName="r" values="7;11;7" dur="2s" repeatCount="indefinite" />
        </circle>
        <circle cx={cx} cy={cy} r={5} fill="#7c3aed" stroke="white" strokeWidth={2} />

        {/* x labels */}
        <text x={PL} y={H-8} fontSize="10" fill="#94a3b8">block {startBlock}</text>
        <text x={W-PR} y={H-8} textAnchor="end" fontSize="10" fill="#94a3b8">block {deadline}</text>
        <text x={cx} y={H-8} textAnchor="middle" fontSize="10" fill="#7c3aed">now</text>
      </svg>
      {/* timeline bar */}
      <div className="uni-timeline">
        <div className="uni-timeline-fill" style={{ width: `${Math.min(100, Math.max(0, (curBlock - startBlock) / span * 100))}%` }} />
      </div>
    </div>
  )
}

// ── Token pill ───────────────────────────────────────────────────────────────
function TokenPill({ value, onChange, exclude }: { value: TK; onChange: (k: TK) => void; exclude: TK }) {
  return (
    <div className="uni-token-pill">
      <select value={value} onChange={e => onChange(e.target.value as TK)}>
        {(Object.keys(TOKENS) as TK[]).filter(k => k !== exclude).map(k => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
      <span className="uni-pill-arrow">▾</span>
    </div>
  )
}
