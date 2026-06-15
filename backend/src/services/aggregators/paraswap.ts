import { AggregatorAdapter, AggregatorQuote, QuoteParams } from './types'

const PARASWAP_API = 'https://apiv5.paraswap.io'
const SLIPPAGE_BPS = 50n // 0.5%, matches the other adapters

// Chains ParaSwap's public API serves — no API key required.
const SUPPORTED_CHAINS = new Set([1, 10, 56, 137, 250, 1101, 8453, 42161, 43114])

interface ParaSwapPriceResponse {
  priceRoute: { destAmount: string; tokenTransferProxy: string }
}

interface ParaSwapTransactionResponse {
  to:   string
  data: string
}

export const paraswapAdapter: AggregatorAdapter = {
  key:  'paraswap',
  name: 'ParaSwap',

  isAvailable(chainId: number): boolean {
    return SUPPORTED_CHAINS.has(chainId)
  },

  async getQuote(params: QuoteParams): Promise<AggregatorQuote | null> {
    const { chainId, tokenIn, tokenOut, amountIn, recipient, sender } = params

    const priceQuery = new URLSearchParams({
      srcToken:     tokenIn.address,
      srcDecimals:  String(tokenIn.decimals),
      destToken:    tokenOut.address,
      destDecimals: String(tokenOut.decimals),
      amount:       amountIn.toString(),
      side:         'SELL',
      network:      String(chainId),
    })

    const priceRes = await fetch(`${PARASWAP_API}/prices?${priceQuery}`)
    if (!priceRes.ok) {
      console.warn(`ParaSwap price failed (${priceRes.status}): ${await priceRes.text().catch(() => '')}`)
      return null
    }
    const { priceRoute } = await priceRes.json() as ParaSwapPriceResponse

    const destAmount   = BigInt(priceRoute.destAmount)
    const minAmountOut = destAmount - (destAmount * SLIPPAGE_BPS) / 10000n

    // NOTE: ParaSwap expects callers to approve `priceRoute.tokenTransferProxy` (a
    // separate contract from Augustus, returned as `to` below) before calling the
    // swap. FallbackExecutor.forceApprove's a single `router` address that it then
    // calls — a two-address model it can't express yet, so this adapter's quotes
    // aren't executable via executeFallback without a small contract change.
    const txRes = await fetch(`${PARASWAP_API}/transactions/${chainId}?ignoreChecks=true`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        srcToken:     tokenIn.address,
        srcDecimals:  tokenIn.decimals,
        destToken:    tokenOut.address,
        destDecimals: tokenOut.decimals,
        srcAmount:    amountIn.toString(),
        destAmount:   minAmountOut.toString(),
        priceRoute,
        userAddress:  sender,
        receiver:     recipient,
      }),
    })
    if (!txRes.ok) {
      console.warn(`ParaSwap transaction build failed (${txRes.status}): ${await txRes.text().catch(() => '')}`)
      return null
    }
    const tx = await txRes.json() as ParaSwapTransactionResponse

    return {
      router:       tx.to,
      calldata:     tx.data,
      minAmountOut,
    }
  }
}
