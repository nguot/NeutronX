import { EventEmitter } from 'events'
import axios from 'axios'
import { BACKEND_URL, SUPPORTED_TOKENS } from '../config'
import type { OrderInfo } from '../types'

// Polls the backend for open orders and emits 'order' for each new one.
// Filters out token pairs not in SUPPORTED_TOKENS (config.ts).
export class OrderListener extends EventEmitter {
  private seen   = new Set<string>()
  private timer?: NodeJS.Timeout

  start(): void {
    console.log('[Listener] started')
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

        for (const summary of data.orders) {
          if (this.seen.has(summary.hash))             continue
          if (!SUPPORTED_TOKENS[summary.inputToken])   continue
          if (!SUPPORTED_TOKENS[summary.outputToken])  continue

          // Fetch full detail for signature + startPrice + decayPerBlock + fills
          const { data: order } = await axios.get<OrderInfo>(
            `${BACKEND_URL}/orders/${summary.hash}`
          )

          this.seen.add(order.hash)
          this.emit('order', order)
          console.log(`[Listener] new order ${order.hash} (${status})`)
        }
      } catch (e) {
        console.error('[Listener] poll error:', e)
      }
    }
  }
}
