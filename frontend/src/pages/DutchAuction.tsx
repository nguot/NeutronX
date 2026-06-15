import { useState, useEffect, useCallback, useRef } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'
import { type TokenInfo, toWei, fromWei, calcStartPrice, humanPriceToContract, maxHumanDecay, DECAY_PER_BLOCK_MAX, TokenPill } from '../lib/tokens'
import { AuctionChart, colorForFiller } from '../components/AuctionChart'
import { BlockEta } from '../lib/blocktime'
import { requestSuggestion } from '../lib/suggest'
import { SuggestPanel } from '../components/SuggestPanel'

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const P2_ABI  = ['function allowance(address,address,address) view returns (uint160,uint48,uint48)', 'function approve(address,address,uint160,uint48)']
const ERC_ABI = ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']

// A Dutch auction must OPEN above the swapper's floor and decay DOWN to it. We
// build that range around the market quote: open +PREMIUM, floor −SLIPPAGE. If
// startPrice equals the minOutput floor (the old behavior) there's no headroom and
// every fill rounds just under the floor and reverts on-chain.
const START_PREMIUM_BPS  = 200n  // auction opens 2% above the quote (optimistic ask)
const FLOOR_SLIPPAGE_BPS = 100n  // minOutput floor sits 1% below the quote (worst acceptable)

interface Fill { id: number; filler: string; fillAmount: string; blockNumber: number | null; createdAt: string }
interface ActiveOrder {
  hash: string; startBlock: number; deadline: number
  startPriceContract: bigint; decayContract: bigint
  inWei: bigint; outWei: bigint; inToken: TokenInfo; outToken: TokenInfo
  fills: Fill[]; status: string; curBlock: number
}

type Step = 'idle' | 'checking' | 'erc20' | 'p2' | 'ready' | 'busy'

