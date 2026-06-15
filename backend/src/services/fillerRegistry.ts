import { db } from '../db/client'

export interface FillerEntry {
  name:    string
  url:     string
  address: string    // filler's on-chain wallet address (used by preflight / fill ranking)
  chains:  number[]  // chain ids (from config/chains.json) this filler operates on
}

// ─── Schema + seed (called once at startup) ───────────────────────────────────
export async function initFillerSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_fillers (
      name    VARCHAR(64) PRIMARY KEY,
      url     TEXT NOT NULL,
      address VARCHAR(42) NOT NULL DEFAULT '',
      chains  JSONB NOT NULL DEFAULT '[]'
    )
  `)
  // Seed the dev fillers from .env on first run (no-op once rows exist).
  if (process.env.WHALE_FILLER_QUOTE_URL) {
    await db.query(
      `INSERT INTO cc_fillers (name, url) VALUES ('WhaleFiller', $1) ON CONFLICT (name) DO NOTHING`,
      [process.env.WHALE_FILLER_QUOTE_URL]
    )
  }
  if (process.env.COW_FILLER_QUOTE_URL) {
    await db.query(
      `INSERT INTO cc_fillers (name, url) VALUES ('CoWFiller', $1) ON CONFLICT (name) DO NOTHING`,
      [process.env.COW_FILLER_QUOTE_URL]
    )
  }
}

export const fillerRegistry = {
  async list(): Promise<FillerEntry[]> {
    const r = await db.query('SELECT name, url, address, chains FROM cc_fillers ORDER BY name')
    return r.rows.map(row => ({ name: row.name, url: row.url, address: row.address, chains: row.chains }))
  },

  async add(name: string, url: string, address = '', chains: number[] = []): Promise<void> {
    const existing = await db.query('SELECT 1 FROM cc_fillers WHERE name = $1', [name])
    if (existing.rows.length) throw new Error('filler already exists')
    await db.query(
      'INSERT INTO cc_fillers (name, url, address, chains) VALUES ($1, $2, $3, $4)',
      [name, url, address, JSON.stringify(chains)]
    )
  },

  async update(name: string, patch: Partial<Pick<FillerEntry, 'url' | 'address' | 'chains'>>): Promise<void> {
    const sets: string[] = []
    const vals: unknown[] = []
    if (patch.url !== undefined)     { sets.push(`url = $${sets.length + 1}`);     vals.push(patch.url) }
    if (patch.address !== undefined) { sets.push(`address = $${sets.length + 1}`); vals.push(patch.address) }
    if (patch.chains !== undefined)  { sets.push(`chains = $${sets.length + 1}`);  vals.push(JSON.stringify(patch.chains)) }
    if (sets.length === 0) return
    vals.push(name)
    const r = await db.query(`UPDATE cc_fillers SET ${sets.join(', ')} WHERE name = $${vals.length}`, vals)
    if (r.rowCount === 0) throw new Error('filler not found')
  },

  async remove(name: string): Promise<void> {
    const r = await db.query('DELETE FROM cc_fillers WHERE name = $1', [name])
    if (r.rowCount === 0) throw new Error('filler not found')
  },
}
