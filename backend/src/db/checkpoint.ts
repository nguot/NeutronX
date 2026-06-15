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

// Anvil forwards eth_getLogs ranges that fall below its fork point to the
// upstream RPC, and Alchemy's free tier rejects ranges > 10 blocks there. A
// checkpoint persisted from an earlier session (different fork height, or a
// non-forked anvil) can sit far below — or above — the current tip, by
// millions of blocks. There's nothing to backfill in local dev, so self-heal
// by rewinding to currentBlock once the drift is implausibly large for a
// single session — while still tolerating a real backlog (e.g. backend was
// down for a while on a --block-time chain).
const MAX_CHECKPOINT_LAG = 1000

export async function resolveCheckpoint(name: string, currentBlock: number, label: string): Promise<number> {
  let last = await getCheckpoint(name, currentBlock)
  if (Math.abs(currentBlock - last) > MAX_CHECKPOINT_LAG) {
    console.warn(`${label}: checkpoint ${last} too far from tip ${currentBlock} (chain reset?) — rewinding`)
    last = currentBlock
    await setCheckpoint(name, last)
  }
  return last
}
