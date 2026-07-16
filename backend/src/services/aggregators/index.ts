import { AggregatorAdapter } from './types'
import { uniswapAdapter } from './uniswap'
import { oneInchAdapter } from './oneinch'
import { kyberswapAdapter } from './kyberswap'
import { paraswapAdapter } from './paraswap'

export * from './types'

// Adding aggregator #N: write an adapter implementing AggregatorAdapter and
// add it to this list. It then shows up automatically in fallbackWatcher's
// "auto" best-price comparison and in the /config/aggregators API.
//
// paraswapAdapter's two-address model (approve tokenTransferProxy, call
// Augustus) is resolved on-chain via FallbackExecutor.approveTargetOf[router]
// (owner-registered per router, see Deploy.s.sol) rather than a parameter
// here — so this adapter needs no special-casing versus the others.
export const AGGREGATORS: AggregatorAdapter[] = [
  uniswapAdapter,
  oneInchAdapter,
  kyberswapAdapter,
  paraswapAdapter,
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
