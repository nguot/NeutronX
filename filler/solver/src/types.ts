// Shared types across all modules.
// FillDecision and FillPath are the two "contracts" a filler must fulfill.

export interface FillSummary {
  id:           string
  filler:       string
  fillAmount:   string
  outputAmount: string
  txHash:       string
  blockNumber:  number | null
  createdAt:    string
}

// Matches GET /orders/:hash from the backend
export interface OrderInfo {
  hash:          string
  swapper:       string
  inputToken:    string
  outputToken:   string
  inputAmount:   string   // uint256 as decimal string
  minOutput:     string
  deadline:      number   // block number, NOT timestamp
  nonce:         number
  minFillBps:    number   // minimum fill size in basis points of inputAmount
  startPrice:    string   // uint128: outputAmount per inputAmount, scaled 1e18
  decayPerBlock: number   // price drops this many units per block
  feeTier:       number   // Uniswap pool fee hint (e.g. 500, 3000, 10000)
  signature:     string   // cosigner EIP-712 sig — required for executePartialChunk
  status:        'pending' | 'active' | 'filled' | 'cancelled'
  fills:         FillSummary[]
}

// Returned by strategy/strategy.ts
export interface FillDecision {
  shouldFill:   boolean
  fillAmount:   bigint
  currentPrice: bigint   // decayed price (scaled 1e18); valid only when shouldFill = true
  reason?:      string
}

// A single hop in the filler's liquidity path
export interface PathStep {
  tokenIn:  string                      // token address
  tokenOut: string                      // token address
  pool:     string                      // pool/venue address
  type:     'public' | 'private' | 'cow'
}

// Returned by graph/pathBuilder.ts
export interface FillPath {
  steps:        PathStep[]
  outputAmount: bigint    // actual output tokens the filler will deliver
}
