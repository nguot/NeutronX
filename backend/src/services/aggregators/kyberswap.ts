import { AggregatorAdapter, AggregatorQuote, QuoteParams } from './types'

const KYBERSWAP_API = 'https://aggregator-api.kyberswap.com'
const SLIPPAGE_BPS = 50 // 0.5%, matches the other adapters

// KyberSwap's API is keyed by chain name (not chainId) in the URL path.
const CHAIN_NAMES: Record<number, string> = {
  1:     'ethereum',
  10:    'optimism',
  56:    'bsc',
  137:   'polygon',
  8453:  'base',
  42161: 'arbitrum',
  43114: 'avalanche',
}

interface KyberRouteResponse {
  data: { routeSummary: Record<string, unknown> }
}

interface KyberBuildResponse {
  data: { data: string; routerAddress: string; amountOut: string }
}

export const kyberswapAdapter: AggregatorAdapter = {
  key:  'kyberswap',
  name: 'KyberSwap',

  isAvailable(chainId: number): boolean {
    return chainId in CHAIN_NAMES
  },

  async getQuote(params: QuoteParams): Promise<AggregatorQuote | null> {
    const { chainId, tokenIn, tokenOut, amountIn, recipient, sender } = params
    const chain = CHAIN_NAMES[chainId]

    const routeQuery = new URLSearchParams({
      tokenIn:  tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: amountIn.toString(),
    })

    const routeRes = await fetch(`${KYBERSWAP_API}/${chain}/api/v1/routes?${routeQuery}`)
    if (!routeRes.ok) {
      console.warn(`KyberSwap route failed (${routeRes.status}): ${await routeRes.text().catch(() => '')}`)
      return null
    }
    const { data: { routeSummary } } = await routeRes.json() as KyberRouteResponse

    // routerAddress (MetaAggregationRouterV2) is both the approve target and the
    // call target — a single-address model, unlike ParaSwap's Augustus/tokenTransferProxy
    // split, so it fits FallbackExecutor's forceApprove(router, rem); router.call(...).
    const buildRes = await fetch(`${KYBERSWAP_API}/${chain}/api/v1/route/build`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeSummary,
        sender,
        recipient,
        slippageTolerance: SLIPPAGE_BPS,
      }),
    })
    if (!buildRes.ok) {
      // Unlike the /routes failure above, Kyber DID find a route here — it just
      // refused to build calldata for it (e.g. its wallet-screening rejects a
      // specific sender/recipient). That's a different failure mode than "no
      // route exists", so surface the real reason instead of a generic null.
      const body = await buildRes.text().catch(() => '')
      throw new Error(`KyberSwap route build failed (${buildRes.status}): ${body}`)
    }
    const { data } = await buildRes.json() as KyberBuildResponse

    const quotedOut    = BigInt(data.amountOut)
    const minAmountOut = quotedOut - (quotedOut * BigInt(SLIPPAGE_BPS)) / 10000n

    return {
      router:       data.routerAddress,
      calldata:     data.data,
      minAmountOut,
    }
  }
}
