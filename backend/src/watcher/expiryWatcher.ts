import { ethers } from 'ethers'
import { db } from '../db/client'
import * as dotenv from 'dotenv'
dotenv.config()

// Orders sit in 'pending'/'active' forever once their deadline passes unless
// something explicitly moves them — no filler can fill past deadline (the
// reactor itself enforces this) and FallbackExecutor only accepts
// block.number <= deadline (FallbackExecutor.sol:81), so once the current
// block is strictly past it, the order is permanently dead. Mark it
// 'expired' so the UI stops presenting it as fillable.
export async function startExpiryWatcher() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL)

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber()
      const { rowCount } = await db.query(`
        UPDATE orders SET status = 'expired'
        WHERE status IN ('pending', 'active') AND deadline < $1
      `, [currentBlock])
      if (rowCount && rowCount > 0) {
        console.log(`Expiry watcher: marked ${rowCount} order(s) expired (block ${currentBlock})`)
      }
    } catch (e) {
      console.error('Expiry watcher error:', e)
    }
  }, 12000)
}
