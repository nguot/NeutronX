import { ethers } from 'ethers'
import { db } from '../db/client'
import { ensureIndexerStateTable, resolveCheckpoint, setCheckpoint, queryFilterChunked } from '../db/checkpoint'
import { ESCROW_SRC_FACTORY_ABI, ESCROW_SRC_ABI } from './abis'
import { assertGenuineSrcClone } from '../services/escrowAuthenticity'
import { recordSrcLocked, recordReveal, recordSlashed } from '../services/crosschainService'

// Model 2 (filler-holds-key): watches the SOURCE chain for two things —
//   1. Filled — a filler locked the swapper's input into a fresh EscrowSrc
//      clone. Verified genuine (CREATE2 address-match) before being trusted.
//   2. Withdrawn — the filler revealed the secret to claim its input. This is
//      the ONLY place the secret ever becomes public; the relayer
//      (escrowDstWatcher) reads it from here, never derives it.
//   (also Cancelled — a griefed fill, recorded as 'slashed' for the status board)
//
// Withdrawn/Cancelled are emitted by dynamically-deployed clones (one per
// fill), not the static factory address, so they're scanned by event
// signature across ALL addresses on the chain and matched back to a known
// escrow_src_addr in cc_fills — an unrelated contract emitting the same
// topic0 is simply not in that table and gets ignored.

export interface EscrowSrcWatcherOpts {
  chainId: number
  rpc: string
  factoryAddr: string
  label: string
}

const WITHDRAWN_TOPIC = ethers.utils.id('Withdrawn(address,bytes32)')
const CANCELLED_TOPIC  = ethers.utils.id('Cancelled(address,uint256,address,uint256)')

export function startEscrowSrcWatcher(opts: EscrowSrcWatcherOpts): void {
  const { chainId, rpc, factoryAddr, label } = opts

  const provider = new ethers.providers.JsonRpcProvider(rpc)
  // Same Anvil TCP-wedge mitigation as the dst watcher.
  provider.pollingInterval = 12000
  const factory = new ethers.Contract(factoryAddr, ESCROW_SRC_FACTORY_ABI, provider)

  console.log(`[${label}] src watcher started — chain ${chainId} EscrowSrcFactory: ${factoryAddr}`)

  const checkpointName = `escrow_src_${chainId}`
  let lastBlock = -1
  let latestSeen = -1
  let draining = false
  // Floor for the rescan rewind below — never re-query blocks older than
  // where this watcher started. On a freshly forked local anvil the tip sits
  // right at the fork boundary, so an unconditional RESCAN_LAG rewind would
  // dip into pre-fork history that anvil proxies to the upstream RPC, which
  // free-tier providers reject for wide eth_getLogs ranges (permanently
  // wedging this watcher, since a failed drain() never advances lastBlock).
  let floorBlock = -1

  // Retry-until-connected instead of a bare fire-and-forget IIFE: an
  // unhandled rejection here (e.g. RPC not accepting connections yet at
  // backend startup) would otherwise crash the ENTIRE backend process, not
  // just this watcher.
  ;(async () => {
    for (;;) {
      try {
        await ensureIndexerStateTable()
        const current = await provider.getBlockNumber()
        const genesis = await provider.getBlock(0).catch(() => null)
        console.log(`[${label}] src watcher connected  block #${current}`)
        lastBlock = await resolveCheckpoint(checkpointName, current, `[${label}] src`, genesis?.hash)
        floorBlock = Math.min(lastBlock, current)
        return
      } catch (e: any) {
        console.error(`[${label}] src watcher failed to connect (${e?.message ?? e}) — retrying in 5s`)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  })()

  // Same rescan-trailing-window pattern as the dst watcher — reprocessing an
  // already-settled row is a cheap no-op (the UPDATE ... WHERE status = '...'
  // guards make every handler idempotent).
  const RESCAN_LAG = 30

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (lastBlock >= 0 && latestSeen > lastBlock) {
        const fromBlock = Math.max(0, floorBlock, lastBlock + 1 - RESCAN_LAG)
        const toBlock = latestSeen
        try {
          const [filledLogs, rawLogs] = await Promise.all([
            queryFilterChunked(factory, factory.filters.Filled(), fromBlock, toBlock),
            provider.getLogs({ fromBlock, toBlock, topics: [[WITHDRAWN_TOPIC, CANCELLED_TOPIC]] }),
          ])

          for (const log of filledLogs) {
            const [orderHash, hashlock, filler, escrow] = log.args!
            console.log(`[${label}] Filled  order=${orderHash.slice(0,10)}…  hashlock=${hashlock.slice(0,10)}…`)
            try {
              await handleFilled(label, chainId, orderHash, hashlock, filler, escrow, log.transactionHash)
            } catch (e: any) {
              console.error(`[${label}] error handling Filled:`, e?.message ?? e)
            }
          }

          for (const log of rawLogs) {
            try {
              await handleSrcEscrowLog(label, log)
            } catch (e: any) {
              console.error(`[${label}] error handling src escrow log ${log.transactionHash}:`, e?.message ?? e)
            }
          }

          lastBlock = toBlock
          await setCheckpoint(checkpointName, lastBlock)
        } catch (e) {
          console.error(`[${label}] poll error:`, e)
          break
        }
      }
    } finally {
      draining = false
    }
  }

  provider.on('block', (blockNumber: number) => {
    if (blockNumber > latestSeen) latestSeen = blockNumber
    void drain()
  })
}

async function handleFilled(
  label: string,
  chainId: number,
  orderHash: string,
  hashlock: string,
  filler: string,
  escrow: string,
  txHash: string,
): Promise<void> {
  const check = await assertGenuineSrcClone(chainId, orderHash, hashlock, escrow)
  if (!check.ok) {
    console.warn(`[${label}] Filled escrow ${escrow} failed authenticity check: ${check.reason} — ignoring`)
    return
  }
  await recordSrcLocked(orderHash, hashlock, escrow, filler, txHash)
  console.log(`[${label}] src_locked  order=${orderHash.slice(0,10)}…  hashlock=${hashlock.slice(0,10)}…  filler=${filler}`)
}

async function handleSrcEscrowLog(label: string, log: ethers.providers.Log): Promise<void> {
  const row = await db.query(
    'SELECT order_hash, hashlock FROM cc_fills WHERE LOWER(escrow_src_addr) = LOWER($1)',
    [log.address]
  )
  if (!row.rows.length) return // not one of our recorded escrows — ignore
  const { order_hash: orderHash, hashlock } = row.rows[0]

  if (log.topics[0] === WITHDRAWN_TOPIC) {
    const iface = new ethers.utils.Interface(ESCROW_SRC_ABI)
    const parsed = iface.parseLog(log)
    const secret = parsed.args.secret as string
    await recordReveal(orderHash, hashlock, secret, log.transactionHash)
    console.log(`[${label}] revealed  order=${orderHash.slice(0,10)}…  hashlock=${hashlock.slice(0,10)}…  secret now public`)
  } else if (log.topics[0] === CANCELLED_TOPIC) {
    await recordSlashed(orderHash, hashlock)
    console.log(`[${label}] slashed (griefed fill)  order=${orderHash.slice(0,10)}…  hashlock=${hashlock.slice(0,10)}…`)
  }
}
