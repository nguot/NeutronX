import { ethers } from 'ethers'
import { db } from './client'

export async function ensureIndexerStateTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      name       TEXT PRIMARY KEY,
      last_block BIGINT NOT NULL
    )
  `)
}

// Returns the last block processed for `name`. The first time a watcher is
// seen, its checkpoint is seeded to the current block — i.e. "start watching
// from now" rather than replaying chain history.
export async function getCheckpoint(name: string, currentBlock: number): Promise<number> {
  const { rows } = await db.query('SELECT last_block FROM indexer_state WHERE name = $1', [name])
  if (rows.length > 0) return Number(rows[0].last_block)
  await db.query('INSERT INTO indexer_state (name, last_block) VALUES ($1, $2)', [name, currentBlock])
  return currentBlock
}

export async function setCheckpoint(name: string, block: number) {
  await db.query(
    'INSERT INTO indexer_state (name, last_block) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET last_block = $2',
    [name, block]
  )
}

// ─── Trufy 3.3 — outage recovery ────────────────────────────────────────────
// A long backend outage leaves a real backlog of events (e.g. SlotFilled) that
// must be REPLAYED on restart, not skipped. The previous logic rewound the
// checkpoint to the current tip whenever it drifted "too far", which silently
// dropped every event in the gap. We now distinguish two cases:
//   • checkpoint AHEAD of the tip   → chain reset/rollback (anvil restarted on a
//                                     fresh fork). Cannot index the future, so
//                                     rewind to tip is the only option.
//   • checkpoint BEHIND the tip     → genuine backlog. Backfill the gap (the
//                                     poll loops query it in bounded chunks via
//                                     queryFilterChunked). Only in local dev,
//                                     where a stale checkpoint from a previous
//                                     fork can sit millions of blocks back, do we
//                                     rewind once the lag is implausibly large
//                                     AND backfill is not explicitly enabled.
const DEV_REWIND_LAG = Number(process.env.INDEXER_DEV_REWIND_LAG ?? 5000)
const CHUNK_SIZE     = Number(process.env.INDEXER_CHUNK ?? 2000)
const BACKFILL =
  (process.env.INDEXER_BACKFILL ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true'

export async function resolveCheckpoint(name: string, currentBlock: number, label: string): Promise<number> {
  let last = await getCheckpoint(name, currentBlock)

  // Checkpoint ahead of the tip ⇒ the chain was reset to a lower height.
  if (last > currentBlock) {
    console.warn(`${label}: checkpoint ${last} ahead of tip ${currentBlock} (chain reset?) — rewinding`)
    last = currentBlock
    await setCheckpoint(name, last)
    return last
  }

  // Checkpoint behind the tip by an implausible margin, with backfill disabled:
  // treat as a stale local-dev fork and rewind. Production defaults BACKFILL=true,
  // so a real outage backlog is always replayed instead.
  if (currentBlock - last > DEV_REWIND_LAG && !BACKFILL) {
    console.warn(
      `${label}: checkpoint ${last} lags tip ${currentBlock} by >${DEV_REWIND_LAG} blocks and backfill is off — ` +
      `rewinding (set INDEXER_BACKFILL=true to replay the gap)`
    )
    last = currentBlock
    await setCheckpoint(name, last)
  }
  return last
}

// 3.3: query a (possibly large) block range in bounded chunks so a single
// eth_getLogs never exceeds the RPC provider's range limit when catching up
// after a long outage. Logs are returned in ascending block order.
export async function queryFilterChunked(
  contract: ethers.Contract,
  filter: ethers.EventFilter,
  fromBlock: number,
  toBlock: number,
  chunk: number = CHUNK_SIZE,
): Promise<ethers.Event[]> {
  if (toBlock < fromBlock) return []
  const out: ethers.Event[] = []
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(start + chunk - 1, toBlock)
    const logs = await contract.queryFilter(filter, start, end)
    out.push(...logs)
  }
  return out
}
