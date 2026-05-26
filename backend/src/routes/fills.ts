import { Router, Request, Response } from 'express'
import { db } from '../db/client'

const router = Router()

// GET /fills?order=0x...&filler=0x...&limit=50
router.get('/', async (req: Request, res: Response) => {
  try {
    const { order, filler, limit = '50', page = '1' } = req.query

    const conditions: string[] = []
    const params: any[] = []
    let idx = 1

    if (order)  { conditions.push(`f.order_hash = $${idx++}`); params.push(order) }
    if (filler) { conditions.push(`f.filler = $${idx++}`);     params.push(filler) }

    const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
    const lim    = Math.min(parseInt(limit as string), 200)
    const offset = (parseInt(page as string) - 1) * lim

    const rows = await db.query(`
      SELECT
        f.id, f.order_hash, f.filler,
        f.fill_amount, f.output_amount,
        f.tx_hash, f.block_number, f.created_at,
        o.input_token, o.output_token, o.input_amount AS order_total
      FROM fills f
      JOIN orders o ON o.hash = f.order_hash
      ${where}
      ORDER BY f.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, lim, offset])

    const total = await db.query(
      `SELECT COUNT(*) FROM fills f ${where}`, params
    )

    res.json({
      fills: rows.rows.map(f => ({
        id:           f.id,
        orderHash:    f.order_hash,
        filler:       f.filler,
        fillAmount:   f.fill_amount,
        outputAmount: f.output_amount,
        txHash:       f.tx_hash,
        blockNumber:  f.block_number ? parseInt(f.block_number) : null,
        createdAt:    f.created_at.toISOString(),
        inputToken:   f.input_token,
        outputToken:  f.output_token,
        orderTotal:   f.order_total,
      })),
      total: parseInt(total.rows[0].count),
      page:  parseInt(page as string),
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
