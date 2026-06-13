import { ethers } from 'ethers'
import { provider, wallet, fillAuction } from './contract/contracts'
import { OrderListener } from './listener/orderListener'
import { Executor } from './execution/executor'
import { startQuoteServer } from './quote/quoteServer'
import { logOrderbook, getOrderbook } from './orderbook/mockOrderbook'
import { DEV_MODE } from './config'
import { seedInventory } from './dev/seed'
import type { OrderInfo } from './types'

const listener = new OrderListener()
const executor  = new Executor()

listener.on('order', (order: OrderInfo) => {
  executor.watch(order)
})

provider.on('block', async (blockNumber: number) => {
  await executor.onBlock(blockNumber).catch(e => console.error('[Main] onBlock error:', e))
})

async function bootstrap() {
  // DEV_MODE: refill the wallet with inventory on every (re)start so it can
  // fill any order. Non-fatal if a token can't be sourced.
  if (DEV_MODE) {
    try { await seedInventory() } catch (e) { console.error('[Seed] failed:', e) }
  }

  listener.start()
  startQuoteServer()
  console.log('[Main] CoWFiller started')

  // Log the mock orderbook on startup so it's visible in console
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const book = getOrderbook(WETH, USDC)
  if (book) logOrderbook(book)
}

bootstrap()

// Reclaim returned ETH stakes every ~5 minutes
setInterval(async () => {
  try {
    const pending: ethers.BigNumber = await fillAuction.pendingReturns(wallet.address)
    if (pending.gt(0)) {
      const tx = await fillAuction.withdraw()
      await tx.wait()
      console.log(`[Main] withdrew ${ethers.utils.formatEther(pending)} ETH stake returns`)
    }
  } catch (e) {
    console.error('[Main] withdraw error:', e)
  }
}, 5 * 60 * 1000)

process.on('SIGTERM', () => { listener.stop(); process.exit(0) })
process.on('SIGINT',  () => { listener.stop(); process.exit(0) })
