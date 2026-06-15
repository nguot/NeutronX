import { useState, useEffect, useCallback } from 'react'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'
import { tokenByAddress, short, toWei, fromWei, contractToHumanPrice, humanPriceToContract, calcStartPrice, formatPrice, TokenPill } from '../lib/tokens'
import { AuctionChart } from '../components/AuctionChart'
import { BlockEta, formatDuration, NOMINAL_BLOCK_SEC } from '../lib/blocktime'
import { requestSuggestion, type Suggestion } from '../lib/suggest'
import { SuggestPanel } from '../components/SuggestPanel'

interface FillerQuote {
  filler:          string
  wouldFill:       boolean
  fillAmount:      string
  fillAmountHuman: string
  auctionPrice:    string
  reason:          string
  metadata:        Record<string, unknown>
  error?:          string
}

interface SimulateResult {
  inputToken:             string
  outputToken:            string
  inputAmount:            string
  quotes:                 FillerQuote[]
  totalFillAmount:        string
  totalFillHuman:         string
  remainingAmount:        string
  remainingHuman:         string
  remainingWouldFallback: boolean
}

interface DirectQuote {
  estimatedOutput:       string
  estimatedOutputHuman:  string
  marketRate:            string
  priceImpact:           string | null
  source:                string
}

interface OrderSummary {
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

interface OrderDetail extends OrderSummary {
  nonce:         number
  minFillBps:    number
  startPrice:    string | null
  decayPerBlock: number
  feeTier:       number
}

interface CCSlotSummary {
  index:          number
  status:         string
  assignedFiller: string | null
}

interface CCOrderSummary {
  orderHash:   string
  swapper:     string
  inputToken:  string
  inputAmount: string
  outputToken: string
  minOutput:   string
  deadline:    number
  numSlots:    number
  t2Expiry:    number
  chainAId:    number
  dstChainId:  number
  slots:       CCSlotSummary[]
}

// Mirrors backend/src/services/preflightService.ts's PreflightResult.
interface PreflightResult {
  orderHash:  string
  slotIndex:  number
  slotStatus: string
  slotAmount: string
  filler:     string
  srcChainId: number
  dstChainId: number
  srcBlock:   number
  dstBlock:   number
  srcFill:    { ok: boolean; reason?: string }
  dstBalance: { token: string; have: string; need: string; ok: boolean }
  nativeBalance: {
    src: { have: string; need: string; ok: boolean }
    dst: { have: string; ok: boolean }
  }
  timing:    { t2Expiry: number; ok: boolean }
  fillable:  boolean
}

// Mirrors backend/src/services/preflightService.ts's FillerBalance.
interface FillerBalance {
  name:         string
  address:      string
  balance:      string
  balanceHuman: string
}

// Per-chain token, as returned by GET /cc/tokens (mirrors Explore.tsx).
interface CCTokenInfo { symbol: string; address: string; decimals: number; chainId: number; name?: string }

type Mode = 'order' | 'custom' | 'crosschain'
type CCMode = 'order' | 'custom'

export default function Simulate({ wallet }: { wallet: WalletState }) {
  const { backendUrl, tokens, chains } = useAppConfig()

  const [mode, setMode] = useState<Mode>('order')

  // ── order picker ───────────────────────────────────────────────────────────
  const [orders, setOrders]           = useState<OrderSummary[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [selectedHash, setSelectedHash]   = useState<string | null>(null)
  const [orderDetail, setOrderDetail]     = useState<OrderDetail | null>(null)
  const [orderLoading, setOrderLoading]   = useState(false)

  // ── custom params ──────────────────────────────────────────────────────────
  const [custIn,  setCustIn]  = useState('WETH')
  const [custOut, setCustOut] = useState('USDC')
  const [custAmount, setCustAmount]       = useState('')
  const [custPrice, setCustPrice]         = useState('')   // human: out per in
  const [custDecay, setCustDecay]         = useState('0')   // raw contract units
  const [custDeadline, setCustDeadline]   = useState('')    // optional block #
  const [custMinFillBps, setCustMinFillBps] = useState('1000')
  const [custCurrentBlock, setCustCurrentBlock] = useState('') // what-if override
  const [sugg, setSugg] = useState<Suggestion | null>(null)
  const [suggesting, setSuggesting] = useState(false)

  // ── shared ─────────────────────────────────────────────────────────────────
  const [currentBlock, setCurrentBlock] = useState<number | null>(null)
  const [running, setRunning]           = useState(false)
  const [status, setStatus]             = useState<{ msg: string; cls: string } | null>(null)
  const [result, setResult]             = useState<SimulateResult | null>(null)
  const [directQuote, setDirectQuote]   = useState<DirectQuote | null>(null)
  const [directError, setDirectError]   = useState<string | null>(null)

  // ── interactive auction preview ───────────────────────────────────────────
  const [blockOffset, setBlockOffset]   = useState(0)     // blocks-from-now, drives the slider
  const [simulating, setSimulating]     = useState(false) // lightweight indicator for the slider-driven re-run

  // ── cross-chain order/slot picker + preflight ─────────────────────────────
  const [ccOrders, setCcOrders]               = useState<CCOrderSummary[]>([])
  const [ccOrdersLoading, setCcOrdersLoading] = useState(false)
  const [ccSelectedHash, setCcSelectedHash]   = useState<string | null>(null)
  const [ccSelectedSlot, setCcSelectedSlot]   = useState<number | null>(null)
  const [ccFiller, setCcFiller]               = useState('')
  const [preflight, setPreflight]             = useState<PreflightResult | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)
  const [preflightError, setPreflightError]   = useState<string | null>(null)
  const [rankedFillers, setRankedFillers]         = useState<FillerBalance[]>([])
  const [rankedFillersLoading, setRankedFillersLoading] = useState(false)

  // ── cross-chain custom params (fixed-rate preview, no preflight) ──────────
  const [ccMode, setCcMode] = useState<CCMode>('order')
  const [ccInputTokens,  setCcInputTokens]  = useState<CCTokenInfo[]>([])
  const [ccOutputTokens, setCcOutputTokens] = useState<CCTokenInfo[]>([])
  const [ccCustIn,  setCcCustIn]  = useState('')
  const [ccCustOut, setCcCustOut] = useState('')
  const [ccCustInAmt,  setCcCustInAmt]  = useState('')
  const [ccCustOutAmt, setCcCustOutAmt] = useState('')
  const [ccCustDeadlineBlocks, setCcCustDeadlineBlocks] = useState('1800')

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true)
    try {
      const res  = await fetch(`${backendUrl}/orders?limit=50`)
      const data = await res.json()
      if (res.ok) {
        setOrders((data.orders ?? []).filter((o: OrderSummary) => o.status === 'pending' || o.status === 'active'))
      }
    } catch { /* ignore */ }
    setOrdersLoading(false)
  }, [backendUrl])

  const refreshBlock = useCallback(async () => {
    try {
      const res  = await fetch(`${backendUrl}/admin/blocks`)
      const data = await res.json()
      const chainAId = chains[0]?.id
      const block = chainAId != null ? data.blocks?.[chainAId] : undefined
      if (res.ok && typeof block === 'number') setCurrentBlock(block)
    } catch { /* ignore */ }
  }, [backendUrl, chains])

  useEffect(() => { loadOrders(); refreshBlock() }, [loadOrders, refreshBlock])

  const loadCCOrders = useCallback(async () => {
    setCcOrdersLoading(true)
    try {
      const res  = await fetch(`${backendUrl}/cc/orders`)
      const data = await res.json()
      if (res.ok) setCcOrders(data.orders ?? [])
    } catch { /* ignore */ }
    setCcOrdersLoading(false)
  }, [backendUrl])

  // Token directory for the cross-chain "Custom parameters" preview — chains[0]
  // is the source chain (input token), chains[1] the destination (output token),
  // same convention as Explore.tsx.
  useEffect(() => {
    const srcId = chains[0]?.id
    const dstId = chains[1]?.id
    if (srcId == null || dstId == null) return
    fetch(`${backendUrl}/cc/tokens`)
      .then(r => r.json())
      .then((data: Record<number, CCTokenInfo[]>) => {
        const ins = data[srcId] ?? [], outs = data[dstId] ?? []
        setCcInputTokens(ins)
        setCcOutputTokens(outs)
        setCcCustIn(s => s || ins[0]?.symbol || '')
        setCcCustOut(s => s || outs[0]?.symbol || '')
      })
      .catch(() => {})
  }, [backendUrl, chains])

  // Default the preflight "filler" address to the connected wallet once available.
  useEffect(() => {
    if (wallet.account && !ccFiller) setCcFiller(wallet.account)
  }, [wallet.account, ccFiller])

  function selectCCOrder(hash: string) {
    setCcSelectedHash(hash)
    setCcSelectedSlot(null)
    setPreflight(null); setPreflightError(null)
    setRankedFillers([])
  }

  function selectCCSlot(index: number) {
    setCcSelectedSlot(index)
    setPreflight(null); setPreflightError(null)
  }

  // Registered fillers (Admin → Fillers tab) operating on this slot's dst
  // chain, ranked by their current output-token balance — lets the user pick
  // a likely-fillable filler instead of typing an address by hand.
  useEffect(() => {
    if (!ccSelectedHash || ccSelectedSlot == null) { setRankedFillers([]); return }
    let cancelled = false
    setRankedFillersLoading(true)
    fetch(`${backendUrl}/cc/orders/${ccSelectedHash}/slots/${ccSelectedSlot}/fillers`)
      .then(r => r.json())
      .then(data => { if (!cancelled) setRankedFillers(data.fillers ?? []) })
      .catch(() => { if (!cancelled) setRankedFillers([]) })
      .finally(() => { if (!cancelled) setRankedFillersLoading(false) })
    return () => { cancelled = true }
  }, [backendUrl, ccSelectedHash, ccSelectedSlot])

  async function runPreflight() {
    if (!ccSelectedHash || ccSelectedSlot == null) return
    if (!/^0x[0-9a-fA-F]{40}$/.test(ccFiller)) {
      setPreflightError('Enter a valid filler address (or connect a wallet)'); return
    }
    setPreflightLoading(true); setPreflightError(null); setPreflight(null)
    try {
      const res  = await fetch(`${backendUrl}/cc/orders/${ccSelectedHash}/slots/${ccSelectedSlot}/preflight?filler=${ccFiller}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Preflight failed')
      setPreflight(data)
    } catch (e: any) {
      setPreflightError(e.message)
    }
    setPreflightLoading(false)
  }

  // Drop a stale suggestion when the custom inputs change.
  useEffect(() => { setSugg(null) }, [custIn, custOut, custAmount])

  // Same parameter suggestion as the Swap page — fills start price, decay and min fill.
  async function suggestCustom() {
    const inT = tokens.find(t => t.symbol === custIn)
    const outT = tokens.find(t => t.symbol === custOut)
    const amt = parseFloat(custAmount)
    if (!inT || !outT || !custAmount || isNaN(amt) || amt <= 0) {
      setStatus({ msg: 'Enter an input amount first', cls: 'bad' }); return
    }
    setSuggesting(true); setStatus(null); setSugg(null)
    try {
      const data = await requestSuggestion(backendUrl, {
        inputToken: inT.address, outputToken: outT.address,
        inputAmount: toWei(custAmount, inT.decimals).toString(),
        inputDecimals: inT.decimals, outputDecimals: outT.decimals,
        inputSymbol: inT.symbol, outputSymbol: outT.symbol,
      })
      setSugg(data)
      setCustPrice(Number(data.startPriceHuman).toFixed(6))
      setCustDecay(String(Number(data.decayHuman).toPrecision(4)))
      setCustMinFillBps(String(data.minFillBps))
    } catch (e: any) { setStatus({ msg: e.message, cls: 'bad' }) }
    setSuggesting(false)
  }

  async function selectOrder(hash: string) {
    setSelectedHash(hash)
    setOrderDetail(null)
    setResult(null); setDirectQuote(null); setDirectError(null); setStatus(null); setBlockOffset(0)
    setOrderLoading(true)
    try {
      const res  = await fetch(`${backendUrl}/orders/${hash}`)
      const data = await res.json()
      if (res.ok) setOrderDetail(data)
    } catch { /* ignore */ }
    setOrderLoading(false)
  }

  function switchMode(m: Mode) {
    setMode(m)
    setResult(null); setDirectQuote(null); setDirectError(null); setStatus(null); setBlockOffset(0)
    if (m === 'crosschain' && ccOrders.length === 0) loadCCOrders()
  }

  // Resolve the input/output token info for whichever mode is active.
  function effectiveTokens() {
    if (mode === 'order') {
      if (!orderDetail) return null
      const inT  = tokenByAddress(orderDetail.inputToken, tokens)
      const outT = tokenByAddress(orderDetail.outputToken, tokens)
      return {
        inputToken: orderDetail.inputToken, outputToken: orderDetail.outputToken,
        inSym:  inT?.symbol  ?? short(orderDetail.inputToken),
        outSym: outT?.symbol ?? short(orderDetail.outputToken),
        inDec:  inT?.decimals  ?? 18,
        outDec: outT?.decimals ?? 6,
      }
    }
    const inT = tokens.find(t => t.symbol === custIn), outT = tokens.find(t => t.symbol === custOut)
    if (!inT || !outT) return null
    return { inputToken: inT.address, outputToken: outT.address, inSym: inT.symbol, outSym: outT.symbol, inDec: inT.decimals, outDec: outT.decimals }
  }
  const eff = effectiveTokens()
  // Filler quotes & /simulate aggregates currently assume an 18-dec input / 6-dec
  // output pair (always labelled "WETH"/"USDC"); only compare $ amounts then.
  const unitsOk = !!eff && eff.inDec === 18 && eff.outDec === 6

  // Resolve the auction curve (start block / deadline / price / decay) for whichever
  // mode is active, so the chart + slider can be shown before "Run Simulation" too.
  function getChartParams(): {
    startBlock: number; deadline: number
    startPriceContract: bigint; decayContract: bigint
    inputToken: string; outputToken: string; inputAmount: string
    minFillBps?: number
  } | null {
    if (mode === 'order') {
      if (!orderDetail || currentBlock == null) return null
      return {
        startBlock: currentBlock, deadline: orderDetail.deadline,
        startPriceContract: BigInt(orderDetail.startPrice ?? '0'),
        decayContract: BigInt(orderDetail.decayPerBlock ?? 0),
        inputToken: orderDetail.inputToken, outputToken: orderDetail.outputToken,
        inputAmount: orderDetail.inputAmount, minFillBps: orderDetail.minFillBps,
      }
    }
    const amt = parseFloat(custAmount), price = parseFloat(custPrice)
    if (!custAmount || isNaN(amt) || amt <= 0 || !custPrice || isNaN(price) || price <= 0) return null
    const inT = tokens.find(t => t.symbol === custIn), outT = tokens.find(t => t.symbol === custOut)
    if (!inT || !outT) return null
    const sb = custCurrentBlock ? parseInt(custCurrentBlock) : (currentBlock ?? 0)
    const dl = custDeadline ? parseInt(custDeadline) : sb + 100
    return {
      startBlock: sb, deadline: dl,
      startPriceContract: humanPriceToContract(price, inT.decimals, outT.decimals),
      decayContract: humanPriceToContract(parseFloat(custDecay || '0'), inT.decimals, outT.decimals),
      inputToken: inT.address, outputToken: outT.address,
      inputAmount: toWei(custAmount, inT.decimals).toString(),
      minFillBps: custMinFillBps ? parseInt(custMinFillBps) : undefined,
    }
  }
  const chart     = getChartParams()
  const chartSpan = chart ? Math.max(1, chart.deadline - chart.startBlock) : 0
  const blocksLeft = chart ? chart.deadline - (chart.startBlock + blockOffset) : 0

  // The dev-mode filler strategy always treats `blocksPassed` from the auction's
  // last reset as 0 (the simulated order has no prior fills), so /simulate's
  // `currentBlock` never decays `auctionPrice` on its own. To make the slider
  // actually move the price, we pre-apply the decay client-side and send the
  // already-decayed price as `startPrice` (with `decayPerBlock: 0`); the shifted
  // `currentBlock` still drives the real `blocksLeft` deadline check.
  useEffect(() => {
    if (!result || !chart) return
    setSimulating(true)
    const handle = setTimeout(async () => {
      const decay   = chart.decayContract * BigInt(blockOffset)
      const decayed = chart.startPriceContract > decay ? chart.startPriceContract - decay : 0n
      try {
        const body: Record<string, unknown> = {
          inputToken: chart.inputToken, outputToken: chart.outputToken, inputAmount: chart.inputAmount,
          startPrice: decayed.toString(), decayPerBlock: 0,
          currentBlock: chart.startBlock + blockOffset,
        }
        if (chart.deadline != null)   body.deadline   = chart.deadline
        if (chart.minFillBps != null) body.minFillBps = chart.minFillBps
        const res  = await fetch(`${backendUrl}/simulate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        const data = await res.json()
        if (res.ok) setResult(data)
      } catch { /* ignore */ }
      setSimulating(false)
    }, 300)
    return () => { clearTimeout(handle); setSimulating(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockOffset])

  async function runSimulation() {
    setStatus(null); setResult(null); setDirectQuote(null); setDirectError(null); setBlockOffset(0)

    let inputToken: string, outputToken: string, inputAmount: string
    let startPrice: string, decayPerBlock: number
    let deadline: number | undefined, minFillBps: number | undefined, simBlock: number | undefined

    if (mode === 'order') {
      if (!orderDetail) return setStatus({ msg: 'Pick an order from the list above', cls: 'bad' })
      inputToken    = orderDetail.inputToken
      outputToken   = orderDetail.outputToken
      inputAmount   = orderDetail.inputAmount
      startPrice    = orderDetail.startPrice ?? '0'
      decayPerBlock = orderDetail.decayPerBlock ?? 0
      deadline      = orderDetail.deadline
      minFillBps    = orderDetail.minFillBps
      simBlock      = currentBlock ?? undefined
    } else {
      const inT = tokens.find(t => t.symbol === custIn), outT = tokens.find(t => t.symbol === custOut)
      if (!inT || !outT) return setStatus({ msg: 'Tokens still loading — try again in a moment', cls: 'bad' })
      const amt = parseFloat(custAmount), price = parseFloat(custPrice)
      if (!custAmount || isNaN(amt) || amt <= 0) return setStatus({ msg: 'Enter an input amount', cls: 'bad' })
      if (!custPrice || isNaN(price) || price <= 0) return setStatus({ msg: 'Enter a start price', cls: 'bad' })
      inputToken    = inT.address
      outputToken   = outT.address
      inputAmount   = toWei(custAmount, inT.decimals).toString()
      startPrice    = humanPriceToContract(price, inT.decimals, outT.decimals).toString()
      decayPerBlock = Number(humanPriceToContract(parseFloat(custDecay || '0'), inT.decimals, outT.decimals))
      deadline      = custDeadline ? parseInt(custDeadline) : undefined
      minFillBps    = custMinFillBps ? parseInt(custMinFillBps) : undefined
      simBlock      = custCurrentBlock ? parseInt(custCurrentBlock) : (currentBlock ?? undefined)
    }

    const inT  = tokenByAddress(inputToken, tokens)
    const outT = tokenByAddress(outputToken, tokens)
    const inDec = inT?.decimals ?? 18, outDec = outT?.decimals ?? 6
    const inSym = inT?.symbol ?? short(inputToken), outSym = outT?.symbol ?? short(outputToken)

    setRunning(true)
    setStatus({ msg: 'Running simulation…', cls: 'info' })

    try {
      const body: Record<string, unknown> = { inputToken, outputToken, inputAmount, startPrice, decayPerBlock }
      if (simBlock != null)   body.currentBlock = simBlock
      if (deadline != null)   body.deadline     = deadline
      if (minFillBps != null) body.minFillBps   = minFillBps

      const res  = await fetch(`${backendUrl}/simulate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Backend error')
      setResult(data)
    } catch (e: any) {
      setStatus({ msg: e.message, cls: 'bad' })
      setRunning(false)
      return
    }

    try {
      const params = new URLSearchParams({
        inputToken, outputToken, inputAmount,
        inputDecimals: String(inDec), outputDecimals: String(outDec),
        inputSymbol: inSym, outputSymbol: outSym,
      })
      const res  = await fetch(`${backendUrl}/quote?${params}`)
      const data = await res.json()
      if (res.ok) setDirectQuote(data)
      else setDirectError(data.error ?? 'Direct-swap quote unavailable')
    } catch (e: any) {
      setDirectError(e.message)
    }

    setStatus({ msg: 'Simulation complete.', cls: 'ok' })
    setRunning(false)
  }

  // Compare what the swapper nets via the Dutch-auction fillers (+ AlphaRouter
  // fallback for any unfilled remainder) against a single direct AlphaRouter swap.
  function computeComparison() {
    if (!result || !directQuote || !unitsOk) return null
    // Every filler quotes the same order at the same currentBlock, so they all
    // report the same auctionPrice — use that to value the (already-capped)
    // total fill rather than re-summing each filler's full-order quote.
    const filling = result.quotes.find(q => q.wouldFill)
    let viaAuction = 0
    if (filling) {
      const totalFillAmt = parseFloat(result.totalFillHuman)
      const price        = parseFloat(filling.auctionPrice)
      if (!isNaN(totalFillAmt) && !isNaN(price)) viaAuction += totalFillAmt * price
    }
    if (result.remainingWouldFallback) {
      const remaining = parseFloat(result.remainingHuman)
      const rate       = parseFloat(directQuote.marketRate)
      if (!isNaN(remaining) && !isNaN(rate)) viaAuction += remaining * rate
    }
    const direct = parseFloat(directQuote.estimatedOutputHuman)
    if (isNaN(direct) || direct <= 0) return null
    return { viaAuction, direct, delta: (viaAuction - direct) / direct * 100 }
  }
  const comparison = computeComparison()

  // Cross-chain "custom parameters" preview: a fixed-rate swap split into
  // getNumSlots() equal slots (see backend/src/services/crosschainService.ts),
  // with no Dutch-auction decay. Client-side math only — no /simulate or
  // /preflight call, since there's no real order/slot to dry-run against.
  const ccInT  = ccInputTokens.find(t => t.symbol === ccCustIn)
  const ccOutT = ccOutputTokens.find(t => t.symbol === ccCustOut)
  const ccInW  = ccInT  ? toWei(ccCustInAmt,  ccInT.decimals)  : 0n
  const ccOutW = ccOutT ? toWei(ccCustOutAmt, ccOutT.decimals) : 0n
  const ccPreview = (ccInT && ccOutT && ccInW > 0n && ccOutW > 0n && currentBlock != null) ? (() => {
    const numSlots       = getNumSlotsPreview(ccInW, ccInT.decimals)
    const deadlineBlocks = ccCustDeadlineBlocks ? parseInt(ccCustDeadlineBlocks) : 1800
    return {
      rate:       contractToHumanPrice(calcStartPrice(ccInW, ccOutW), ccInT.decimals, ccOutT.decimals),
      numSlots,
      perSlotIn:  ccInW  / BigInt(numSlots),
      perSlotOut: ccOutW / BigInt(numSlots),
      deadline:   currentBlock + deadlineBlocks,
    }
  })() : null

  const ccToggleActive = { background: '#f5f3ff', borderColor: '#7c3aed', color: '#7c3aed' }

  return (
    <>
      <div className="page-header">
        <div className="page-title">Simulate Order</div>
      </div>

      <div className="card">
        <div className="tabs">
          <button className={`tab-btn ${mode === 'order' ? 'active' : ''}`} onClick={() => switchMode('order')}>From an order</button>
          <button className={`tab-btn ${mode === 'custom' ? 'active' : ''}`} onClick={() => switchMode('custom')}>Custom parameters</button>
          <button className={`tab-btn ${mode === 'crosschain' ? 'active' : ''}`} onClick={() => switchMode('crosschain')}>Cross-chain order</button>
        </div>

        {mode === 'crosschain' ? (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <button className="ghost sm" style={{ marginTop: 0, ...(ccMode === 'order' ? ccToggleActive : {}) }} onClick={() => setCcMode('order')}>From an order</button>
              <button className="ghost sm" style={{ marginTop: 0, ...(ccMode === 'custom' ? ccToggleActive : {}) }} onClick={() => setCcMode('custom')}>Custom parameters</button>
            </div>

            {ccMode === 'order' ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: '0.78rem', color: '#64748b' }}>Cross-chain orders</span>
                  <button className="ghost sm" style={{ marginTop: 0 }} onClick={loadCCOrders}>↻ Refresh</button>
                </div>
                {ccOrdersLoading && <div style={{ color: '#94a3b8', fontSize: '0.82rem', padding: '8px 0' }}>Loading…</div>}
                {!ccOrdersLoading && ccOrders.length === 0 && (
                  <div className="empty-state"><div className="empty-icon">📋</div>No cross-chain orders yet.</div>
                )}
                {ccOrders.map(o => {
                  const inT  = tokenByAddress(o.inputToken, tokens)
                  const outT = tokenByAddress(o.outputToken, tokens)
                  const srcName = chains.find(c => c.id === o.chainAId)?.name ?? `Chain ${o.chainAId}`
                  const dstName = chains.find(c => c.id === o.dstChainId)?.name ?? `Chain ${o.dstChainId}`
                  return (
                    <div key={o.orderHash} className={`slot-card ${ccSelectedHash === o.orderHash ? 'claimed' : ''}`}
                         style={{ cursor: 'pointer' }} onClick={() => selectCCOrder(o.orderHash)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span className="mono" style={{ fontSize: '0.75rem' }}>{short(o.orderHash)}</span>
                        <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{srcName} → {dstName}</span>
                        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#94a3b8' }} onClick={e => e.stopPropagation()}>deadline <BlockEta target={o.deadline} showClock={false} /></span>
                      </div>
                      <div style={{ fontSize: '0.85rem' }}>
                        {fromWei(BigInt(o.inputAmount), inT?.decimals ?? 18)} <b>{inT?.symbol ?? short(o.inputToken)}</b>
                        <span style={{ color: '#94a3b8', margin: '0 6px' }}>→</span>
                        min {fromWei(BigInt(o.minOutput), outT?.decimals ?? 18)} <b>{outT?.symbol ?? short(o.outputToken)}</b>
                        <span style={{ color: '#94a3b8', marginLeft: 8 }}>({o.numSlots} slot{o.numSlots === 1 ? '' : 's'})</span>
                      </div>
                      {ccSelectedHash === o.orderHash && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                          {o.slots.map(s => (
                            <button key={s.index}
                              className={`tag ${s.status === 'available' ? 'available' : 'claimed'}`}
                              style={{ cursor: 'pointer', outline: ccSelectedSlot === s.index ? '2px solid #7c3aed' : 'none' }}
                              onClick={() => selectCCSlot(s.index)}>
                              slot {s.index} · {s.status}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            ) : (
              <>
                <div className="uni-input-box">
                  <div className="uni-input-label">You send <span className="uni-label-muted">({chains[0]?.name ?? 'source chain'})</span></div>
                  <div className="uni-input-row">
                    <input className="uni-amount" type="number" placeholder="0" value={ccCustInAmt}
                      onChange={e => setCcCustInAmt(e.target.value)} />
                    <TokenPill tokens={ccInputTokens} value={ccCustIn} onChange={setCcCustIn} />
                  </div>
                </div>
                <div className="uni-input-box">
                  <div className="uni-input-label">You receive <span className="uni-label-muted">(minimum · {chains[1]?.name ?? 'destination chain'})</span></div>
                  <div className="uni-input-row">
                    <input className="uni-amount" type="number" placeholder="0" value={ccCustOutAmt}
                      onChange={e => setCcCustOutAmt(e.target.value)} />
                    <TokenPill tokens={ccOutputTokens} value={ccCustOut} onChange={setCcCustOut} />
                  </div>
                </div>
                <details className="uni-advanced">
                  <summary>Advanced</summary>
                  <div className="uni-detail-row">
                    <span className="uni-detail-label">Deadline <span className="uni-label-muted">(blocks from now)</span></span>
                    <input className="uni-detail-input" type="number" value={ccCustDeadlineBlocks}
                      onChange={e => setCcCustDeadlineBlocks(e.target.value)} />
                  </div>
                </details>
              </>
            )}
          </>
        ) : mode === 'order' ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: '0.78rem', color: '#64748b' }}>Pending &amp; active orders</span>
              <button className="ghost sm" style={{ marginTop: 0 }} onClick={loadOrders}>↻ Refresh</button>
            </div>
            {ordersLoading && <div style={{ color: '#94a3b8', fontSize: '0.82rem', padding: '8px 0' }}>Loading…</div>}
            {!ordersLoading && orders.length === 0 && (
              <div className="empty-state"><div className="empty-icon">📋</div>No pending orders — try Custom parameters.</div>
            )}
            {orders.map(o => {
              const inT = tokenByAddress(o.inputToken, tokens), outT = tokenByAddress(o.outputToken, tokens)
              return (
                <div key={o.hash} className={`slot-card ${selectedHash === o.hash ? 'claimed' : ''}`}
                     style={{ cursor: 'pointer' }} onClick={() => selectOrder(o.hash)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span className={`badge ${o.status}`}>{o.status}</span>
                    <span className="mono" style={{ fontSize: '0.75rem' }}>{short(o.hash)}</span>
                    <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#94a3b8' }} onClick={e => e.stopPropagation()}>deadline <BlockEta target={o.deadline} showClock={false} /></span>
                  </div>
                  <div style={{ fontSize: '0.85rem' }}>
                    {fromWei(BigInt(o.inputAmount), inT?.decimals ?? 18)} <b>{inT?.symbol ?? short(o.inputToken)}</b>
                    <span style={{ color: '#94a3b8', margin: '0 6px' }}>→</span>
                    min {fromWei(BigInt(o.minOutput), outT?.decimals ?? 18)} <b>{outT?.symbol ?? short(o.outputToken)}</b>
                  </div>
                </div>
              )
            })}
            {orderLoading && <div style={{ color: '#94a3b8', fontSize: '0.82rem', marginTop: 8 }}>Loading order details…</div>}
          </>
        ) : (
          <>
            <div className="uni-input-box">
              <div className="uni-input-label">Input</div>
              <div className="uni-input-row">
                <input className="uni-amount" type="number" placeholder="0" value={custAmount}
                  onChange={e => setCustAmount(e.target.value)} />
                <TokenPill tokens={tokens} value={custIn} exclude={custOut} onChange={setCustIn} />
              </div>
            </div>
            <div className="uni-input-box">
              <div className="uni-input-label">Output token</div>
              <div className="uni-input-row">
                <span style={{ flex: 1, color: '#94a3b8', fontSize: '0.85rem' }}>set via start price below</span>
                <TokenPill tokens={tokens} value={custOut} exclude={custIn} onChange={setCustOut} />
              </div>
            </div>

            {/* Suggest parameters — same flow as the Swap page */}
            <div className="uni-detail-row">
              <span className="uni-detail-label">Parameters</span>
              <button className="ghost sm" style={{ marginTop: 0 }} disabled={suggesting} onClick={suggestCustom}>
                {suggesting ? 'Analysing fillers…' : '✨ Suggest parameters'}
              </button>
            </div>
            {sugg && <SuggestPanel sugg={sugg} inSym={custIn} outSym={custOut} />}

            <div className="uni-detail-row">
              <span className="uni-detail-label">Start price ({custOut} per {custIn})</span>
              <input className="uni-detail-input" type="number" placeholder="e.g. 2500" value={custPrice}
                onChange={e => setCustPrice(e.target.value)} />
            </div>
            <div className="uni-detail-row">
              <span className="uni-detail-label">Price decay <span className="uni-label-muted">({custOut} per {custIn} per block, 0 = flat)</span></span>
              <input className="uni-detail-input" type="number" min="0" step="any" placeholder="0" value={custDecay}
                onChange={e => setCustDecay(e.target.value)} />
            </div>
            <details className="uni-advanced">
              <summary>Advanced</summary>
              <div className="uni-detail-row">
                <span className="uni-detail-label">Deadline <span className="uni-label-muted">(block, optional)</span></span>
                <input className="uni-detail-input" type="number" placeholder="auto" value={custDeadline}
                  onChange={e => setCustDeadline(e.target.value)} />
              </div>
              <div className="uni-detail-row">
                <span className="uni-detail-label">Min fill (bps)</span>
                <input className="uni-detail-input" type="number" value={custMinFillBps}
                  onChange={e => setCustMinFillBps(e.target.value)} />
              </div>
              <div className="uni-detail-row">
                <span className="uni-detail-label">Current block <span className="uni-label-muted">(what-if override)</span></span>
                <input className="uni-detail-input" type="number" placeholder={String(currentBlock ?? '')} value={custCurrentBlock}
                  onChange={e => setCustCurrentBlock(e.target.value)} />
              </div>
            </details>
          </>
        )}
      </div>

      {mode === 'crosschain' && ccMode === 'custom' && ccInT && ccOutT && ccPreview && (
        <div className="card">
          <h2 style={{ marginBottom: 8 }}>Order preview</h2>
          <div style={{ display: 'flex', gap: 24, marginBottom: 8, flexWrap: 'wrap' }}>
            <Stat label="Rate" value={`${formatPrice(ccPreview.rate)} ${ccOutT.symbol} / ${ccInT.symbol}`} accent />
            <Stat label="Expires" value={<BlockEta target={ccPreview.deadline} current={currentBlock} showClock={false} />} />
          </div>
          <div className="uni-info-panel" style={{ margin: 0 }}>
            Splits into {ccPreview.numSlots} slots of {fromWei(ccPreview.perSlotIn, ccInT.decimals)} {ccInT.symbol} → {fromWei(ccPreview.perSlotOut, ccOutT.decimals)} {ccOutT.symbol} each — any registered filler can take one. Preview only, no order created.
          </div>
        </div>
      )}

      {chart && eff && mode !== 'crosschain' && (
        <div className="card">
          <h2 style={{ marginBottom: 8 }}>Auction preview</h2>
          <AuctionChart
            startBlock={chart.startBlock} deadline={chart.deadline}
            startPriceContract={chart.startPriceContract} decayContract={chart.decayContract}
            curBlock={chart.startBlock + blockOffset}
            inDec={eff.inDec} outDec={eff.outDec} inSym={eff.inSym} outSym={eff.outSym}
            curLabel={blockOffset === 0 ? 'now' : `+${blockOffset}`}
          />
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: '#64748b', marginBottom: 4 }}>
              <span>Blocks from now: <strong>{blockOffset}</strong> <span className="uni-label-muted">(block {chart.startBlock + blockOffset})</span></span>
              <span style={{ color: blocksLeft <= 0 ? '#dc2626' : blocksLeft < 5 ? '#d97706' : '#94a3b8' }}>
                {blocksLeft <= 0 ? 'expired' : blocksLeft < 5 ? `${blocksLeft} blocks left — too close to deadline` : `${blocksLeft} blocks (≈ ${formatDuration(blocksLeft * NOMINAL_BLOCK_SEC)}) to deadline`}
              </span>
            </div>
            <input type="range" min={0} max={chartSpan} value={Math.min(blockOffset, chartSpan)}
              onChange={e => setBlockOffset(Number(e.target.value))}
              style={{ width: '100%' }} />
            <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 4 }}>
              {result
                ? (simulating ? 'Updating filler quotes…' : 'Drag to preview how the auction price decays and how fillers respond as the deadline approaches.')
                : 'Drag to preview the price decay curve, then run the simulation to see how fillers respond at this point.'}
            </div>
          </div>
        </div>
      )}

      {mode !== 'crosschain' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.82rem', color: '#475569' }}>
              Current block (Chain A): <strong>{currentBlock ?? '—'}</strong>
            </span>
            <button className="ghost sm" style={{ marginTop: 0 }} onClick={refreshBlock}>↻</button>
          </div>

          {mode === 'order' && orderDetail && eff && (
            <div className="uni-detail-row" style={{ padding: '10px 0 0' }}>
              <span className="uni-detail-label">Start price</span>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#0f172a' }}>
                {contractToHumanPrice(BigInt(orderDetail.startPrice ?? '0'), eff.inDec, eff.outDec).toFixed(4)} {eff.outSym} / {eff.inSym}
              </span>
            </div>
          )}

          <button onClick={runSimulation} disabled={running || (mode === 'order' && !orderDetail)}>
            {running ? 'Simulating…' : 'Run Simulation'}
          </button>
          {status && <div className={`status ${status.cls}`}>{status.msg}</div>}
        </div>
      )}

      {mode === 'crosschain' && ccMode === 'order' && ccSelectedHash && ccSelectedSlot != null && (
        <div className="card">
          {(() => {
            const o    = ccOrders.find(x => x.orderHash === ccSelectedHash)
            const outT = o ? tokenByAddress(o.outputToken, tokens) : undefined
            const sym  = outT?.symbol ?? (o ? short(o.outputToken) : '')
            return (
              <>
                <div style={{ fontSize: '0.78rem', color: '#64748b', marginBottom: 4 }}>
                  Registered fillers {sym && `— ranked by ${sym} balance on the dst chain`}
                </div>
                {rankedFillersLoading && <div style={{ color: '#94a3b8', fontSize: '0.82rem', padding: '4px 0' }}>Loading…</div>}
                {!rankedFillersLoading && rankedFillers.length === 0 && (
                  <div style={{ color: '#94a3b8', fontSize: '0.82rem', padding: '4px 0' }}>
                    No registered fillers configured for this chain — add one in Admin → Fillers, or enter an address below.
                  </div>
                )}
                {rankedFillers.map(rf => (
                  <div key={rf.address} className={`slot-card ${ccFiller.toLowerCase() === rf.address.toLowerCase() ? 'claimed' : ''}`}
                       style={{ cursor: 'pointer', marginBottom: 6 }} onClick={() => setCcFiller(rf.address)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.82rem' }}>
                      <span><strong>{rf.name}</strong> <span className="mono" style={{ color: '#94a3b8' }}>{short(rf.address)}</span></span>
                      <span>{Number(rf.balanceHuman).toFixed(4)} {sym}</span>
                    </div>
                  </div>
                ))}
              </>
            )
          })()}

          <div className="uni-detail-row">
            <span className="uni-detail-label">Filler address <span className="uni-label-muted">(the "from" used for the dry-run)</span></span>
            <input className="uni-detail-input" type="text" placeholder="0x…" value={ccFiller}
              onChange={e => setCcFiller(e.target.value)} />
          </div>
          <button onClick={runPreflight} disabled={preflightLoading}>
            {preflightLoading ? 'Checking…' : `Run Preflight — slot ${ccSelectedSlot}`}
          </button>
          {preflightError && <div className="status bad">{preflightError}</div>}
        </div>
      )}

      {mode === 'crosschain' && ccMode === 'order' && preflight && (
        <div className="card">
          <h2>Preflight — slot {preflight.slotIndex} ({preflight.slotStatus})</h2>
          <div className={`status ${preflight.fillable ? 'ok' : 'bad'}`}>
            {preflight.fillable
              ? '✅ This fill would currently succeed for this filler.'
              : '⚠️ This fill would currently fail — see the checks below.'}
          </div>

          <PreflightRow
            label="Step 1 — fillSlot() dry-run on src chain"
            ok={preflight.srcFill.ok}
            detail={preflight.srcFill.reason ?? 'would succeed'}
          />
          {(() => {
            const outT = tokenByAddress(preflight.dstBalance.token, tokens)
            const dec  = outT?.decimals ?? 18
            const sym  = outT?.symbol ?? short(preflight.dstBalance.token)
            return (
              <PreflightRow
                label="Output-token balance on dst chain (step 3 funding)"
                ok={preflight.dstBalance.ok}
                detail={`have ${fromWei(BigInt(preflight.dstBalance.have), dec)} / need ${fromWei(BigInt(preflight.dstBalance.need), dec)} ${sym}`}
              />
            )
          })()}
          <PreflightRow
            label="Safety deposit (native, src chain)"
            ok={preflight.nativeBalance.src.ok}
            detail={`have ${fromWei(BigInt(preflight.nativeBalance.src.have), 18)} / need ${fromWei(BigInt(preflight.nativeBalance.src.need), 18)} ETH`}
          />
          <PreflightRow
            label="Gas balance (native, dst chain)"
            ok={preflight.nativeBalance.dst.ok}
            detail={`have ${fromWei(BigInt(preflight.nativeBalance.dst.have), 18)} ETH`}
          />
          <PreflightRow
            label="Timing — t2Expiry (dst escrow deploy deadline)"
            ok={preflight.timing.ok}
            detail={`current src block ${preflight.srcBlock} / expires at block ${preflight.timing.t2Expiry}`}
          />
        </div>
      )}

      {(result || directQuote || directError) && eff && mode !== 'crosschain' && (
        <div className="card">
          <h2>Results</h2>

          <div style={{ display: 'flex', gap: 24, marginBottom: 8, flexWrap: 'wrap' }}>
            {directQuote && <Stat label="Direct swap" value={`${directQuote.estimatedOutputHuman} ${eff.outSym}`} />}
            {comparison && <Stat label="Via Dutch auction" value={`≈ ${comparison.viaAuction.toFixed(4)} ${eff.outSym}`} accent />}
            {comparison && (
              <Stat label="Difference vs. direct"
                value={`${comparison.delta >= 0 ? '+' : ''}${comparison.delta.toFixed(2)}%`}
                good={comparison.delta >= 0} warn={comparison.delta < 0} />
            )}
            {result && <Stat label="Total willing to fill" value={result.totalFillHuman} />}
            {result && <Stat label="Remaining" value={result.remainingHuman} />}
            {result && <Stat label="Order filled" value={`${pctOfOrder(result.totalFillAmount, result.inputAmount).toFixed(1)}%`} accent />}
          </div>

          {directError && <div className="status bad">Direct-swap quote unavailable: {directError}</div>}
          {result && !unitsOk && (
            <div className="status info">
              Dollar totals are only exact for stablecoin-output pairs — the per-filler responses below are still valid.
            </div>
          )}

          {result?.quotes.map(q => (
            <div key={q.filler} className={`slot-card ${q.wouldFill ? 'claimed' : ''}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span className={`tag ${q.wouldFill ? 'claimed' : 'available'}`}>
                  {q.wouldFill ? 'would fill' : 'would skip'}
                </span>
                <strong style={{ fontSize: '0.88rem' }}>{q.filler}</strong>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px 16px', fontSize: '0.78rem' }}>
                <div><span style={{ color: '#64748b' }}>fill amount: </span>{q.fillAmountHuman}</div>
                <div><span style={{ color: '#64748b' }}>% of order: </span>{pctOfOrder(q.fillAmount, result?.inputAmount ?? '0').toFixed(1)}%</div>
                <div><span style={{ color: '#64748b' }}>auction price: </span>{q.auctionPrice}</div>
                <div><span style={{ color: '#64748b' }}>reason: </span>{q.reason}</div>
              </div>
              {Object.keys(q.metadata).length > 0 && (
                <div style={{ marginTop: 6, fontSize: '0.72rem', color: '#64748b' }}>
                  metadata: <code>{JSON.stringify(q.metadata)}</code>
                </div>
              )}
              {q.error && <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: 4 }}>error: {q.error}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// Mirrors backend/src/services/crosschainService.ts's getNumSlots — number of
// equal slots a cross-chain order of this input size would split into.
// Thresholds are in 18-decimal "ether" units, so normalize first — otherwise
// a token with fewer decimals (e.g. 6-decimal USDC) always bottoms out at 4.
function getNumSlotsPreview(inputAmount: bigint, decimals: number): number {
  const amt = decimals === 18 ? inputAmount
    : decimals < 18 ? inputAmount * 10n ** BigInt(18 - decimals)
    : inputAmount / 10n ** BigInt(decimals - 18)
  if (amt <  500_000_000_000_000_000n)   return 4
  if (amt < 2_000_000_000_000_000_000n)  return 8
  if (amt < 10_000_000_000_000_000_000n) return 16
  if (amt < 50_000_000_000_000_000_000n) return 32
  return 64
}

// Express a raw wei amount as a percentage of the order's total input amount,
// capped at 100% (a single filler may individually quote up to the full order).
function pctOfOrder(amount: string, total: string): number {
  try {
    const t = BigInt(total)
    if (t <= 0n) return 0
    const a = BigInt(amount)
    const bps = a * 10000n / t
    return Math.min(100, Number(bps) / 100)
  } catch { return 0 }
}

function Stat({ label, value, accent, warn, good }: { label: string; value: React.ReactNode; accent?: boolean; warn?: boolean; good?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginBottom: 2 }}>{label}</div>
      <div style={{
        fontSize: '1.1rem', fontWeight: 700,
        color: warn ? '#d97706' : good ? '#16a34a' : accent ? '#7c3aed' : '#0f172a'
      }}>{value}</div>
    </div>
  )
}

// One row of the cross-chain preflight checklist — a single pass/fail check
// with a human-readable detail (revert reason, balance comparison, etc.).
function PreflightRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: '1px solid #f1f5f9', fontSize: '0.8rem' }}>
      <span style={{ color: '#475569' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>
        <span style={{ color: ok ? '#16a34a' : '#dc2626', fontWeight: 700 }}>{ok ? '✓' : '✗'}</span>
        {' '}
        <span style={{ color: '#94a3b8' }}>{detail}</span>
      </span>
    </div>
  )
}
