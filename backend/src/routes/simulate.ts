import { Router, Request, Response } from 'express'
import { simulateOrder, SimQuoteRequest } from '../services/fillerSim'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  const body: SimQuoteRequest = req.body

  if (!body.inputToken || !body.outputToken || !body.inputAmount || !body.startPrice || body.decayPerBlock == null) {
    res.status(400).json({ error: 'Missing required fields: inputToken, outputToken, inputAmount, startPrice, decayPerBlock' })
    return
  }

  res.json(await simulateOrder(body))
})

export default router
