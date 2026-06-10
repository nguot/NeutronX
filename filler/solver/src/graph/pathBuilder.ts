import type { OrderInfo, FillPath, PathStep } from '../types'

// ─── IMPLEMENT THIS ───────────────────────────────────────────────────────────
// Describe HOW you will source the output tokens for this fill.
// The returned PathStep[] is reported back to the backend (fills.path column)
// so users can see where liquidity came from.
//
// Three common archetypes:
//   'private' — your own inventory, no DEX swap needed
//   'public'  — routed through a public DEX pool (Uniswap V3, Curve, etc.)
//   'cow'     — CoW Protocol or private matching
//
// outputAmount must be >= what the reactor will demand for this fill.
// Use the same formula as strategy.ts: fillAmount * currentPrice / 1e18
// ─────────────────────────────────────────────────────────────────────────────

export async function buildPath(
  order:        OrderInfo,
  fillAmount:   bigint,
  currentPrice: bigint   // decayed price from strategy.decide(), scaled 1e18
): Promise<FillPath> {

  // ── Default: private inventory filler ────────────────────────────────────
  // You already hold outputToken. No swap needed before executing the fill.
  const outputAmount = (fillAmount * currentPrice) / BigInt(1e18)

  const steps: PathStep[] = [
    {
      tokenIn:  order.inputToken,
      tokenOut: order.outputToken,
      pool:     '0x0000000000000000000000000000000000000000',  // no pool — own inventory
      type:     'private',
    },
  ]

  return { steps, outputAmount }

  // ── Uniswap V3 example ────────────────────────────────────────────────────
  // Buy outputToken from Uniswap before executing the fill, then report the route.
  //
  // const route = await alphaRouter.route(
  //   CurrencyAmount.fromRawAmount(tokenIn, fillAmount.toString()),
  //   tokenOut,
  //   TradeType.EXACT_INPUT,
  //   { type: SwapType.SWAP_ROUTER_02, recipient: wallet.address, ... }
  // )
  //
  // const steps: PathStep[] = route.route[0].tokenPath.slice(0, -1).map((token, i) => ({
  //   tokenIn:  token.address,
  //   tokenOut: route.route[0].tokenPath[i + 1].address,
  //   pool:     route.route[0].route.pools[i].address,
  //   type:     'public' as const,
  // }))
  //
  // return {
  //   steps,
  //   outputAmount: BigInt(route.trade.outputAmount.quotient.toString()),
  // }
}
