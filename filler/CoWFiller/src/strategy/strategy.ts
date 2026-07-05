import { INVENTORY, SUPPORTED_TOKENS } from '../config'
import { erc20, wallet } from '../contract/contracts'
import { getOrderbook } from '../orderbook/mockOrderbook'
import { match } from '../matching/matcher'
import type { OrderInfo, FillDecision } from '../types'

function sym(address: string): string {
  return SUPPORTED_TOKENS[address]?.symbol ?? address.slice(0, 8) + '…'
}

export async function decide(order: OrderInfo, currentBlock: number): Promise<FillDecision> {
  const tag = `[Strategy] ${order.hash.slice(0, 10)}…`
  const no = (reason: string): FillDecision => {
    console.log(`${tag} SKIP — ${reason}`)
    return { shouldFill: false, fillAmount: 0n, currentPrice: 0n, reason }
  }

  const blocksLeft = order.deadline - currentBlock
  if (blocksLeft <= 0) return no('expired')
  if (blocksLeft < 5)  return no('too close to deadline')

  // ── Current decayed auction price ─────────────────────────────────────────
  const firstFillBlock = order.fills.length > 0
    ? (order.fills[order.fills.length - 1].blockNumber ?? currentBlock)
    : currentBlock
  const blocksPassed = BigInt(Math.max(0, currentBlock - firstFillBlock))
  const startPrice   = BigInt(order.startPrice)
  const decay        = blocksPassed * BigInt(order.decayPerBlock)
  const currentPrice = startPrice > decay ? startPrice - decay : 0n
  if (currentPrice === 0n) return no('price decayed to zero')

  const outMeta = SUPPORTED_TOKENS[order.outputToken]
  const inMeta  = SUPPORTED_TOKENS[order.inputToken]
  if (!outMeta || !inMeta) return no('unsupported token pair')

  const inputAmount        = BigInt(order.inputAmount)
  const auctionPriceHuman  = Number(currentPrice) / 10 ** outMeta.decimals
  const inputAmountHuman   = (Number(inputAmount) / 10 ** inMeta.decimals).toFixed(4)
  console.log(
    `${tag} swapper selling ${inputAmountHuman} ${sym(order.inputToken)} → ${sym(order.outputToken)}` +
    `  auctionPrice=${auctionPriceHuman.toFixed(4)}  blocksLeft=${blocksLeft}`
  )

  // ── Orderbook lookup ──────────────────────────────────────────────────────
  const book = await getOrderbook(order.inputToken, order.outputToken)
  if (!book) return no(`no orderbook for ${sym(order.inputToken)}→${sym(order.outputToken)}`)

  // ── Inventory capacity ────────────────────────────────────────────────────
  const outputBalance   = (await erc20(order.outputToken).balanceOf(wallet.address)).toBigInt()
  if (outputBalance === 0n) return no('zero inventory of outputToken')

  const usableBalance     = (outputBalance * BigInt(INVENTORY.MAX_INVENTORY_USE_BPS)) / 10_000n
  const inventoryCapacity = (usableBalance * 10n**18n) / currentPrice
  const available         = inventoryCapacity < inputAmount ? inventoryCapacity : inputAmount
  const availableHuman    = (Number(available) / 10 ** inMeta.decimals).toFixed(4)

  // ── Match against orderbook — 100% fill only ──────────────────────────────
  // This filler no longer takes a partial slice of the book: either the bids
  // fully cover `available` (the whole order, or as much of it as inventory
  // allows) profitably, or it skips the order entirely. That supersedes the
  // old minFillBps partial-fill floor — a 100% match always clears it.
  const result = match(currentPrice, available, book.bids)

  if (!result) {
    const bestBid = book.bids[0]
    const bestBidHuman = bestBid ? (Number(bestBid.price) / 10 ** outMeta.decimals).toFixed(4) : 'none'
    return no(`best bid ${bestBidHuman} <= auction price ${auctionPriceHuman.toFixed(4)} — not profitable`)
  }

  if (result.fillAmount < available) {
    const gotHuman = (Number(result.fillAmount) / 10 ** inMeta.decimals).toFixed(4)
    return no(`book depth covers only ${gotHuman} of ${availableHuman} ${inMeta.symbol} — need a 100% fill`)
  }

  if (result.estimatedProfit < BigInt(INVENTORY.MIN_PROFIT_RAW)) {
    return no(`profit ${result.estimatedProfit} < min ${INVENTORY.MIN_PROFIT_RAW}`)
  }

  const fillHuman   = (Number(result.fillAmount)      / 10 ** inMeta.decimals).toFixed(4)
  const profitHuman = (Number(result.estimatedProfit) / 10 ** outMeta.decimals).toFixed(4)
  const balHuman    = (Number(outputBalance)           / 10 ** outMeta.decimals).toFixed(2)

  console.log(
    `${tag} ✔ FILL (100%)  fill=${fillHuman} ${inMeta.symbol}` +
    `  profit=${profitHuman} ${outMeta.symbol}` +
    `  levels=${result.matchedLevels}  inventory=${balHuman} ${outMeta.symbol}`
  )

  return {
    shouldFill: true,
    fillAmount: result.fillAmount,
    currentPrice,
    reason: `profit=${profitHuman} ${outMeta.symbol} | levels=${result.matchedLevels} | inventory=${balHuman} ${outMeta.symbol}`,
    extras: { estimatedProfit: profitHuman, matchedLevels: result.matchedLevels, inventoryHuman: balHuman },
  }
}
