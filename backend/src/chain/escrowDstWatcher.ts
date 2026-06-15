import { ethers } from 'ethers'
import { findSlotByHashlock, updateSlotStatus, deriveSecret, getCosignerWallet } from '../services/crosschainService'
import { db } from '../db/client'
import { ensureIndexerStateTable, resolveCheckpoint, setCheckpoint } from '../db/checkpoint'

// Factory emits one event per filler clone deployment
const FACTORY_ABI = [
  'event EscrowCreated(address indexed escrow, address indexed filler, bytes32 indexed hashlock, address recipient, address token, uint256 amount, uint256 expiry)',
]

// Each deployed clone exposes these — backend interacts with the specific clone
const ESCROW_DST_ABI = [
  'event Claimed(address indexed claimer, bytes32 secret)',
  'function claim(bytes32 secret) external',
  'function claimed() view returns (bool)',
  'function refunded() view returns (bool)',
]

// EscrowCreated events for different fillers/slots can land in the same block range
// and fire concurrently. Each queues onto its cosigner's chain so claim() sends are
// serialized — otherwise two concurrent sends from the same wallet fetch the same
// pending nonce and one gets rejected with "nonce too low". Keyed per (label, cosigner)
// so the two chains' independent nonces never block each other, but unrelated
// swappers' claims on the same chain still run in parallel.
const claimQueues = new Map<string, Promise<unknown>>()

function withCosignerQueue<T>(queueKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = claimQueues.get(queueKey) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  claimQueues.set(queueKey, next.then(() => undefined, () => undefined))
  return next
}

export interface EscrowDstWatcherOpts {
  chainId: number
  rpc: string
  factoryAddr: string
  confirmations: number
  // log prefix, e.g. "Chain A" / "Chain B"
  label: string
}

