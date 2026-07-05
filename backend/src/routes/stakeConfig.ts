import { Router, Request, Response } from 'express'
import { db } from '../db/client'

const router = Router()

// GET /stake-config/history?limit=100 — most-recent-first feed of StakeConfig
// changes (see indexer/stakeConfigIndexer.ts). Public/read-only — the frontend's
// Overview/Guardian/ParamAdmin panels read LIVE state straight from the chain;
// this is the one piece (past history) that only the indexer can answer.
router.get('/history', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  try {
    const { rows } = await db.query(
      `SELECT id, event_type, block_number, tx_hash, effective_at, config_snapshot, created_at
       FROM stake_config_history
       ORDER BY block_number DESC, id DESC
       LIMIT $1`,
      [limit]
    )
    res.json({ history: rows })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
