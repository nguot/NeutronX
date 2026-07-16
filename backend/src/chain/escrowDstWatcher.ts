import { ethers } from 'ethers'
import { db } from '../db/client'
import { ensureIndexerStateTable, resolveCheckpoint, setCheckpoint, queryFilterChunked } from '../db/checkpoint'
import { ESCROW_DST_FACTORY_ABI, ESCROW_DST_ABI } from './abis'
import { assertGenuineDstClone } from '../services/escrowAuthenticity'
import { recordDstFunded, recordClaimed, getRelayerWallet } from '../services/crosschainService'

// Model 2 (filler-holds-key): this watcher runs on the DESTINATION chain and
// plays the RELAYER role — it never derives or holds a secret. It does two
// independent jobs:
//
//   1. Block-driven: watch EscrowDstFactory for EscrowCreated, verify the
//      clone is genuine (CREATE2 address-match) AND matches the quoted
//      fill's committed recipient/token/amount/expiry (Điểm A) — only then
//      mark the fill 'dst_funded', which is the gate that lets the swapper's
//      client safely sign the per-fill authorization.
//   2. Timer-driven: poll for fills already 'revealed' (secret made public by
//      a Withdrawn event on the SOURCE chain, seen by escrowSrcWatcher — a
//      different chain/process) whose dest escrow lives on THIS chain, and
//      relay EscrowDst.claim(secret) using the relayer's own funded wallet.
//      claim() is permissionless — the relayer has no special on-chain
//      privilege, it just pays gas on the swapper's behalf.

export interface EscrowDstWatcherOpts {
  chainId: number
  rpc: string
  factoryAddr: string
  confirmations: number
  label: string
}

// EscrowCreated events for different fillers can land in the same block range
// and fire concurrently; queue claim() sends per (label, relayer) so they're
// serialized and each picks up the correctly incremented nonce.
const claimQueues = new Map<string, Promise<unknown>>()

function withRelayerQueue<T>(queueKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = claimQueues.get(queueKey) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  claimQueues.set(queueKey, next.then(() => undefined, () => undefined))
  return next
}

