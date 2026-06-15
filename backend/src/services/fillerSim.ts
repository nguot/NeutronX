import { fillerRegistry } from './fillerRegistry'

export interface SimQuoteRequest {
  inputToken:    string
  outputToken:   string
  inputAmount:   string
  startPrice:    string
  decayPerBlock: number
  currentBlock?: number
  deadline?:     number
  minFillBps?:   number
}

export interface FillerQuote {
  filler:          string
  wouldFill:       boolean
  fillAmount:      string
  fillAmountHuman: string
  auctionPrice:    string
  reason:          string
  metadata:        Record<string, unknown>
  error?:          string
}

export interface SimResult {
  inputToken:             string
  outputToken:            string
  inputAmount:            string
  quotes:                 FillerQuote[]
  totalFillAmount:        string
  totalFillHuman:         string
  remainingAmount:        string
  remainingHuman:         string
  remainingWouldFallback: boolean
  coverageBps:            number   // totalFill / inputAmount, in bps
}

async function fetchQuote(fillerUrl: string, body: SimQuoteRequest): Promise<FillerQuote> {
  const res = await fetch(`${fillerUrl}/quote`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<FillerQuote>
}

/// Replays an order against every registered filler's /quote (their decide()),
/// and aggregates how much of the order they would collectively fill. Each filler
/// is queried with the full order, so the aggregate is capped at the order size
/// to avoid double-counting the same liquidity. This is the single source of
/// truth for both POST /simulate and the parameter-suggestion coverage search.
export async function simulateOrder(body: SimQuoteRequest): Promise<SimResult> {
  const fillers = await fillerRegistry.list()

  const results = await Promise.allSettled(fillers.map(f => fetchQuote(f.url, body)))

  const quotes: FillerQuote[] = results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value
    return {
      filler:          fillers[i].name,
      wouldFill:       false,
      fillAmount:      '0',
      fillAmountHuman: '0 WETH',
      auctionPrice:    '0 USDC',
      reason:          'filler unreachable',
      metadata:        {},
      error:           (result.reason as Error).message,
    }
  })

  const inputAmount  = BigInt(body.inputAmount)
  const totalFillRaw = quotes.reduce((sum, q) => (q.wouldFill ? sum + BigInt(q.fillAmount) : sum), 0n)
  const totalFill    = totalFillRaw > inputAmount ? inputAmount : totalFillRaw
  const remaining    = inputAmount - totalFill

  const inDecimals = 18
  const toHuman = (raw: bigint) => (Number(raw) / 10 ** inDecimals).toFixed(4)

  return {
    inputToken:             body.inputToken,
    outputToken:            body.outputToken,
    inputAmount:            body.inputAmount,
    quotes,
    totalFillAmount:        totalFill.toString(),
    totalFillHuman:         `${toHuman(totalFill)} WETH`,
    remainingAmount:        remaining.toString(),
    remainingHuman:         `${toHuman(remaining)} WETH`,
    remainingWouldFallback: remaining > 0n,
    coverageBps:            inputAmount > 0n ? Number((totalFill * 10000n) / inputAmount) : 0,
  }
}
