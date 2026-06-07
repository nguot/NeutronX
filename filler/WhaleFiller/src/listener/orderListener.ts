import { EventEmitter } from 'events'
import axios from 'axios'
import { BACKEND_URL, SUPPORTED_TOKENS } from '../config'
import type { OrderInfo } from '../types'

function fmt(raw: string, decimals: number): string {
  return (Number(raw) / 10 ** decimals).toFixed(4)
}

export class OrderListener extends EventEmitter {
  private seen   = new Set<string>()
  private timer?: NodeJS.Timeout

  start(): void {
    console.log(`[Listener] started — polling ${BACKEND_URL} every 6s`)
    void this.poll()
    this.timer = setInterval(() => void this.poll(), 6_000)
  }

  stop(): void {
    clearInterval(this.timer)
    console.log('[Listener] stopped')
  }

  private async poll(): Promise<void> {
    for (const status of ['pending', 'active'] as const) {
      try {
        const { data } = await axios.get<{ orders: OrderInfo[] }>(
          `${BACKEND_URL}/orders`,
          { params: { status, limit: 50 } }
        )

        const total = data.orders.length
        let skipped = 0

        for (const summary of data.orders) {
          if (this.seen.has(summary.hash)) { skipped++; continue }

          const inMeta  = SUPPORTED_TOKENS[summary.inputToken]
          const outMeta = SUPPORTED_TOKENS[summary.outputToken]
          if (!inMeta || !outMeta) {
            console.log(`[Listener] skip ${summary.hash.slice(0,10)}… — unsupported token pair`)
            skipped++
            continue
          }

          const { data: order } = await axios.get<OrderInfo>(
            `${BACKEND_URL}/orders/${summary.hash}`
          )

          const inAmt  = fmt(order.inputAmount, inMeta.decimals)
          const minOut = fmt(order.minOutput,   outMeta.decimals)
          const price  = fmt(order.startPrice, outMeta.decimals)

          console.log(
            `[Listener] ✦ new order  ${order.hash.slice(0,10)}…` +
            `  ${inAmt} ${inMeta.symbol} → min ${minOut} ${outMeta.symbol}` +
            `  startPrice=${price}  deadline=block#${order.deadline}` +
            `  status=${status}`
          )

          this.seen.add(order.hash)
          this.emit('order', order)
        }

        if (total - skipped > 0)
          console.log(`[Listener] poll(${status}) — ${total} orders, ${skipped} skipped, ${total - skipped} new`)

      } catch (e: any) {
        console.error(`[Listener] poll error (${status}): ${e.code ?? e.message}`)
      }
    }
  }
}
