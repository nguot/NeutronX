import { Router, Request, Response } from 'express'
import { createOrder, getOrders, getOrder, cancelOrder } from '../services/orderService'

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

router.delete('/:hash', async (req: Request, res: Response) => {
  try {
    const hash    = req.params['hash'] as string
    const swapper = Array.isArray(req.headers['x-swapper'])
      ? req.headers['x-swapper'][0]
      : req.headers['x-swapper']
    if (!swapper) return res.status(401).json({ error: 'Missing x-swapper header' })
    const result = await cancelOrder(hash, swapper)
    res.json(result)
  } catch (e: any) {
    res.status(400).json({ error: e.message })
  }
})

export default router