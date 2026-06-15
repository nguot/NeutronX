import { Router } from 'express'
import { ethers } from 'ethers'
import { availableAggregators, resolveAggregatorChainId } from '../services/aggregators'

const router = Router()

// Same RPC the fallback watcher runs against — cache the chainId lookup,
// it never changes for a running backend.
let cachedChainId: number | null = null
async function resolveChainId(): Promise<number> {
  if (cachedChainId !== null) return cachedChainId
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.ALCHEMY_RPC_URL || process.env.RPC_URL || 'http://127.0.0.1:8545'
  )
  const { chainId } = await provider.getNetwork()
  cachedChainId = resolveAggregatorChainId(chainId)
  return cachedChainId
}

// GET /aggregators?chainId=1
// Lists fallback-route aggregators usable on a chain, for the order-creation
// "preferred aggregator" picker. "auto" (best price across all of them) is
// always offered on top of whatever this returns.
router.get('/', async (req, res) => {
  try {
    const raw = req.query.chainId as string | undefined
    const chainId = raw ? parseInt(raw) : await resolveChainId()
    const aggregators = availableAggregators(chainId).map(a => ({ key: a.key, name: a.name }))
    res.json({ aggregators })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
