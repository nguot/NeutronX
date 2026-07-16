import { ethers } from 'ethers'
import { writeFileSync, unlinkSync, readFileSync } from 'fs'
import { provider, wallet, fillAuction } from './contract/contracts'
import { OrderListener } from './listener/orderListener'
import { Executor } from './execution/executor'
import { startQuoteServer } from './quote/quoteServer'
import { seedInventory } from './funding/seed'
import { startRepl } from './cli/repl'
import { PID_FILE } from './cli/pidfile'
import { bgLog, bgError, BG_LOG_FILE } from './bgLog'
import type { OrderInfo } from './types'

// Refuse to start a second instance on top of one that's still alive — this
// is exactly what causes the quote server's EADDRINUSE crash below (two
// processes fighting over the same port), which used to kill the process
// silently well after the REPL looked fully up, leaving the terminal's raw
// mode with no reader left to restore it ("frozen": no echo, Enter does
// nothing, Ctrl+C does nothing — because nothing is there to receive it).
try {
  const existingPid = Number(readFileSync(PID_FILE, 'utf-8').trim())
  process.kill(existingPid, 0) // throws if that pid isn't alive
  console.error(`Another CoWFiller instance is already running (pid ${existingPid}).`)
  console.error(`Run 'npm run cli -- shutdown' to stop it first, or delete ${PID_FILE} if it's stale.`)
  process.exit(1)
} catch {
  // ENOENT (no pidfile) or ESRCH (stale pidfile, pid not alive) — safe to start.
}

writeFileSync(PID_FILE, String(process.pid))
const cleanupPidFile = () => { try { unlinkSync(PID_FILE) } catch { /* already gone */ } }

// Last-resort safety net: an uncaught exception used to crash the process
// silently (see quoteServer.ts's EADDRINUSE comment for the concrete case
// that motivated this). Log it clearly and exit deliberately instead of
// letting Node's default handler dump a stack trace and die mid-raw-mode.
process.on('uncaughtException', (e) => {
  console.error('[Main] uncaught exception — exiting:', e)
  cleanupPidFile()
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error('[Main] unhandled rejection — exiting:', e)
  cleanupPidFile()
  process.exit(1)
})

const listener = new OrderListener()
const executor  = new Executor()

listener.on('order', (order: OrderInfo) => {
  executor.watch(order)
})

provider.on('block', async (blockNumber: number) => {
  await executor.onBlock(blockNumber).catch(e => bgError('[Main] onBlock error:', e))
})

async function bootstrap() {
  // Refill the wallet with inventory on every (re)start so it can fill any
  // order. Non-fatal if a token can't be sourced.
  try { await seedInventory() } catch (e) { console.error('[Seed] failed:', e) }

  listener.start()
  startQuoteServer()
  console.log('[Main] CoWFiller started')
  console.log(`[Main] background watcher logs → ${BG_LOG_FILE}  (tail -f to watch)`)
  startRepl()
}

bootstrap()

// Reclaim returned ETH stakes every ~5 minutes
setInterval(async () => {
  try {
    const pending: ethers.BigNumber = await fillAuction.pendingReturns(wallet.address)
    if (pending.gt(0)) {
      const tx = await fillAuction.withdraw(wallet.address)
      await tx.wait()
      bgLog(`[Main] withdrew ${ethers.utils.formatEther(pending)} ETH stake returns`)
    }
  } catch (e) {
    bgError('[Main] withdraw error:', e)
  }
}, 5 * 60 * 1000)

process.on('SIGTERM', () => { listener.stop(); cleanupPidFile(); process.exit(0) })
process.on('SIGINT',  () => { listener.stop(); cleanupPidFile(); process.exit(0) })
