import { EventEmitter } from 'events'
import { http as axios } from '../httpClient'
import { BACKEND_URL, SUPPORTED_TOKENS } from '../config'
import { bgLog, bgError } from '../bgLog'
import type { OrderInfo } from '../types'

function fmt(raw: string, decimals: number): string {
  return (Number(raw) / 10 ** decimals).toFixed(4)
}

export class OrderListener extends EventEmitter {
  private seen   = new Set<string>()
  private timer?: NodeJS.Timeout
  // Tracks which statuses are currently failing so a persistent outage (e.g.
  // backend down) logs once instead of every 6s poll tick — was previously
  // the single noisiest thing in the REPL's output.
  private failing = new Set<string>()

  start(): void {
    bgLog(`[Listener] started — polling ${BACKEND_URL} every 6s`)
    void this.poll()
    this.timer = setInterval(() => void this.poll(), 6_000)
  }

  stop(): void {
    clearInterval(this.timer)
    bgLog('[Listener] stopped')
  }

  private async poll(): Promise<void> {
    for (const status of ['pending', 'active'] as const) {
      try {
        const { data } = await axios.get<{ orders: OrderInfo[] }>(
          `${BACKEND_URL}/orders`,
          { params: { status, limit: 50 } }
        )

        for (const summary of data.orders) {
          if (this.seen.has(summary.hash)) continue

          const inMeta  = SUPPORTED_TOKENS[summary.inputToken]
          const outMeta = SUPPORTED_TOKENS[summary.outputToken]
          if (!inMeta || !outMeta) {
            bgLog(`[Listener] skip ${summary.hash.slice(0,10)}… — unsupported token pair`)
            continue
          }

          const { data: order } = await axios.get<OrderInfo>(
            `${BACKEND_URL}/orders/${summary.hash}`
          )

          const inAmt  = fmt(order.inputAmount, inMeta.decimals)
          const minOut = fmt(order.minOutput,   outMeta.decimals)
          const price  = fmt(order.startPrice, outMeta.decimals)

          bgLog(
            `[Listener] ✦ new order  ${order.hash.slice(0,10)}…` +
            `  ${inAmt} ${inMeta.symbol} → min ${minOut} ${outMeta.symbol}` +
            `  startPrice=${price}  deadline=block#${order.deadline}` +
            `  status=${status}`
          )

          this.seen.add(order.hash)
          this.emit('order', order)
        }

        if (this.failing.has(status)) {
          bgLog(`[Listener] poll (${status}) recovered`)
          this.failing.delete(status)
        }

      } catch (e: any) {
        if (!this.failing.has(status)) {
          bgError(`[Listener] poll error (${status}): ${e.code ?? e.message} — will keep retrying quietly`)
          this.failing.add(status)
        }
      }
    }
  }
}
