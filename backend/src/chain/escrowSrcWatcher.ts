import { ethers } from 'ethers'
import { db } from '../db/client'
import { updateSlotFiller } from '../services/crosschainService'
import { ensureIndexerStateTable, resolveCheckpoint, setCheckpoint } from '../db/checkpoint'

// Factory emits one event per slot a filler claims on the source chain
const FACTORY_ABI = [
  'event SlotFilled(bytes32 indexed orderHash, uint8 indexed slotIndex, address indexed filler, address escrow, bytes32 hashlock, uint256 amount, uint256 safetyDeposit)',
]

export interface EscrowSrcWatcherOpts {
  chainId: number
  rpc: string
  factoryAddr: string
  // log prefix, e.g. "Chain A" / "Chain B"
  label: string
}

// Watches a chain's EscrowSrcFactory for SlotFilled and records the filler
// address on the slot automatically — fillers no longer need to self-report
// via PATCH /cc/orders/:hash/slots/:index/filler.
export function startEscrowSrcWatcher(opts: EscrowSrcWatcherOpts): void {
  const { chainId, rpc, factoryAddr, label } = opts

  const provider = new ethers.providers.JsonRpcProvider(rpc)
  // Same mitigation as escrowDstWatcher — avoid connection churn against
  // Anvil's --block-time chains.
  provider.pollingInterval = 12000
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider)

  console.log(`[${label}] src watcher started — chain ${chainId} EscrowSrcFactory: ${factoryAddr}`)

  // Same checkpointed getLogs-on-new-block pattern proven reliable for
  // escrowDstWatcher — contract.on(event, ...) does not fire reliably here.
  const checkpointName = `escrow_src_${chainId}`
  let lastBlock = -1

  ;(async () => {
    await ensureIndexerStateTable()
    const current = await provider.getBlockNumber()
    console.log(`[${label}] src watcher connected  block #${current}`)
    lastBlock = await resolveCheckpoint(checkpointName, current, `[${label}] src`)
  })()

  provider.on('block', async (blockNumber: number) => {
    if (lastBlock < 0 || blockNumber <= lastBlock) return
    const fromBlock = lastBlock + 1
    try {
      const logs = await factory.queryFilter(factory.filters.SlotFilled(), fromBlock, blockNumber)
      for (const log of logs) {
        const { orderHash, slotIndex, filler } = log.args!
        console.log(`[${label}] SlotFilled  order=${orderHash.slice(0,10)}…  slot=${slotIndex}  filler=${filler}`)
        try {
          await handleSlotFilled(label, chainId, orderHash, Number(slotIndex), filler)
        } catch (e: any) {
          console.error(`[${label}] error handling SlotFilled ${orderHash.slice(0,10)}…:`, e?.message ?? e)
        }
      }
      lastBlock = blockNumber
      await setCheckpoint(checkpointName, lastBlock)
    } catch (e) {
      console.error(`[${label}] poll error (SlotFilled):`, e)
    }
  })
}

async function handleSlotFilled(
  label: string,
  chainId: number,
  orderHash: string,
  slotIndex: number,
  filler: string
): Promise<void> {
  // Sanity check: the order's recorded source chain must match the chain
  // this watcher is running on (catches misconfigured registries).
  const o = await db.query('SELECT chain_a_id FROM cc_orders WHERE order_hash = $1', [orderHash])
  if (!o.rows.length) {
    console.log(`[${label}] unknown order ${orderHash} — not ours, ignoring`)
    return
  }
  if (o.rows[0].chain_a_id !== chainId) {
    console.warn(`[${label}] order's chain_a_id=${o.rows[0].chain_a_id}, but this watcher is on chain ${chainId} — skipping`)
    return
  }

  await updateSlotFiller(orderHash, slotIndex, filler)
  console.log(`[${label}] recorded filler ${filler} for order=${orderHash.slice(0,10)}… slot=${slotIndex}`)
}
