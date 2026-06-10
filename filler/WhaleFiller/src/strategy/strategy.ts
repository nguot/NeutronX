import { DEV_MODE, INVENTORY, REFERENCE_PRICES, SUPPORTED_TOKENS } from '../config'
import { erc20, wallet } from '../contract/contracts'
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

  // ── DEV_MODE: skip spread + inventory checks, fill 100% ──────────────────
  if (DEV_MODE) {
    const inputAmount = BigInt(order.inputAmount)
    console.log(`${tag} ✔ FILL [DEV]  fill=100%  price=${auctionPriceHuman.toFixed(4)}`)
    return { shouldFill: true, fillAmount: inputAmount, currentPrice, reason: 'dev mode' }
  }

  // ── Market spread check ───────────────────────────────────────────────────
  const refPrice = REFERENCE_PRICES[order.inputToken]?.[order.outputToken]
  if (!refPrice) return no(`no reference price for ${sym(order.inputToken)}→${sym(order.outputToken)}`)

  const refPriceHuman = Number(refPrice) / 10 ** outMeta.decimals
  if (currentPrice >= refPrice) {
    return no(`auction ${auctionPriceHuman.toFixed(4)} >= market ${refPriceHuman.toFixed(4)} — not profitable yet`)
  }

  const spreadBps = (refPrice - currentPrice) * 10_000n / refPrice
  if (spreadBps < BigInt(INVENTORY.MIN_SPREAD_BPS)) {
    return no(`spread ${spreadBps}bps < min ${INVENTORY.MIN_SPREAD_BPS}bps`)
  }

  // ── Inventory capacity check ──────────────────────────────────────────────
  const outputBalance   = (await erc20(order.outputToken).balanceOf(wallet.address)).toBigInt()
  if (outputBalance === 0n) return no('zero inventory of outputToken')

  const usableBalance        = (outputBalance * BigInt(INVENTORY.MAX_INVENTORY_USE_BPS)) / 10_000n
  const maxFillFromInventory = (usableBalance * 10n**18n) / currentPrice
  if (maxFillFromInventory === 0n) return no('inventory too small')

  const inputAmount = BigInt(order.inputAmount)
  const minFill     = (inputAmount * BigInt(order.minFillBps)) / 10_000n
  const fillAmount  = maxFillFromInventory < inputAmount ? maxFillFromInventory : inputAmount

  if (fillAmount < minFill) {
    return no(`inventory covers ${fillAmount} < minFill ${minFill}`)
  }

  const fillHuman = (Number(fillAmount) / 10 ** inMeta.decimals).toFixed(4)
  const balHuman  = (Number(outputBalance) / 10 ** outMeta.decimals).toFixed(2)
  console.log(
    `${tag} ✔ FILL  fill=${fillHuman} ${inMeta.symbol}` +
    `  spread=${spreadBps}bps  inventory=${balHuman} ${outMeta.symbol}` +
    `  using ${INVENTORY.MAX_INVENTORY_USE_BPS / 100}% of balance`
  )

  return {
    shouldFill: true,
    fillAmount,
    currentPrice,
    reason: `spread=${spreadBps}bps | inventory=${balHuman} ${outMeta.symbol}`,
    extras: { spreadBps: Number(spreadBps), inventoryHuman: balHuman },
  }
}
