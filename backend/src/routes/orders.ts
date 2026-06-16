import { Router, Request, Response } from 'express'
import { createOrder, getOrders, getOrder, cancelOrder } from '../services/orderService'
import { verifyToken } from '../services/adminAuth'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  try {
    const result = await createOrder(req.body)
    res.status(201).json(result)
  } catch (e: any) {
    res.status(400).json({ error: e.message })
  }
})

router.get('/', async (req: Request, res: Response) => {
  try {
    const { swapper, status, page, limit } = req.query
    const result = await getOrders(
      swapper as string,
      status as string,
      page ? parseInt(page as string) : 1,
      limit ? parseInt(limit as string) : 20
    )
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/:hash', async (req: Request, res: Response) => {
  try {
    const hash = req.params['hash'] as string
    const order = await getOrder(hash)
    if (!order) return res.status(404).json({ error: 'Not found' })
    res.json(order)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// Trufy 3.7: cancellation is now admin-authenticated (cryptographic bearer
// token), not a spoofable x-swapper header — previously any caller who knew a
// victim's address could flip their still-fillable order to 'cancelled' in the
// DB. NOTE: this only updates backend bookkeeping. The on-chain order is a
// signed message; true on-chain cancellation is the swapper invalidating their
// nonce (PartialFillReactor.invalidateNonce) from their own wallet — the backend
// cannot do that on the swapper's behalf.
router.delete('/:hash', async (req: Request, res: Response) => {
  try {
    const token = Array.isArray(req.headers['x-admin-token'])
      ? req.headers['x-admin-token'][0]
      : req.headers['x-admin-token']
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const hash   = req.params['hash'] as string
    const result = await cancelOrder(hash)
    res.json(result)
  } catch (e: any) {
    res.status(400).json({ error: e.message })
  }
})

export default router