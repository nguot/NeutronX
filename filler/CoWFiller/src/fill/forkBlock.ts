import { ethers } from 'ethers'

// Anvil's own RPC extension reports exactly which block it forked from — no
// need to hand-maintain a FORK_BLOCK constant that silently drifts out of
// sync with setup.sh/chaina_anvil.sh/chainb_anvil.sh whenever the fork point
// is bumped (it did, twice). Cached per RPC endpoint since a chain's fork
// point is fixed for the life of the anvil process.
const cache = new Map<string, number>()

export async function getForkBlock(provider: ethers.providers.Provider): Promise<number> {
  const rpc = provider as ethers.providers.JsonRpcProvider
  const key = rpc.connection?.url ?? 'default'
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const info = await rpc.send('anvil_nodeInfo', [])
  const forkBlock: number = info.forkConfig.forkBlockNumber
  cache.set(key, forkBlock)
  return forkBlock
}
