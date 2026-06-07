import type { BidLevel } from '../orderbook/mockOrderbook'

export interface MatchResult {
  fillAmount:       bigint  // raw inputToken to fill on NeutronX
  estimatedProfit:  bigint  // raw outputToken profit = CEX revenue - NeutronX cost
  matchedLevels:    number  // bid levels consumed
}

// Greedy matching: walk bids from best to worst, fill as long as profitable.
//
// Profit at each level:
//   revenue (from CEX buyer) = take * bid.price / 1e18   (raw outputToken)
//   cost    (to NeutronX)    = take * auctionPrice / 1e18 (raw outputToken)
//   profit  = revenue - cost = take * (bid.price - auctionPrice) / 1e18
//
// Greedy is optimal here because per-unit profit at each level is fixed —
// no price impact, no slippage. Always take the best bids first.
export function match(
  auctionPrice: bigint,   // current Dutch auction price (same format as bid.price)
  available:    bigint,   // max fillAmount (raw inputToken) — min(onChainRemaining, inventory)
  bids:         BidLevel[], // sorted descending by price
): MatchResult | null {
  let remaining      = available
  let fillAmount     = 0n
  let totalRevenue   = 0n
  let totalCost      = 0n
  let matchedLevels  = 0

  for (const bid of bids) {
    if (bid.price <= auctionPrice) break  // no profit from here down

    const take     = bid.size < remaining ? bid.size : remaining
    const revenue  = (take * bid.price)       / 10n**18n
    const cost     = (take * auctionPrice)    / 10n**18n

    fillAmount    += take
    totalRevenue  += revenue
    totalCost     += cost
    remaining     -= take
    matchedLevels++

    if (remaining === 0n) break
  }

  if (fillAmount === 0n) return null

  return {
    fillAmount,
    estimatedProfit: totalRevenue - totalCost,
    matchedLevels,
  }
}