export function startEscrowDstWatcher(opts: EscrowDstWatcherOpts): void {
  const { chainId, rpc, factoryAddr, label } = opts

  const provider = new ethers.providers.JsonRpcProvider(rpc)
  // Anvil --block-time TCP-wedge mitigation (unchanged from Model 1).
  provider.pollingInterval = 12000
  const factory = new ethers.Contract(factoryAddr, ESCROW_DST_FACTORY_ABI, provider)

  console.log(`[${label}] dst watcher (relayer) started — chain ${chainId} EscrowDstFactory: ${factoryAddr}`)

  const checkpointName = `escrow_dst_${chainId}`
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
        console.log(`[${label}] connected  block #${current}`)
        lastBlock = await resolveCheckpoint(checkpointName, current, `[${label}]`, genesis?.hash)
        floorBlock = Math.min(lastBlock, current)
        return
      } catch (e: any) {
        console.error(`[${label}] failed to connect (${e?.message ?? e}) — retrying in 5s`)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  })()

  const RESCAN_LAG = 30
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (lastBlock >= 0 && latestSeen > lastBlock) {
        const fromBlock = Math.max(0, floorBlock, lastBlock + 1 - RESCAN_LAG)
        const toBlock   = latestSeen
        try {
          const logs = await queryFilterChunked(factory, factory.filters.EscrowCreated(), fromBlock, toBlock)
          for (const log of logs) {
            const [escrow, filler, hashlock] = log.args!
            console.log(`[${label}] EscrowCreated  ${escrow.slice(0,10)}…  hashlock=${hashlock.slice(0,10)}…`)
            try {
              await handleEscrowCreated(label, chainId, escrow, filler, hashlock, log.transactionHash)
            } catch (e: any) {
              console.error(`[${label}] error handling EscrowCreated ${escrow.slice(0,10)}…:`, e?.message ?? e)
            }
          }
          lastBlock = toBlock
          await setCheckpoint(checkpointName, lastBlock)
        } catch (e) {
          console.error(`[${label}] poll error (EscrowCreated):`, e)
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

  // Independent timer loop: the reveal that unblocks a claim happens on a
  // DIFFERENT chain (the order's source), so it can't be driven off this
  // chain's own block/log stream — poll the DB instead.
  const RELAY_POLL_MS = 5000
  setInterval(() => { void relayRevealedFills(label, chainId, provider) }, RELAY_POLL_MS)
}

async function handleEscrowCreated(
  label: string,
  dstChainId: number,
  escrowAddr: string,
  filler: string,
  hashlock: string,
  txHash: string,
): Promise<void> {
  // Find the quoted fill this hashlock belongs to.
  const row = await db.query(`
    SELECT f.order_hash, f.fill_amount, f.t2, o.swapper, o.output_token, o.dst_chain_id
    FROM cc_fills f JOIN cc_orders o ON o.order_hash = f.order_hash
    WHERE f.hashlock = $1 AND f.status = 'quoted'
  `, [hashlock])
  if (!row.rows.length) {
    console.log(`[${label}] EscrowCreated for unknown/already-progressed hashlock — ignoring`)
    return
  }
  const { order_hash: orderHash, fill_amount: fillAmount, t2, swapper, output_token: outputToken, dst_chain_id: expectedDstChain } = row.rows[0]

  if (Number(expectedDstChain) !== dstChainId) {
    console.warn(`[${label}] fill's recorded dst_chain_id=${expectedDstChain}, but this watcher is on chain ${dstChainId} — skipping`)
    return
  }

  // Điểm A: verify the clone is genuine AND matches the committed fill terms
  // BEFORE letting the swapper's client treat it as safe to sign against.
  const check = await assertGenuineDstClone(dstChainId, hashlock, filler, escrowAddr, {
    recipient: swapper, token: outputToken, minAmount: BigInt(fillAmount), expiry: Number(t2),
  })
  if (!check.ok) {
    console.warn(`[${label}] EscrowCreated ${escrowAddr} failed authenticity/terms check: ${check.reason} — refusing to mark dst_funded`)
    return
  }

  await recordDstFunded(orderHash, hashlock, escrowAddr, txHash)
  console.log(`[${label}] dst_funded  order=${orderHash.slice(0,10)}…  hashlock=${hashlock.slice(0,10)}…  escrow verified genuine`)
}

// Called every RELAY_POLL_MS via `void relayRevealedFills(...)` in a
// setInterval callback — a rejection escaping this function would be an
// unhandled promise rejection that crashes the whole backend process, so
// every fallible step from here down must catch its own errors.
async function relayRevealedFills(
  label: string,
  dstChainId: number,
  provider: ethers.providers.JsonRpcProvider,
): Promise<void> {
  let rows: { rows: any[] }
  try {
    rows = await db.query(`
      SELECT f.order_hash, f.hashlock, f.secret, f.escrow_dst_addr, f.t2
      FROM cc_fills f JOIN cc_orders o ON o.order_hash = f.order_hash
      WHERE f.status = 'revealed' AND o.dst_chain_id = $1
    `, [dstChainId])
  } catch (e: any) {
    console.error(`[${label}] relay poll: failed to query revealed fills:`, e?.message ?? e)
    return
  }
  if (!rows.rows.length) return

  let relayerWallet: ethers.Wallet
  try {
    relayerWallet = getRelayerWallet(provider)
  } catch (e: any) {
    console.error(`[${label}] cannot relay claims:`, e?.message ?? e)
    return
  }

  for (const row of rows.rows) {
    const { order_hash: orderHash, hashlock, secret, escrow_dst_addr: escrowAddr, t2 } = row
    if (!escrowAddr) continue

    const nowSec = Math.floor(Date.now() / 1000)
    if (nowSec > Number(t2)) {
      console.warn(`[${label}] fill order=${orderHash.slice(0,10)}… hashlock=${hashlock.slice(0,10)}… revealed but past T2 — filler must self-refund on dest`)
      continue
    }

    try {
      const escrow = new ethers.Contract(escrowAddr, ESCROW_DST_ABI, provider)
      const [claimed, refunded] = await Promise.all([escrow.claimed(), escrow.refunded()])
      if (claimed || refunded) continue // already settled, e.g. by the swapper's own fallback claim

      const txHash: string = await withRelayerQueue(`${label}:${relayerWallet.address}`, async () => {
        const sent = await escrow.connect(relayerWallet).claim(secret)
        await sent.wait()
        return sent.hash
      })
      await recordClaimed(orderHash, hashlock, txHash)
      console.log(`[${label}] ✔ claimed  order=${orderHash.slice(0,10)}…  hashlock=${hashlock.slice(0,10)}…  tx=${txHash}`)
    } catch (e: any) {
      console.error(`[${label}] relay claim failed for hashlock ${hashlock.slice(0,10)}…:`, e?.message ?? e)
    }
  }
}
