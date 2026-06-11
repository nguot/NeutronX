import { Router, Request, Response } from 'express'
import { fillerRegistry } from '../services/fillerRegistry'

const router = Router()

interface QuoteRequest {
  inputToken:    string
  outputToken:   string
  inputAmount:   string
  startPrice:    string
  decayPerBlock: number
  currentBlock?: number
  deadline?:     number
  minFillBps?:   number
}

interface FillerQuote {
  filler:          string
  wouldFill:       boolean
  fillAmount:      string
  fillAmountHuman: string
  auctionPrice:    string
  reason:          string
  metadata:        Record<string, unknown>
  error?:          string
}

async function fetchQuote(fillerUrl: string, body: QuoteRequest): Promise<FillerQuote> {
  const res = await fetch(`${fillerUrl}/quote`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<FillerQuote>
}

router.post('/', async (req: Request, res: Response) => {
  const body: QuoteRequest = req.body

  if (!body.inputToken || !body.outputToken || !body.inputAmount || !body.startPrice || body.decayPerBlock == null) {
    res.status(400).json({ error: 'Missing required fields: inputToken, outputToken, inputAmount, startPrice, decayPerBlock' })
    return
  }

  const FILLER_URLS = fillerRegistry.list()

  // Query all fillers concurrently; never let one failure block the rest
  const results = await Promise.allSettled(
    FILLER_URLS.map(f => fetchQuote(f.url, body))
  )

  const quotes: FillerQuote[] = results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value
    return {
      filler:          FILLER_URLS[i].name,
      wouldFill:       false,
      fillAmount:      '0',
      fillAmountHuman: '0 WETH',
      auctionPrice:    '0 USDC',
      reason:          'filler unreachable',
      metadata:        {},
      error:           (result.reason as Error).message,
    }
  })

  const inputAmount = BigInt(body.inputAmount)

  // Each registered filler is queried independently with the FULL order
  // amount, so a filler willing to take 100% reports fillAmount=inputAmount.
  // Summing those raw quotes would double- (or N-) count the same liquidity,
  // so cap the aggregate at the order size.
  const totalFillRaw = quotes.reduce(
    (sum, q) => (q.wouldFill ? sum + BigInt(q.fillAmount) : sum),
    0n
  )
  const totalFill = totalFillRaw > inputAmount ? inputAmount : totalFillRaw
  const remaining = inputAmount - totalFill

  const inDecimals = 18
  const toHuman = (raw: bigint) => (Number(raw) / 10 ** inDecimals).toFixed(4)

  res.json({
    inputToken:        body.inputToken,
    outputToken:       body.outputToken,
    inputAmount:       body.inputAmount,
    quotes,
    totalFillAmount:   totalFill.toString(),
    totalFillHuman:    `${toHuman(totalFill)} WETH`,
    remainingAmount:   remaining.toString(),
    remainingHuman:    `${toHuman(remaining)} WETH`,
    remainingWouldFallback: remaining > 0n,
  })
})

export default router

// bảo nó là frontend hiện Oxy tọa độ luôn thể hiện dutch auction, bắn event từ indexer  
// 1 api ping để biết filler sống