import http from 'http'
import { decide } from '../strategy/strategy'
import { provider } from '../contract/contracts'
import { SUPPORTED_TOKENS } from '../config'
import type { OrderInfo } from '../types'
import * as dotenv from 'dotenv'
dotenv.config()

// The filler's machine-facing API. The interactive dev console that used to live
// here was replaced by the CLI (`npm run cli`). The only HTTP surface left is:
//   POST /quote   — the backend's fillerSim replays orders against this
//   GET  /health  — liveness + current block
const FILLER_NAME = 'WhaleFiller'
const PORT        = parseInt(process.env.QUOTE_PORT ?? '3001')

function decimalsOf(addr: string): number {
  return SUPPORTED_TOKENS[addr]?.decimals
    ?? SUPPORTED_TOKENS[Object.keys(SUPPORTED_TOKENS).find(a => a.toLowerCase() === addr.toLowerCase()) ?? '']?.decimals
    ?? 18
}

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

function cors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  cors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

export function startQuoteServer(): void {
  const server = http.createServer(async (req, res) => {
    cors(res)

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    if (req.method === 'GET' && req.url === '/health') {
      const block = await provider.getBlockNumber().catch(() => null)
      json(res, 200, { ok: true, filler: FILLER_NAME, block })
      return
    }

    if (req.method === 'POST' && req.url === '/quote') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const quoteReq: QuoteRequest = JSON.parse(body)
          const currentBlock = quoteReq.currentBlock ?? await provider.getBlockNumber()
          const order        = buildFakeOrder(quoteReq, currentBlock)
          const decision     = await decide(order, currentBlock)

          const inDec  = decimalsOf(quoteReq.inputToken)
          const outDec = decimalsOf(quoteReq.outputToken)
          json(res, 200, {
            filler:          FILLER_NAME,
            wouldFill:       decision.shouldFill,
            fillAmount:      decision.fillAmount.toString(),
            fillAmountHuman: (Number(decision.fillAmount) / 10 ** inDec).toFixed(4),
            // contract price convention: humanPrice = price / 1e18 * 10^inDec / 10^outDec
            // (see frontend/src/lib/tokens.tsx's contractToHumanPrice — must match
            // exactly, or this silently only works for 18-decimal input tokens).
            auctionPrice:    (Number(decision.currentPrice) / 1e18 * 10 ** inDec / 10 ** outDec).toFixed(4),
            reason:          decision.reason ?? 'no fill',
            metadata:        decision.extras ?? {},
          })
        } catch (e: any) {
          json(res, 500, { error: e?.message ?? e?.reason ?? String(e) })
        }
      })
      return
    }

    json(res, 404, { error: 'Not found — interactive UI removed, use the CLI (npm run cli)' })
  })

  server.listen(PORT, () => {
    console.log(`[${FILLER_NAME}] quote API on http://localhost:${PORT}  (POST /quote, GET /health)`)
    console.log(`[${FILLER_NAME}] interactive console → run:  npm run cli -- orders`)
  })
}
