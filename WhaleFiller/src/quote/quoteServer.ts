import http from 'http'
import { provider } from '../contract/contracts'
import { decide } from '../strategy/strategy'
import type { OrderInfo } from '../types'
import * as dotenv from 'dotenv'
dotenv.config()

const FILLER_NAME = 'WhaleFiller'
const PORT = parseInt(process.env.QUOTE_PORT ?? '3001')

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

function buildFakeOrder(req: QuoteRequest, currentBlock: number): OrderInfo {
  return {
    hash:          '0x' + '0'.repeat(64),
    swapper:       '0x' + '0'.repeat(40),
    inputToken:    req.inputToken,
    outputToken:   req.outputToken,
    inputAmount:   req.inputAmount,
    minOutput:     '0',
    deadline:      req.deadline ?? currentBlock + 100,
    nonce:         0,
    minFillBps:    req.minFillBps ?? 100,
    startPrice:    req.startPrice,
    decayPerBlock: req.decayPerBlock,
    feeTier:       500,
    signature:     '0x' + '0'.repeat(130),
    status:        'pending',
    fills:         [],
  }
}

export function startQuoteServer(): void {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/quote') {
      res.writeHead(404); res.end('Not found'); return
    }

    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const quoteReq: QuoteRequest = JSON.parse(body)
        const currentBlock = quoteReq.currentBlock ?? await provider.getBlockNumber()
        const order = buildFakeOrder(quoteReq, currentBlock)
        const decision = await decide(order, currentBlock)

        const inDecimals  = 18
        const outDecimals = 6
        const auctionPriceHuman = (Number(decision.currentPrice) / 10 ** outDecimals).toFixed(4)
        const fillHuman = (Number(decision.fillAmount) / 10 ** inDecimals).toFixed(4)

        const response = {
          filler:          FILLER_NAME,
          wouldFill:       decision.shouldFill,
          fillAmount:      decision.fillAmount.toString(),
          fillAmountHuman: `${fillHuman} WETH`,
          auctionPrice:    `${auctionPriceHuman} USDC`,
          reason:          decision.reason ?? 'no fill',
          metadata:        decision.extras ?? {},
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
  })

  server.listen(PORT, () => {
    console.log(`[Quote] ${FILLER_NAME} quote server listening on port ${PORT}`)
  })
}
