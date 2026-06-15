import { Router, Request, Response } from 'express'
import { checkFallbackRoute } from '../watcher/fallbackWatcher'

const router = Router()

// GET /fallback/check/:hash — dry-run the fallback watcher's aggregator
// quoting for an order, without executing anything on-chain. Lets the
// Orders UI show whether (and why) the fallback route would currently
// succeed for this order.
router.get('/check/:hash', async (req: Request, res: Response) => {
  try {
    const result = await checkFallbackRoute(req.params['hash'] as string)
    res.json(result)
  } catch (e: any) {
    res.status(400).json({ error: e.message })
  }
})

export default router
