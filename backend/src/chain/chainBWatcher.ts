import { ethers } from 'ethers'
import { findSlotByHashlock, updateSlotStatus, deriveSecret } from '../services/crosschainService'
import { db } from '../db/client'

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
// pending nonce and one gets rejected with "nonce too low". Keyed per cosigner
// address (not globally) so unrelated swappers' claims still run in parallel.
const claimQueues = new Map<string, Promise<unknown>>()

function withCosignerQueue<T>(cosignerAddr: string, fn: () => Promise<T>): Promise<T> {
  const prev = claimQueues.get(cosignerAddr) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  claimQueues.set(cosignerAddr, next.then(() => undefined, () => undefined))
  return next
}

export function startChainBWatcher(): void {
  const rpc         = process.env.CHAIN_B_RPC
  const factoryAddr = process.env.CHAIN_B_FACTORY
  const confs       = parseInt(process.env.CHAIN_B_CONFIRMATIONS || '3')

  if (!rpc || !factoryAddr) {
    console.log('[ChainB] CHAIN_B_RPC or CHAIN_B_FACTORY not set — watcher disabled')
    return
  }

  const provider = new ethers.providers.JsonRpcProvider(rpc)
  const factory  = new ethers.Contract(factoryAddr, FACTORY_ABI, provider)

  console.log(`[ChainB] watcher started — EscrowDstFactory: ${factoryAddr}`)

  // Each time a filler deploys a clone, EscrowCreated fires with the escrow address,
  // the hashlock (H_i), and the fill parameters.  We verify it belongs to one of our
  // orders, wait confirmations, then claim from the specific clone.
  factory.on('EscrowCreated', async (
    escrow: string,
    _filler: string,
    hashlock: string,
    recipient: string,
    _token: string,
    amount: ethers.BigNumber,
    _expiry: ethers.BigNumber,
    event: ethers.Event
  ) => {
    console.log(`[ChainB] EscrowCreated  ${escrow.slice(0,10)}…  H_i=${hashlock.slice(0,10)}…`)
    try {
      await handleEscrow(provider, escrow, hashlock, recipient, amount, event.blockNumber, confs)
    } catch (e: any) {
      console.error(`[ChainB] error handling escrow ${escrow.slice(0,10)}…:`, e?.message ?? e)
    }
  })

  provider.getBlockNumber().then(n => console.log(`[ChainB] connected  block #${n}`))
}

async function handleEscrow(
  provider: ethers.providers.JsonRpcProvider,
  escrowAddr: string,
  hashlock: string,
  recipient: string,
  amount: ethers.BigNumber,
  deployBlock: number,
  confs: number
): Promise<void> {
  // Find which order+slot this hashlock belongs to
  const match = await findSlotByHashlock(hashlock)
  if (!match) {
    console.log(`[ChainB] unknown hashlock — not our order, ignoring`)
    return
  }

  // Verify the recipient is the swapper for this order
  if (recipient.toLowerCase() !== match.swapper.toLowerCase()) {
    console.warn(`[ChainB] wrong recipient ${recipient} (expected ${match.swapper}) — skipping`)
    return
  }

  // Verify amount >= minOutput / numSlots
  const orderRow  = await db.query('SELECT num_slots FROM cc_orders WHERE order_hash=$1', [match.order_hash])
  const numSlots  = orderRow.rows[0]?.num_slots ?? 1
  const minPerSlot = BigInt(match.min_output) / BigInt(numSlots)
  if (amount.toBigInt() < minPerSlot) {
    console.warn(`[ChainB] slot ${match.slot_index}: amount ${amount} < required ${minPerSlot} — skipping`)
    return
  }

  // Mark slot as locked (escrow deployed) so API reflects current state
  await updateSlotStatus(match.order_hash, match.slot_index, 'locked', escrowAddr)

  console.log(`[ChainB] slot ${match.slot_index} locked — waiting ${confs} confirmation(s)`)
  await waitConfirmations(provider, deployBlock, confs)

  // Re-check the escrow hasn't already been claimed or refunded (e.g. race condition)
  const escrow = new ethers.Contract(escrowAddr, ESCROW_DST_ABI, provider)
  const [alreadyClaimed, alreadyRefunded] = await Promise.all([
    escrow.claimed(),
    escrow.refunded(),
  ])
  if (alreadyClaimed || alreadyRefunded) {
    console.log(`[ChainB] escrow already settled — nothing to do`)
    return
  }

  // Re-derive S_i from rootSecret (never stored, always derived on demand)
  const sessionRow = await db.query(
    'SELECT root_secret FROM cc_sessions WHERE swapper=$1',
    [match.swapper]
  )
  const rootSecret = sessionRow.rows[0]?.root_secret
  if (!rootSecret) {
    console.error(`[ChainB] no session found for swapper ${match.swapper}`)
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

  // cosignerWallet is derived from rootSecret (same key every time, deterministic)
  const cosignerWallet = new ethers.Wallet(rootSecret, provider)

  console.log(`[ChainB] claiming  slot=${match.slot_index}  escrow=${escrowAddr.slice(0,10)}…`)

  // claim() on the individual clone — sends USDC to recipient, emits Claimed(claimer, S_i)
  // S_i is now public on Chain B — filler reads the event and calls claimSlot() on Chain A
  // Queued per-cosigner: send + wait must complete before the next claim() from this
  // wallet is sent, so each one picks up the correctly incremented nonce.
  const tx = await withCosignerQueue(cosignerWallet.address, async () => {
    const sent = await escrow.connect(cosignerWallet).claim(secret)
    await sent.wait()
    return sent
  })

  await updateSlotStatus(match.order_hash, match.slot_index, 'claimed', escrowAddr)
  console.log(`[ChainB] ✔ claimed  slot=${match.slot_index}  tx=${tx.hash}`)
  console.log(`[ChainB]   S_i emitted in Claimed event — filler can now claimSlot() on Chain A`)
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
