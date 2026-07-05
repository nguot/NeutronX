import { AlphaRouter, SwapType } from '@uniswap/smart-order-router'
import { Protocol } from '@uniswap/router-sdk'
import { TradeType, CurrencyAmount, Token, Percent } from '@uniswap/sdk-core'
import { ethers } from 'ethers'
import { AggregatorAdapter, AggregatorQuote, QuoteParams } from './types'

const SLIPPAGE = new Percent(50, 10000) // 0.5%

// SwapRouter02 — what AlphaRouter generates calldata for under SwapType.SWAP_ROUTER_02.
// Must match the router seeded into FallbackExecutor's allowlist (see Deploy.s.sol).
const SWAP_ROUTER_02: Record<number, string> = {
  1: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
}

export const uniswapAdapter: AggregatorAdapter = {
  key:  'uniswap',
  name: 'Uniswap (Smart Order Router)',

  isAvailable(chainId: number): boolean {
    return chainId in SWAP_ROUTER_02
  },

  async getQuote(params: QuoteParams): Promise<AggregatorQuote | null> {
    const { chainId, rpcUrl, tokenIn, tokenOut, amountIn, recipient } = params

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
    const router = new AlphaRouter({ chainId, provider: provider as any })

    const tIn  = new Token(chainId, tokenIn.address,  tokenIn.decimals,  tokenIn.symbol)
    const tOut = new Token(chainId, tokenOut.address, tokenOut.decimals, tokenOut.symbol)
    const amount = CurrencyAmount.fromRawAmount(tIn, amountIn.toString())

    const route = await router.route(
      amount,
      tOut,
      TradeType.EXACT_INPUT,
      {
        type:              SwapType.SWAP_ROUTER_02,
        recipient,
        slippageTolerance: SLIPPAGE,
        deadline:          Math.floor(Date.now() / 1000) + 300,
      },
      // SwapRouter02 can't execute V4 pools anyway, and the V4 subgraph
      // provider hits the deprecated hosted Graph service and throws — cap
      // routing to V2/V3 so it never fetches V4 candidate pools at all.
      { protocols: [Protocol.V2, Protocol.V3] }
    )

    if (!route || !route.methodParameters) return null

    return {
      router:       SWAP_ROUTER_02[chainId],
      calldata:     route.methodParameters.calldata,
      minAmountOut: BigInt(route.trade.minimumAmountOut(SLIPPAGE).quotient.toString()),
    }
  }
}
