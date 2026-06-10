import axios from 'axios'
import { BACKEND_URL, STRATEGY, SUPPORTED_TOKENS } from '../config'
import type { OrderInfo, FillDecision } from '../types'

// Fetches market rate from the backend /quote endpoint (AlphaRouter → CoinGecko fallback).
// Returns how many units of outputToken equal 1 full unit of inputToken.
async function getMarketPrice(inputToken: string, outputToken: string): Promise<number> {
  const inMeta  = SUPPORTED_TOKENS[inputToken]
  const outMeta = SUPPORTED_TOKENS[outputToken]
  if (!inMeta || !outMeta) throw new Error('unsupported token pair')

  const oneUnit = (10n ** BigInt(inMeta.decimals)).toString()
  const params  = new URLSearchParams({
    inputToken,
    outputToken,
    inputAmount:    oneUnit,
    inputDecimals:  String(inMeta.decimals),
    outputDecimals: String(outMeta.decimals),
    inputSymbol:    inMeta.symbol,
    outputSymbol:   outMeta.symbol,
  })
  const { data } = await axios.get(`${BACKEND_URL}/quote?${params}`)
  return parseFloat(data.marketRate)
}

// Decides whether to fill an order at the current block.
// Returns a FillDecision with shouldFill=true only when the fill is profitable.
export async function decide(order: OrderInfo, currentBlock: number): Promise<FillDecision> {
  const no = (reason: string): FillDecision =>
    ({ shouldFill: false, fillAmount: 0n, currentPrice: 0n, reason })

  const blocksLeft = order.deadline - currentBlock
  if (blocksLeft <= 0) return no('expired')
  if (blocksLeft < 5)  return no('too close to deadline — slash risk if registered')

  // ── Current decayed price (mirrors DecayCursorLib.getCurrentPrice) ──
  // The price cursor starts at the block of the FIRST fill, not order creation.
  // Before any fill → no decay has happened on-chain → price = startPrice.
  // After first fill → price decays from that block forward.
  const firstFillBlock = order.fills.length > 0
    ? (order.fills[order.fills.length - 1].blockNumber ?? currentBlock)
    : currentBlock

  const blocksPassed  = BigInt(Math.max(0, currentBlock - firstFillBlock))
  const startPrice    = BigInt(order.startPrice)
  const decay         = blocksPassed * BigInt(order.decayPerBlock)
  const currentPrice  = startPrice > decay ? startPrice - decay : 0n

  if (currentPrice === 0n) return no('price decayed to zero')

  // ── Fill amount (respects minFillBps floor) ──
  const inputAmount = BigInt(order.inputAmount)
  const fillAmount  = (inputAmount * BigInt(Math.round(STRATEGY.FILL_RATIO * 10_000))) / 10_000n
  const minFill     = (inputAmount * BigInt(order.minFillBps)) / 10_000n
  if (fillAmount < minFill) return no('computed fill below minFillBps — raise FILL_RATIO')

  // ── Profitability check ──
  // The filler RECEIVES fillAmount of inputToken from the swapper.
  // The filler GIVES expectedOutput of outputToken to the swapper.
  // Profit = market value of inputToken received − cost of outputToken given.
  const expectedOutput = (fillAmount * currentPrice) / BigInt(1e18)

  const inMeta  = SUPPORTED_TOKENS[order.inputToken]
  const outMeta = SUPPORTED_TOKENS[order.outputToken]
  if (!inMeta || !outMeta) return no('token not in SUPPORTED_TOKENS')

  let marketPrice: number
  try {
    marketPrice = await getMarketPrice(order.inputToken, order.outputToken)
  } catch {
    return no('price oracle unavailable')
  }

  const valueReceived = (Number(fillAmount)     / 10 ** inMeta.decimals)  * marketPrice
  const valuePaid     =  Number(expectedOutput) / 10 ** outMeta.decimals
  const profitBps     = ((valueReceived - valuePaid) / valueReceived) * 10_000

  if (profitBps < STRATEGY.MIN_PROFIT_BPS) {
    return no(`profit ${profitBps.toFixed(1)}bps < min ${STRATEGY.MIN_PROFIT_BPS}bps — waiting`)
  }

  return {
    shouldFill:   true,
    fillAmount,
    currentPrice,
    reason: `profit ~${profitBps.toFixed(0)}bps`,
  }
}
