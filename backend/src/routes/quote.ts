import { Router, Request, Response } from 'express'
import { getMarketRate } from '../services/marketRate'

const router = Router()

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

  try {
    const q = await getMarketRate(inputToken, inDec, inputSymbol || 'IN', outputToken, outDec, outputSymbol || 'OUT', inWei, rpc)
    const outHuman = Number(q.estOut) / 10 ** outDec
    res.json({
      estimatedOutput:      q.estOut.toString(),
      estimatedOutputHuman: outHuman.toFixed(outDec <= 6 ? 2 : 6),
      marketRate:           q.marketRate.toFixed(4),
      priceImpact:          q.impact,
      source:               q.source,
    })
  } catch (e: any) {
    res.status(503).json({ error: `Quote unavailable: ${e.message}` })
  }
})

export default router
