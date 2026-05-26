import { ethers } from 'ethers'
import { provider, wallet, fillAuction } from './contract/contracts'
import { OrderListener } from './listener/orderListener'
import { Executor } from './execution/executor'
import { startQuoteServer } from './quote/quoteServer'
import type { OrderInfo } from './types'

const listener = new OrderListener()
const executor = new Executor()

listener.on('order', (order: OrderInfo) => {
  executor.watch(order)
})

provider.on('block', async (blockNumber: number) => {
  await executor.onBlock(blockNumber).catch(e => console.error('[Main] onBlock error:', e))
})

listener.start()
startQuoteServer()
console.log('[Main] WhaleFiller started')

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
