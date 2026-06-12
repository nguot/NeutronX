import { DEV_MODE, INVENTORY, SUPPORTED_TOKENS } from '../config'
import { erc20, wallet } from '../contract/contracts'
import { getOrderbook, logOrderbook } from '../orderbook/mockOrderbook'
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

  const auctionPriceHuman = Number(currentPrice) / 10 ** outMeta.decimals
  console.log(
    `${tag} ${sym(order.inputToken)}→${sym(order.outputToken)}` +
    `  auctionPrice=${auctionPriceHuman.toFixed(4)}  blocksLeft=${blocksLeft}`
  )

  // ── DEV_MODE: skip orderbook/profit checks, but still size by real capacity ──
  // so a large order no single filler can afford is filled across fillers in
  // partial chunks (instead of blindly attempting 100% and reverting on payout).
  if (DEV_MODE) {
    const inputAmount   = BigInt(order.inputAmount)
    const outputBalance = (await erc20(order.outputToken).balanceOf(wallet.address)).toBigInt()
    const usable        = (outputBalance * BigInt(INVENTORY.MAX_INVENTORY_USE_BPS)) / 10_000n
    const capacity      = (usable * 10n ** 18n) / currentPrice
    const fillAmount    = capacity < inputAmount ? capacity : inputAmount
    if (fillAmount === 0n) return no('zero inventory of outputToken (dev)')

    const pct = (Number(fillAmount) / Number(inputAmount) * 100).toFixed(1)
    console.log(`${tag} ✔ FILL [DEV]  fill=${pct}% (capacity-capped)  price=${auctionPriceHuman.toFixed(4)}`)
    return { shouldFill: true, fillAmount, currentPrice, reason: 'dev mode (capacity-capped)' }
  }

  // ── Orderbook lookup ──────────────────────────────────────────────────────
  const book = getOrderbook(order.inputToken, order.outputToken)
  if (!book) return no(`no orderbook for ${sym(order.inputToken)}→${sym(order.outputToken)}`)

  // ── Inventory capacity ────────────────────────────────────────────────────
  const outputBalance   = (await erc20(order.outputToken).balanceOf(wallet.address)).toBigInt()
  if (outputBalance === 0n) return no('zero inventory of outputToken')

  const usableBalance        = (outputBalance * BigInt(INVENTORY.MAX_INVENTORY_USE_BPS)) / 10_000n
  const inventoryCapacity    = (usableBalance * 10n**18n) / currentPrice
  const inputAmount          = BigInt(order.inputAmount)
  const available            = inventoryCapacity < inputAmount ? inventoryCapacity : inputAmount

  const minFill = (inputAmount * BigInt(order.minFillBps)) / 10_000n

  // ── Greedy match against orderbook ────────────────────────────────────────
  const result = match(currentPrice, available, book.bids)

  if (!result) {
    logOrderbook(book)
    return no(`no profitable bids — best bid must be above auction price ${auctionPriceHuman.toFixed(4)}`)
  }

  if (result.fillAmount < minFill) {
    return no(`match fills ${result.fillAmount} < minFill ${minFill}`)
  }

  if (result.estimatedProfit < BigInt(INVENTORY.MIN_PROFIT_RAW)) {
    return no(`profit ${result.estimatedProfit} < min ${INVENTORY.MIN_PROFIT_RAW}`)
  }

  const fillHuman   = (Number(result.fillAmount)      / 10 ** inMeta.decimals).toFixed(4)
  const profitHuman = (Number(result.estimatedProfit) / 10 ** outMeta.decimals).toFixed(4)
  const balHuman    = (Number(outputBalance)           / 10 ** outMeta.decimals).toFixed(2)

  console.log(
    `${tag} ✔ FILL  fill=${fillHuman} ${inMeta.symbol}` +
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
