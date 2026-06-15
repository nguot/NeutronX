export interface TokenMeta {
  address:  string
  decimals: number
  symbol:   string
}

export interface AggregatorQuote {
  /** Router/aggregator contract to approve `amountIn` to and call `calldata` on. */
  router:       string
  calldata:     string
  minAmountOut: bigint
}

export interface QuoteParams {
  chainId:   number
  rpcUrl:    string
  tokenIn:   TokenMeta
  tokenOut:  TokenMeta
  amountIn:  bigint
  /** Address that should end up holding `tokenOut` (the swapper). */
  recipient: string
  /** Address that will hold + approve `tokenIn` when the swap executes (FallbackExecutor). */
  sender:    string
}

/**
 * One implementation per DEX aggregator backend (Uniswap, 1inch, 0x, ...).
 * Adding a new aggregator means adding one adapter implementing this
 * interface and registering it in `aggregators/index.ts` — nothing else
 * (contract, watcher loop, frontend) needs to change.
 */
export interface AggregatorAdapter {
  key:  string
  name: string
  isAvailable(chainId: number): boolean
  getQuote(params: QuoteParams): Promise<AggregatorQuote | null>
}
