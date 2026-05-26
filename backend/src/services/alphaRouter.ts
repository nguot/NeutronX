import { AlphaRouter, SwapType } from '@uniswap/smart-order-router'
import { TradeType, CurrencyAmount, Token, Percent } from '@uniswap/sdk-core'
import { ethers } from 'ethers'
const CHAIN_ID = 1

export async function getRoute(
  tokenIn:  { address: string; decimals: number; symbol: string },
  tokenOut: { address: string; decimals: number; symbol: string },
  amountIn: bigint,
  recipient: string,
  rpcUrl:   string
): Promise<{ calldata: string; minAmountOut: bigint }> {

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
  const router   = new AlphaRouter({ chainId: CHAIN_ID, provider: provider as any })

  const tIn  = new Token(CHAIN_ID, tokenIn.address,  tokenIn.decimals,  tokenIn.symbol)
  const tOut = new Token(CHAIN_ID, tokenOut.address, tokenOut.decimals, tokenOut.symbol)

  const amount = CurrencyAmount.fromRawAmount(tIn, amountIn.toString())

  const route = await router.route(
    amount,
    tOut,
    TradeType.EXACT_INPUT,
    {
      type:             SwapType.SWAP_ROUTER_02,
      recipient:        recipient,
      slippageTolerance: new Percent(50, 10000), // 0.5%
      deadline:         Math.floor(Date.now() / 1000) + 300,
    }
  )

  if (!route) throw new Error('No route found')

  return {
    calldata:     route.methodParameters!.calldata,
    minAmountOut: BigInt(route.trade.minimumAmountOut(new Percent(50, 10000)).quotient.toString()),
  }
}