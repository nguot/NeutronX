import { AggregatorAdapter, AggregatorQuote, QuoteParams } from './types'

// AggregationRouterV6 — deployed at the same address on every chain 1inch supports.
const ONEINCH_ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65'
const SLIPPAGE_PCT = '0.5' // 0.5%, matches the other adapters

interface OneInchSwapResponse {
  dstAmount: string
  tx: { to: string; data: string }
}

export const oneInchAdapter: AggregatorAdapter = {
  key:  '1inch',
  name: '1inch',

  isAvailable(_chainId: number): boolean {
    return !!process.env.ONEINCH_API_KEY
  },

  async getQuote(params: QuoteParams): Promise<AggregatorQuote | null> {
    const apiKey = process.env.ONEINCH_API_KEY
    if (!apiKey) return null

    const { chainId, tokenIn, tokenOut, amountIn, recipient, sender } = params

    const query = new URLSearchParams({
      src:             tokenIn.address,
      dst:             tokenOut.address,
      amount:          amountIn.toString(),
      from:            sender,
      receiver:        recipient,
      slippage:        SLIPPAGE_PCT,
      disableEstimate: 'true',
    })

    const res = await fetch(`https://api.1inch.dev/swap/v6.0/${chainId}/swap?${query}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) {
      console.warn(`1inch quote failed (${res.status}): ${await res.text().catch(() => '')}`)
      return null
    }

    const data = await res.json() as OneInchSwapResponse
    const dstAmount = BigInt(data.dstAmount)
    const minAmountOut = dstAmount - (dstAmount * 50n) / 10000n // -0.5%

    return {
      router:       data.tx.to ?? ONEINCH_ROUTER,
      calldata:     data.tx.data,
      minAmountOut,
    }
  }
}
