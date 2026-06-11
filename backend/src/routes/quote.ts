import { Router, Request, Response } from 'express'
import { AlphaRouter, SwapType } from '@uniswap/smart-order-router'
import { TradeType, CurrencyAmount, Token, Percent } from '@uniswap/sdk-core'
import { ethers } from 'ethers'

const router = Router()
const CHAIN_ID = 1
const DUMMY_RECIPIENT = '0x0000000000000000000000000000000000000001'

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

async function quoteFromAlphaRouter(
  inputToken:  string, inputDecimals:  number, inputSymbol:  string,
  outputToken: string, outputDecimals: number, outputSymbol: string,
  inputAmountWei: bigint,
  rpcUrl: string,
) {
  const provider    = new ethers.providers.JsonRpcProvider(rpcUrl)
  const alphaRouter = new AlphaRouter({ chainId: CHAIN_ID, provider: provider as any })
  const tIn  = new Token(CHAIN_ID, inputToken,  inputDecimals,  inputSymbol)
  const tOut = new Token(CHAIN_ID, outputToken, outputDecimals, outputSymbol)
  const amount = CurrencyAmount.fromRawAmount(tIn, inputAmountWei.toString())

  const route = await alphaRouter.route(amount, tOut, TradeType.EXACT_INPUT, {
    type:              SwapType.SWAP_ROUTER_02,
    recipient:         DUMMY_RECIPIENT,
    slippageTolerance: new Percent(50, 10000),
    deadline:          Math.floor(Date.now() / 1000) + 300,
  })

  if (!route) throw new Error('No route found')

  const estOut    = BigInt(route.trade.outputAmount.quotient.toString())
  const impact    = route.trade.priceImpact.toFixed(2)
  return { estOut, impact, source: 'alpha_router' as const }
}

async function fetchTokenPriceUsd(address: string): Promise<number | undefined> {
  const url = `https://api.coingecko.com/api/v3/simple/token_price/ethereum` +
    `?contract_addresses=${address.toLowerCase()}&vs_currencies=usd`
  const res  = await withTimeout(fetch(url), 5000)
  const data = await res.json() as Record<string, { usd: number }>
  return data[address.toLowerCase()]?.usd
}

async function quoteFromCoinGecko(
  inputToken:  string, inputDecimals:  number,
  outputToken: string, outputDecimals: number,
  inputAmountWei: bigint,
) {
  // CoinGecko's free tier caps /simple/token_price at one contract address per
  // request, so the two tokens must be fetched separately rather than batched.
  const [pIn, pOut] = await Promise.all([fetchTokenPriceUsd(inputToken), fetchTokenPriceUsd(outputToken)])
  if (!pIn || !pOut) throw new Error('Token not found on CoinGecko')

  const inHuman  = Number(inputAmountWei) / 10 ** inputDecimals
  const outHuman = inHuman * pIn / pOut
  const estOut   = BigInt(Math.floor(outHuman * 10 ** outputDecimals))
  return { estOut, impact: null, source: 'coingecko' as const }
}

// GET /quote?inputToken=0x...&outputToken=0x...&inputAmount=wei&inputDecimals=18&outputDecimals=6&inputSymbol=WETH&outputSymbol=USDC
router.get('/', async (req: Request, res: Response) => {
  const { inputToken, outputToken, inputAmount, inputDecimals, outputDecimals, inputSymbol, outputSymbol } =
    req.query as Record<string, string>

  if (!inputToken || !outputToken || !inputAmount || !inputDecimals || !outputDecimals) {
    res.status(400).json({ error: 'Missing required params: inputToken, outputToken, inputAmount, inputDecimals, outputDecimals' })
    return
  }

  const inDec  = parseInt(inputDecimals)
  const outDec = parseInt(outputDecimals)
  const inWei  = BigInt(inputAmount)
  const rpc    = process.env.RPC_URL || 'http://127.0.0.1:8545'

  let estOut: bigint
  let impact: string | null
  let source: string

  try {
    const r = await withTimeout(
      quoteFromAlphaRouter(inputToken, inDec, inputSymbol || 'IN', outputToken, outDec, outputSymbol || 'OUT', inWei, rpc),
      8000,
    )
    estOut = r.estOut; impact = r.impact; source = r.source
  } catch {
    try {
      const r = await quoteFromCoinGecko(inputToken, inDec, outputToken, outDec, inWei)
      estOut = r.estOut; impact = r.impact; source = r.source
    } catch (e: any) {
      res.status(503).json({ error: `Quote unavailable: ${e.message}` })
      return
    }
  }

  const inHuman  = Number(inWei)  / 10 ** inDec
  const outHuman = Number(estOut) / 10 ** outDec

  res.json({
    estimatedOutput:      estOut.toString(),
    estimatedOutputHuman: outHuman.toFixed(outDec <= 6 ? 2 : 6),
    marketRate:           (outHuman / inHuman).toFixed(4),
    priceImpact:          impact,
    source,
  })
})

export default router
