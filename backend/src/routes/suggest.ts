import { Router, Request, Response } from 'express'
import { ethers } from 'ethers'
import { getMarketRate } from '../services/marketRate'
import { simulateOrder } from '../services/fillerSim'

const router = Router()

// Candidate minFillBps values, ascending. Coverage is non-increasing in
// minFillBps (a higher per-fill minimum disqualifies more fillers), so we
// binary-search for the LARGEST candidate that still meets the coverage target —
// i.e. the least-fragmenting minimum that still keeps the order off the fallback.
const MIN_FILL_CANDIDATES = [100, 250, 500, 1000, 2000, 3000, 5000, 7000, 10000]
const UINT32_MAX = 4_294_967_295n

// human output-per-input rate -> contract startPrice (output = inputAmount * P / 1e18)
function rateToContract(rate: number, inDec: number, outDec: number): bigint {
  return (BigInt(Math.round(rate * 10 ** outDec)) * 10n ** 18n) / 10n ** BigInt(inDec)
}
function contractToHumanRate(p: bigint, inDec: number, outDec: number): number {
  return (Number(p) * 10 ** inDec) / (10 ** outDec * 1e18)
}

/// POST /suggest-params
/// body: { inputToken, outputToken, inputAmount, inputDecimals?, outputDecimals?,
///         inputSymbol?, outputSymbol?, deadlineBlocks?, targetCoverageBps?,
///         premiumBps?, slippageBps? }
router.post('/', async (req: Request, res: Response) => {
  const b = req.body as Record<string, any>
  if (!b.inputToken || !b.outputToken || !b.inputAmount) {
    res.status(400).json({ error: 'Missing required fields: inputToken, outputToken, inputAmount' })
    return
  }

  const inDec   = b.inputDecimals  != null ? Number(b.inputDecimals)  : 18
  const outDec  = b.outputDecimals != null ? Number(b.outputDecimals) : 6
  const inSym   = b.inputSymbol  || 'IN'
  const outSym  = b.outputSymbol || 'OUT'
  const inWei   = BigInt(b.inputAmount)
  const deadlineBlocks   = b.deadlineBlocks   != null ? Number(b.deadlineBlocks)   : 100
  const targetCoverageBps= b.targetCoverageBps!= null ? Number(b.targetCoverageBps): 9000  // 90%
  const premiumBps       = b.premiumBps       != null ? Number(b.premiumBps)       : 200   // +2% ask
  const slippageBps      = b.slippageBps      != null ? Number(b.slippageBps)      : 100   // -1% floor
  const rpc = process.env.RPC_URL || 'http://127.0.0.1:8545'

  // ── 1. market rate + current block ──
  let marketRate: number
  let currentBlock: number
  try {
    const provider = new ethers.providers.JsonRpcProvider(rpc)
    const [mq, blk] = await Promise.all([
      getMarketRate(b.inputToken, inDec, inSym, b.outputToken, outDec, outSym, inWei, rpc),
      provider.getBlockNumber(),
    ])
    marketRate   = mq.marketRate
    currentBlock = blk
  } catch (e: any) {
    res.status(503).json({ error: `Cannot price the pair: ${e.message}` })
    return
  }

  // ── 2. PRICE gate params (market-anchored) ──
  const startPrice = rateToContract(marketRate * (1 + premiumBps  / 10000), inDec, outDec) // optimistic ask, above market
  const floorPrice = rateToContract(marketRate * (1 - slippageBps / 10000), inDec, outDec) // worst acceptable
  const minOutput  = (inWei * floorPrice) / 10n ** 18n                                     // C-1 floor for the whole order
  const deadline   = currentBlock + deadlineBlocks
  let decay        = (startPrice - floorPrice) / BigInt(deadlineBlocks)                    // sweep ask -> floor over the window
  if (decay < 0n) decay = 0n
  if (decay > UINT32_MAX) decay = UINT32_MAX

  // ── 3. SIZE gate param: largest minFillBps that still covers >= target ──
  // Evaluate coverage at the FLOOR price near the deadline, where the price gate
  // is most open — so coverage reflects the size gate (capacity vs. minFill),
  // not whether the price has decayed enough yet.
  const coverageCache = new Map<number, number>()
  async function coverageAt(minFillBps: number): Promise<number> {
    if (coverageCache.has(minFillBps)) return coverageCache.get(minFillBps)!
    const sim = await simulateOrder({
      inputToken:   b.inputToken,
      outputToken:  b.outputToken,
      inputAmount:  b.inputAmount,
      startPrice:   floorPrice.toString(),
      decayPerBlock: 0,
      currentBlock: deadline - 10,   // blocksLeft = 10 (>= the strategy's 5-block cutoff)
      deadline,
      minFillBps,
    })
    coverageCache.set(minFillBps, sim.coverageBps)
    return sim.coverageBps
  }

  let lo = 0, hi = MIN_FILL_CANDIDATES.length - 1, best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (await coverageAt(MIN_FILL_CANDIDATES[mid]) >= targetCoverageBps) { best = mid; lo = mid + 1 }
    else hi = mid - 1
  }

  const chosenMinFillBps = best >= 0 ? MIN_FILL_CANDIDATES[best] : MIN_FILL_CANDIDATES[0]
  const projectedCoverageBps = await coverageAt(chosenMinFillBps)
  const meetsTarget = projectedCoverageBps >= targetCoverageBps

  const note = meetsTarget
    ? `Fillers can cover ~${(projectedCoverageBps / 100).toFixed(1)}% of the order at minFillBps=${chosenMinFillBps} (the largest minimum that still meets the ${(targetCoverageBps / 100).toFixed(0)}% target). Larger minimums would leave more to the fallback.`
    : `Even at the smallest minimum (minFillBps=${chosenMinFillBps}), registered fillers can only cover ~${(projectedCoverageBps / 100).toFixed(1)}% of this order — the remainder would route through the Uniswap fallback. Consider a smaller order, more fillers, or accepting the fallback.`

  res.json({
    // ready to drop straight into an order
    startPrice:      startPrice.toString(),
    minOutputAmount: minOutput.toString(),
    decayPerBlock:   Number(decay),
    deadline,
    minFillBps:      chosenMinFillBps,
    // context for the UI
    marketRate:          marketRate.toFixed(6),
    currentBlock,
    decayHuman:          contractToHumanRate(decay, inDec, outDec),
    startPriceHuman:     contractToHumanRate(startPrice, inDec, outDec),
    floorPriceHuman:     contractToHumanRate(floorPrice, inDec, outDec),
    projectedCoverageBps,
    meetsTarget,
    note,
  })
})

export default router
