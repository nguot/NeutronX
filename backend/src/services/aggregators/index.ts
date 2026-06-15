import { AggregatorAdapter } from './types'
import { uniswapAdapter } from './uniswap'
import { oneInchAdapter } from './oneinch'
import { kyberswapAdapter } from './kyberswap'

export * from './types'

// Adding aggregator #N: write an adapter implementing AggregatorAdapter and
// add it to this list. It then shows up automatically in fallbackWatcher's
// "auto" best-price comparison and in the /config/aggregators API.
//
// paraswapAdapter (./paraswap.ts) is implemented but NOT registered here yet:
// its router (Augustus) isn't in FallbackExecutor's allowedRouters, and its
// two-address approve-then-call model (approve tokenTransferProxy, call `to`)
// doesn't fit forceApprove(router, rem); router.call(...) without a contract
// change. Registering it as-is makes "auto" pick it and revert on-chain.
export const AGGREGATORS: AggregatorAdapter[] = [
  uniswapAdapter,
  oneInchAdapter,
  kyberswapAdapter,
]

export function getAggregator(key: string): AggregatorAdapter | undefined {
  return AGGREGATORS.find(a => a.key === key)
}

export function availableAggregators(chainId: number): AggregatorAdapter[] {
  return AGGREGATORS.filter(a => a.isAvailable(chainId))
}

// Dev forks report the anvil --chain-id (e.g. 31337) via eth_chainId, but the
// forked state (Uniswap pools, SwapRouter02, ...) belongs to whatever chain
// was forked (mainnet, chainId 1). AGGREGATOR_CHAIN_ID lets the aggregator
// layer target that real underlying chain, independent of the EIP-712
// domain-separator chainId (which must keep using the RPC's reported value).
export function resolveAggregatorChainId(networkChainId: number): number {
  const override = process.env.AGGREGATOR_CHAIN_ID
  return override ? parseInt(override, 10) : networkChainId
}