export function startEscrowDstWatcher(opts: EscrowDstWatcherOpts): void {
  const { chainId, rpc, factoryAddr, confirmations: confs, label } = opts

  const provider = new ethers.providers.JsonRpcProvider(rpc)
  // Default 4s polling opens a new HTTP connection to the Anvil RPC every poll;
  // under --block-time the resulting churn can wedge Anvil's TCP accept queue
  // over a long session, so poll less aggressively here.
  provider.pollingInterval = 12000
  const factory  = new ethers.Contract(factoryAddr, FACTORY_ABI, provider)

  console.log(`[${label}] watcher started — chain ${chainId} EscrowDstFactory: ${factoryAddr}`)

  // contract.on('EscrowCreated', ...) was found to silently never fire against
  // Anvil's --block-time chains (confirmed: zero deliveries even for events that
  // exist on-chain). Use the same checkpointed getLogs-on-new-block pattern as
  // the event indexer instead — provider.on('block', ...) is proven reliable.
  const checkpointName = `escrow_dst_${chainId}`
  let lastBlock = -1
  let latestSeen = -1
  let draining = false

  ;(async () => {
    await ensureIndexerStateTable()
    const current = await provider.getBlockNumber()
    console.log(`[${label}] connected  block #${current}`)
    lastBlock = await resolveCheckpoint(checkpointName, current, `[${label}]`)
  })()

  // Each time a filler deploys a clone, EscrowCreated fires with the escrow address,
  // the hashlock (H_i), and the fill parameters.  We verify it belongs to one of our
  // orders, wait confirmations, then claim from the specific clone.
  //
  // With pollingInterval=12000 on a ~1 block/sec chain, ethers fires 'block' once
  // per new block number in a burst — overlapping async handlers would all read
  // the same stale lastBlock and re-query/re-process the same EscrowCreated event
  // (and re-call claim() on an already-settled escrow). Drain sequentially instead.
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (lastBlock >= 0 && latestSeen > lastBlock) {
        const fromBlock = lastBlock + 1
        const toBlock   = latestSeen
        try {
          const logs = await factory.queryFilter(factory.filters.EscrowCreated(), fromBlock, toBlock)
          for (const log of logs) {
            const [escrow, dstFiller, hashlock, recipient, token, amount, dstExpiry] = log.args!
            console.log(`[${label}] EscrowCreated  ${escrow.slice(0,10)}…  H_i=${hashlock.slice(0,10)}…`)
            try {
              await handleEscrow(label, chainId, provider, escrow, dstFiller, hashlock, recipient, token, amount, dstExpiry, log.blockNumber, confs)
            } catch (e: any) {
              console.error(`[${label}] error handling escrow ${escrow.slice(0,10)}…:`, e?.message ?? e)
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
}

async function handleEscrow(
  label: string,
  dstChainId: number,
  provider: ethers.providers.JsonRpcProvider,
  escrowAddr: string,
  dstFiller: string,
  hashlock: string,
  recipient: string,
  token: string,
  amount: ethers.BigNumber,
  dstExpiry: ethers.BigNumber,
  deployBlock: number,
  confs: number
): Promise<void> {
  // Find which order+slot this hashlock belongs to
  const match = await findSlotByHashlock(hashlock)
  if (!match) {
    console.log(`[${label}] unknown hashlock — not our order, ignoring`)
    return
  }

  // Sanity check: the order's recorded destination chain must match the chain
  // this watcher is running on (catches misconfigured registries).
  if (match.dst_chain_id !== dstChainId) {
    console.warn(`[${label}] hashlock's order has dst_chain_id=${match.dst_chain_id}, but this watcher is on chain ${dstChainId} — skipping`)
    return
  }

  // Verify the recipient is the swapper for this order
  if (recipient.toLowerCase() !== match.swapper.toLowerCase()) {
    console.warn(`[${label}] wrong recipient ${recipient} (expected ${match.swapper}) — skipping`)
    return
  }

  // 3.4: verify the filler locked the SIGNED output token. EscrowDstFactory lets
  // the filler pass any token address; the EscrowCreated event carries it. Without
  // this check a filler could lock a worthless/unintended token, satisfy the
  // amount + expiry + filler checks, and still trigger secret reveal for the real
  // source-side asset.
  if (token.toLowerCase() !== match.output_token.toLowerCase()) {
    console.warn(`[${label}] slot ${match.slot_index}: locked token ${token} != signed output ${match.output_token} — skipping`)
    return
  }

  // Verify amount >= this slot's exact minimum output.
  const orderRow  = await db.query('SELECT num_slots FROM cc_orders WHERE order_hash=$1', [match.order_hash])
  const numSlots  = orderRow.rows[0]?.num_slots ?? 1
  // 3.6: the source factory makes the FINAL slot absorb the integer-division
  // remainder (lastSlotAmount), so its required output is larger than a flat
  // minOutput/numSlots. Mirror that exact sizing instead of a flat share, or a
  // last-slot filler could fund only the flat minimum yet pull a larger source amount.
  const basePerSlot = BigInt(match.min_output) / BigInt(numSlots)
  const minPerSlot  = match.slot_index === numSlots - 1
    ? BigInt(match.min_output) - basePerSlot * BigInt(numSlots - 1)
    : basePerSlot
  if (amount.toBigInt() < minPerSlot) {
    console.warn(`[${label}] slot ${match.slot_index}: amount ${amount} < required ${minPerSlot} — skipping`)
    return
  }

  // 3.1: defend against a malformed sanctioned expiry. createCrossChainOrder now
  // rejects non-positive / oversized t2Buffer, but guard legacy rows too: the
  // sanctioned t2_expiry must itself be strictly below the source deadline (T1),
  // otherwise the ordering check below is meaningless.
  if (BigInt(match.t2_expiry) >= BigInt(match.deadline)) {
    console.warn(`[${label}] slot ${match.slot_index}: sanctioned t2 ${match.t2_expiry} >= source deadline ${match.deadline} — malformed order, refusing to reveal secret`)
    return
  }

  // 3.1: enforce destination-before-source timelock ordering. The backend
  // sanctioned t2_expiry = deadline - t2Buffer, strictly before the source
  // leg's expiry (T1). Refuse to reveal the secret for any escrow whose
  // on-chain expiry exceeds it — otherwise a filler could set T2 >= T1, let
  // the source leg expire and cancel it, and still collect the destination leg.
  if (BigInt(dstExpiry.toString()) > BigInt(match.t2_expiry)) {
    console.warn(`[${label}] slot ${match.slot_index}: dst expiry ${dstExpiry} > sanctioned t2 ${match.t2_expiry} — refusing to reveal secret`)
    return
  }

  // 3.7: do NOT leave 'available' yet. The slot must stay matchable until EVERY
  // reveal precondition holds (including the source-filler binding below).
  // Marking it 'locked' here used to strand the slot whenever a later check
  // returned early — findSlotByHashlock only matches 'available' rows, so the
  // legitimate escrow could never be re-matched. The transition is deferred to
  // just before claim(), once all checks have passed.
  console.log(`[${label}] slot ${match.slot_index} escrow seen — waiting ${confs} confirmation(s)`)
  await waitConfirmations(provider, deployBlock, confs)

  // Re-check the escrow hasn't already been claimed or refunded (e.g. race condition)
  const escrow = new ethers.Contract(escrowAddr, ESCROW_DST_ABI, provider)
  const [alreadyClaimed, alreadyRefunded] = await Promise.all([
    escrow.claimed(),
    escrow.refunded(),
  ])
  if (alreadyClaimed || alreadyRefunded) {
    console.log(`[${label}] escrow already settled — nothing to do`)
    return
  }

  // Re-derive S_i from rootSecret (never stored, always derived on demand)
  const sessionRow = await db.query(
    'SELECT root_secret FROM cc_sessions WHERE swapper=$1',
    [match.swapper]
  )
  const rootSecret = sessionRow.rows[0]?.root_secret
  if (!rootSecret) {
    console.error(`[${label}] no session found for swapper ${match.swapper}`)
    return
  }

  const secret = deriveSecret(rootSecret, {
    swapper:     match.swapper,
    inputToken:  match.input_token,
    inputAmount: match.input_amount,
    outputToken: match.output_token,
    minOutput:   match.min_output,
    deadline:    match.deadline,
    nonce:       match.nonce,
  }, match.slot_index)

  // Relay claim() with the single server cosigner key (Trufy 3.1). The secret
  // above still comes from this session's per-user rootSecret; the wallet that
  // *sends* the tx is the server's funded cosigner EOA, the same key that signs
  // orders and matches the factory's immutable cosigner.
  const cosignerWallet = getCosignerWallet(provider)

  // 3.2 + 3.7: bind both legs to the SAME filler before revealing the secret,
  // and tolerate source-indexing lag. assigned_filler is the ACTUAL on-chain
  // source filler (msg.sender of fillSlot, recorded by escrowSrcWatcher). The
  // source fill always precedes the destination funding, but escrowSrcWatcher
  // may not have indexed SlotFilled yet — so poll briefly instead of giving up
  // on the first miss (a single miss used to strand the slot permanently). On a
  // genuine mismatch we return with the slot still 'available', so the
  // legitimate filler's later escrow can still be matched.
  let srcFiller: string | null = null
  for (let i = 0; i < 10; i++) {
    const row = await db.query(
      'SELECT assigned_filler FROM cc_slots WHERE order_hash=$1 AND slot_index=$2',
      [match.order_hash, match.slot_index]
    )
    srcFiller = row.rows[0]?.assigned_filler as string | null
    if (srcFiller) break
    await new Promise(r => setTimeout(r, 1500))
  }
  if (!srcFiller || dstFiller.toLowerCase() !== srcFiller.toLowerCase()) {
    console.warn(`[${label}] slot ${match.slot_index}: dst filler ${dstFiller} != source filler ${srcFiller ?? '(none recorded yet)'} — leaving slot available, refusing to reveal secret`)
    return
  }

  // 3.7: every reveal precondition now holds — only here do we leave 'available'.
  await updateSlotStatus(match.order_hash, match.slot_index, 'locked', escrowAddr)

  console.log(`[${label}] claiming  slot=${match.slot_index}  escrow=${escrowAddr.slice(0,10)}…`)

  // claim() on the individual clone — sends the locked tokens to recipient, emits
  // Claimed(claimer, S_i). S_i is now public on this chain — the filler reads the
  // event and calls claimSlot() on the other chain.
  // Queued per (label, cosigner): send + wait must complete before the next claim()
  // from this wallet on this chain is sent, so each one picks up the correctly
  // incremented nonce.
  const tx = await withCosignerQueue(`${label}:${cosignerWallet.address}`, async () => {
    const sent = await escrow.connect(cosignerWallet).claim(secret)
    await sent.wait()
    return sent
  })

  await updateSlotStatus(match.order_hash, match.slot_index, 'claimed', escrowAddr)
  console.log(`[${label}] ✔ claimed  slot=${match.slot_index}  tx=${tx.hash}`)
  console.log(`[${label}]   S_i emitted in Claimed event — filler can now claimSlot() on the other chain`)
}

function waitConfirmations(
  provider: ethers.providers.JsonRpcProvider,
  fromBlock: number,
  confs: number
): Promise<void> {
  return new Promise(resolve => {
    const check = async () => {
      const current = await provider.getBlockNumber()
      if (current >= fromBlock + confs) resolve()
      else setTimeout(check, 1000)
    }
    check()
  })
}