export default function DutchAuction({ wallet }: { wallet: WalletState }) {
  const { backendUrl, partialFillReactor, fallbackExecutor, tokens } = useAppConfig()

  const [inKey,  setInKey]  = useState('WETH')
  const [outKey, setOutKey] = useState('USDC')
  const [inAmt,  setInAmt]  = useState('')
  const [quoting, setQuoting] = useState(false)
  const [quote,   setQuote]   = useState<{ rate: string; impact: string | null; source: string } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [outAmt, setOutAmt] = useState('')
  const [decay,  setDecay]  = useState('0')        // human output/input per block
  const [minFillBps, setMinFillBps] = useState(1000)
  const [aggregators,  setAggregators]  = useState<{ key: string; name: string }[]>([])
  const [preferredAgg, setPreferredAgg] = useState('auto')
  const [sugg,       setSugg]       = useState<any>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [step,   setStep]   = useState<Step>('idle')
  const [msg,    setMsg]    = useState('')
  const [err,    setErr]    = useState('')
  const [order,  setOrder]  = useState<ActiveOrder | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)
  const [inBalance,  setInBalance]  = useState<bigint | null>(null)
  const [outBalance, setOutBalance] = useState<bigint | null>(null)

  const inT = tokens.find(t => t.symbol === inKey)
  const outT = tokens.find(t => t.symbol === outKey)
  const inW  = inT ? toWei(inAmt, inT.decimals) : 0n
  const outW = outT ? toWei(outAmt, outT.decimals) : 0n
  const insufficientBalance = inBalance !== null && inW > inBalance

  // ── approvals ──────────────────────────────────────────────────────────────
  // Spenders that need a Permit2 AllowanceTransfer approval from the swapper.
  // PartialFillReactor pulls the input on normal fills; FallbackExecutor pulls
  // the remaining input directly (as msg.sender) when an order falls back near
  // its deadline — Permit2 allowances are keyed by [owner][token][spender], so
  // it needs its own approval separate from the reactor's.
  const p2Spenders = [partialFillReactor, ...(fallbackExecutor ? [fallbackExecutor] : [])]

  const checkApproval = useCallback(async () => {
    if (!wallet.provider || !wallet.account || !partialFillReactor || !inT) return
    setStep('checking')
    try {
      const erc = new ethers.Contract(inT.address, ERC_ABI, wallet.provider)
      const p2  = new ethers.Contract(PERMIT2, P2_ABI, wallet.provider)
      const ea  = await erc.allowance(wallet.account, PERMIT2)
      const eOk = ea.gte(ethers.utils.parseUnits('1000000', inT.decimals))
      const pOks = await Promise.all(p2Spenders.map(async spender => {
        const [pa, pe] = await p2.allowance(wallet.account, inT.address, spender)
        return pa.gt(0) && Number(pe) > Date.now() / 1000
      }))
      const pOk = pOks.every(Boolean)
      setStep(!eOk ? 'erc20' : !pOk ? 'p2' : 'ready')
    } catch { setStep('idle') }
  }, [wallet.provider, wallet.account, partialFillReactor, fallbackExecutor, inT?.address])

  useEffect(() => { if (wallet.connected && partialFillReactor && !order) checkApproval() }, [wallet.connected, partialFillReactor, fallbackExecutor, inKey, order])

  // ── balances ───────────────────────────────────────────────────────────────
  const fetchBalances = useCallback(async () => {
    if (!wallet.provider || !wallet.account || !inT || !outT) { setInBalance(null); setOutBalance(null); return }
    try {
      const inErc  = new ethers.Contract(inT.address, ERC_ABI, wallet.provider)
      const outErc = new ethers.Contract(outT.address, ERC_ABI, wallet.provider)
      const [inBal, outBal] = await Promise.all([inErc.balanceOf(wallet.account), outErc.balanceOf(wallet.account)])
      setInBalance(inBal.toBigInt())
      setOutBalance(outBal.toBigInt())
    } catch { setInBalance(null); setOutBalance(null) }
  }, [wallet.provider, wallet.account, inT?.address, outT?.address])

  useEffect(() => { fetchBalances() }, [fetchBalances, order])

  // ── fallback aggregator options ───────────────────────────────────────────
  // Lets the swapper pin which DEX aggregator the fallback route uses near the
  // deadline, instead of always letting the watcher auto-pick the best quote.
  useEffect(() => {
    fetch(`${backendUrl}/aggregators`)
      .then(r => r.json())
      .then(d => setAggregators(d.aggregators ?? []))
      .catch(() => setAggregators([]))
  }, [backendUrl])

  // ── auto-quote ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSugg(null)   // any change to amount/tokens invalidates a prior suggestion
    const amt = parseFloat(inAmt)
    if (!inAmt || isNaN(amt) || amt <= 0 || !inT || !outT) { setQuote(null); setOutAmt(''); return }

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
    if (!wallet.signer || !inT) return
    setStep('busy'); setMsg('Approving…')
    try { await (await new ethers.Contract(inT.address, ERC_ABI, wallet.signer).approve(PERMIT2, ethers.constants.MaxUint256)).wait(); await checkApproval() }
    catch (e: any) { setErr(e.message); setStep('erc20') }
    setMsg('')
  }
  async function doApproveP2() {
    if (!wallet.signer || !inT) return
    setStep('busy')
    try {
      const p2 = new ethers.Contract(PERMIT2, P2_ABI, wallet.signer)
      for (let i = 0; i < p2Spenders.length; i++) {
        setMsg(p2Spenders.length > 1 ? `Approving Permit2… (${i + 1}/${p2Spenders.length})` : 'Approving Permit2…')
        await (await p2.approve(inT.address, p2Spenders[i], ethers.BigNumber.from('0xffffffffffffffffffffffffffffffff'), ethers.BigNumber.from('0xffffffffffff'))).wait()
      }
      await checkApproval()
    } catch (e: any) { setErr(e.message); setStep('p2') }
    setMsg('')
  }

  // ── parameter suggestion ────────────────────────────────────────────────────
  // Asks the backend to anchor the price curve to the market rate and pick the
  // largest minFillBps that still gets the order covered by the registered
  // fillers (vs. routed to the fallback). See backend/PARAM_SUGGESTION.md.
  async function suggestParams() {
    if (inW <= 0n || !inT || !outT) { setErr('Enter an input amount first'); return }
    setSuggesting(true); setErr(''); setSugg(null)   // drop any prior result so a failed run can't leave stale numbers on screen
    try {
      const data = await requestSuggestion(backendUrl, {
        inputToken: inT.address, outputToken: outT.address, inputAmount: inW.toString(),
        inputDecimals: inT.decimals, outputDecimals: outT.decimals,
        inputSymbol: inT.symbol, outputSymbol: outT.symbol,
      })
      setSugg(data)
      setMinFillBps(data.minFillBps)
      setDecay(String(Number(data.decayHuman).toPrecision(4)))
    } catch (e: any) { setErr(e.message) }
    setSuggesting(false)
  }

  // ── submit ─────────────────────────────────────────────────────────────────
  async function doSwap() {
    if (!wallet.signer || !partialFillReactor || !inT || !outT) return
    setErr(''); setStep('busy'); setMsg('Sign in wallet…')
    const deadline = wallet.blockNumber + 200

    // Treat the quoted output as the market reference and build an auction range
    // around it: open ABOVE the quote (ask) and floor BELOW it (worst acceptable).
    const startOut  = (outW * (10000n + START_PREMIUM_BPS)) / 10000n
    const floorOut  = (outW * (10000n - FLOOR_SLIPPAGE_BPS)) / 10000n
    const sp        = calcStartPrice(inW, startOut)
    const floorRate = calcStartPrice(inW, floorOut)
    const blocks    = BigInt(Math.max(1, deadline - wallet.blockNumber))

    // Decay: a manual value overrides; otherwise auto-sweep start → floor over the window.
    const manualDecay = parseFloat(decay || '0')
    let dp: bigint
    if (manualDecay > 0) {
      dp = humanPriceToContract(manualDecay, inT.decimals, outT.decimals)
      if (dp > DECAY_PER_BLOCK_MAX) {
        const max = maxHumanDecay(inT.decimals, outT.decimals)
        setErr(
          `Price decay too high for ${inT.symbol}/${outT.symbol}: ${decay} ${outT.symbol}/${inT.symbol}/block ` +
          `would overflow the contract's decayPerBlock field (uint32). Max for this pair is ` +
          `~${max.toExponential(3)} ${outT.symbol}/${inT.symbol}/block — leave it blank to auto-sweep to the floor.`
        )
        setStep('ready')
        return
      }
    } else {
      dp = sp > floorRate ? (sp - floorRate) / blocks : 0n
      if (dp > DECAY_PER_BLOCK_MAX) dp = DECAY_PER_BLOCK_MAX  // pair can't decay this fast (uint32) — stays near the opening ask
    }

    const orderBody = {
      swapper: wallet.account, inputToken: inT.address, inputAmount: inW.toString(),
      outputToken: outT.address, minOutputAmount: floorOut.toString(),
      deadline, nonce: Date.now() % 1000000, minFillBps,
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
      const res  = await fetch(`${backendUrl}/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: orderBody, signature: sig,
          preferredAggregator: preferredAgg === 'auto' ? null : preferredAgg,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setOrder({ hash: data.orderHash, startBlock: wallet.blockNumber, deadline, startPriceContract: sp, decayContract: dp, inWei: inW, outWei: floorOut, inToken: inT, outToken: outT, fills: [], status: 'pending', curBlock: wallet.blockNumber })
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
    const inDec = order.inToken.decimals, outDec = order.outToken.decimals
    const filled = order.fills.reduce((s, f) => s + BigInt(f.fillAmount), 0n)
    const pct    = order.inWei > 0n ? Number(filled * 100n / order.inWei) : 0

    return (
      <div className="uni-page">
        <div className="uni-card">
          {/* top bar */}
          <div className="uni-header">
            <button className="uni-back" onClick={() => { setOrder(null); setStep('idle') }}>←</button>
            <span className="uni-hash">{order.hash}</span>
            <span className={`uni-status ${order.status}`}>{order.status}</span>
          </div>

          {/* summary */}
          <div className="uni-summary">
            <span className="uni-summary-amt">{fromWei(order.inWei, inDec)} <b>{order.inToken.symbol}</b></span>
            <span className="uni-arrow">→</span>
            <span className="uni-summary-amt out">min {fromWei(order.outWei, outDec)} <b>{order.outToken.symbol}</b></span>
          </div>

          <div className="text-muted" style={{ textAlign: 'center', fontSize: '0.78rem', marginTop: 2 }}>
            Auction ends <BlockEta target={order.deadline} current={order.curBlock} />
          </div>

          {/* chart */}
          <AuctionChart
            startBlock={order.startBlock} deadline={order.deadline}
            startPriceContract={order.startPriceContract} decayContract={order.decayContract}
            curBlock={order.curBlock} inDec={inDec} outDec={outDec}
            inSym={order.inToken.symbol} outSym={order.outToken.symbol}
            fills={order.fills} totalAmount={order.inWei}
          />

          {/* fill bar — one segment per fill, colored to match the chart dots */}
          <div className="uni-fill-section">
            <div className="uni-fill-label">
              <span>Filled</span>
              <span>{fromWei(filled, inDec)} / {fromWei(order.inWei, inDec)} {order.inToken.symbol} <strong>{pct.toFixed(0)}%</strong></span>
            </div>
            <div className="uni-fill-track">
              {order.fills.map(f => {
                const segPct = order.inWei > 0n ? Number(BigInt(f.fillAmount) * 1000n / order.inWei) / 10 : 0
                return <div key={f.id} className="uni-fill-segment" style={{ width: `${segPct}%`, background: colorForFiller(f.filler) }} />
              })}
            </div>
          </div>

          {/* fill list */}
          {order.fills.length === 0
            ? <p className="uni-waiting">Waiting for fillers…</p>
            : order.fills.map(f => (
              <div key={f.id} className="uni-fill-row">
                <span className="uni-fill-dot" style={{ background: colorForFiller(f.filler) }} />
                <span className="uni-fill-filler">{f.filler}</span>
                <span className="uni-fill-info">{fromWei(BigInt(f.fillAmount), inDec)} {order.inToken.symbol}</span>
                <span className="uni-fill-block">{f.blockNumber ? `#${f.blockNumber}` : new Date(f.createdAt).toLocaleTimeString()}</span>
              </div>
            ))
          }
        </div>
      </div>
    )
  }

  // ── render: swap form ──────────────────────────────────────────────────────
  if (!inT || !outT) {
    return (
      <div className="uni-page">
        <div className="uni-card">
          <div className="uni-header"><span className="uni-title">Swap</span></div>
          <p className="uni-waiting">Loading tokens…</p>
        </div>
      </div>
    )
  }

  const canSwap = wallet.connected && !!partialFillReactor && inW > 0n && outW > 0n && step === 'ready' && !insufficientBalance

  function SwapButton() {
    if (!wallet.connected)      return <button className="uni-btn" disabled>Connect wallet</button>
    if (!partialFillReactor)    return <button className="uni-btn" disabled>Reactor not configured</button>
    if (step === 'checking')    return <button className="uni-btn" disabled>Checking…</button>
    if (step === 'busy')        return <button className="uni-btn" disabled>{msg}</button>
    if (step === 'erc20')       return <button className="uni-btn" onClick={doApproveERC20}>Approve {inKey}</button>
    if (step === 'p2')          return <button className="uni-btn" onClick={doApproveP2}>Enable spending</button>
    if (insufficientBalance)    return <button className="uni-btn" disabled>Insufficient {inKey} balance</button>
    if (!canSwap)               return <button className="uni-btn" disabled>Enter amounts</button>
    return <button className="uni-btn active" onClick={doSwap}>Swap</button>
  }

  return (
    <div className="uni-page">
      <div className="uni-card">
        <div className="uni-header"><span className="uni-title">Swap</span></div>

        {/* Sell box */}
        <div className="uni-input-box">
          <div className="uni-input-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>You sell</span>
            {wallet.connected && inBalance !== null && (
              <span className="uni-balance">
                Balance: {fromWei(inBalance, inT.decimals)}
                <button className="uni-max-btn" onClick={() => setInAmt(ethers.utils.formatUnits(inBalance, inT.decimals))}>MAX</button>
              </span>
            )}
          </div>
          <div className="uni-input-row">
            <input className="uni-amount" type="number" placeholder="0" value={inAmt}
              onChange={e => setInAmt(e.target.value)} />
            <TokenPill tokens={tokens} value={inKey} exclude={outKey}
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
            <span>You receive <span className="uni-label-muted">(market estimate)</span></span>
            <span>
              {quoting && <span className="uni-quoting">fetching price…</span>}
              {!quoting && quote && (
                <span className="uni-quote-src">via {quote.source === 'alpha_router' ? 'Uniswap V3' : 'CoinGecko'}</span>
              )}
              {wallet.connected && outBalance !== null && (
                <span className="uni-balance">Balance: {fromWei(outBalance, outT.decimals)}</span>
              )}
            </span>
          </div>
          <div className="uni-input-row">
            <input className="uni-amount" type="number" placeholder="0" value={outAmt}
              onChange={e => { setOutAmt(e.target.value); setQuote(null) }} />
            <TokenPill tokens={tokens} value={outKey} exclude={inKey} onChange={k => { setOutKey(k); setQuote(null) }} />
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

        {/* Auction range — opens above the quote, decays to a floor below it */}
        {inW > 0n && outW > 0n && (
          <div className="uni-detail-row" style={{ padding: '2px 0' }}>
            <span className="uni-detail-label">Auction range</span>
            <span style={{ fontSize: '0.82rem' }}>
              {fromWei((outW * (10000n + START_PREMIUM_BPS)) / 10000n, outT.decimals)}
              <span className="uni-label-muted"> → </span>
              {fromWei((outW * (10000n - FLOOR_SLIPPAGE_BPS)) / 10000n, outT.decimals)} {outT.symbol}
              <span className="uni-label-muted"> (min received)</span>
            </span>
          </div>
        )}

        {/* Decay — shown once we have amounts */}
        {inW > 0n && outW > 0n && (
          <div className="uni-detail-row">
            <span className="uni-detail-label">
              Price decay <span className="uni-label-muted">
                ({outT.symbol}/{inT.symbol}/block, max ~{maxHumanDecay(inT.decimals, outT.decimals).toExponential(2)})
              </span>
            </span>
            <input className="uni-detail-input" type="number" min="0" placeholder="0"
              value={decay} onChange={e => setDecay(e.target.value)} />
          </div>
        )}

        {/* Fallback route — which DEX aggregator executeFallback uses if the order is still
            open near the deadline. "Auto" lets the watcher compare quotes and pick the best. */}
        {inW > 0n && (
          <div className="uni-detail-row">
            <span className="uni-detail-label">
              Fallback route <span className="uni-label-muted">(if unfilled near deadline)</span>
            </span>
            <select className="uni-detail-select" value={preferredAgg} onChange={e => setPreferredAgg(e.target.value)}>
              <option value="auto">Auto (best price)</option>
              {aggregators.map(a => <option key={a.key} value={a.key}>{a.name}</option>)}
            </select>
          </div>
        )}

        {/* Parameter suggestion: market-anchored price + minFillBps that keeps the order off the fallback */}
        {inW > 0n && (
          <>
            <div className="uni-detail-row">
              <span className="uni-detail-label">
                Min fill <span className="uni-label-muted">({(minFillBps / 100).toFixed(0)}% of order per chunk)</span>
              </span>
              <button className="ghost sm" style={{ marginTop: 0 }} disabled={suggesting} onClick={suggestParams}>
                {suggesting ? 'Analysing fillers…' : '✨ Suggest parameters'}
              </button>
            </div>
            {sugg && <SuggestPanel sugg={sugg} inSym={inT.symbol} outSym={outT.symbol} />}
          </>
        )}

        {err && <div className="uni-err">{err}</div>}

        <SwapButton />
      </div>
    </div>
  )
}
