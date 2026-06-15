import { Router } from 'express'
import { listTokens, SINGLE_CHAIN_ID } from '../services/tokenService'

const router = Router()

// GET /tokens?chainId=31337
// Token directory for the single-chain swap UI. Defaults to Chain A (the mainnet
// fork the Dutch-auction swap runs on). Pass ?chainId= to query another chain,
// or ?chainId=all for every chain.
router.get('/', async (req, res) => {
  try {
    const raw = req.query.chainId as string | undefined
    const chainId = raw === 'all' ? undefined : (raw ? parseInt(raw) : SINGLE_CHAIN_ID)
    const tokens = await listTokens(chainId)
    return res.json({ tokens })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

export default router
