export interface FillSummary {
  id:           string
  filler:       string
  fillAmount:   string
  outputAmount: string
  txHash:       string
  blockNumber:  number | null
  createdAt:    string
}

export interface OrderInfo {
  hash:          string
  swapper:       string
  inputToken:    string
  outputToken:   string
  inputAmount:   string
  minOutput:     string
  deadline:      number
  nonce:         number
  minFillBps:    number
  startPrice:    string
  decayPerBlock: number
  feeTier:       number
  signature:     string
  status:        'pending' | 'active' | 'filled' | 'cancelled'
  fills:         FillSummary[]
}

export interface FillDecision {
  shouldFill:   boolean
  fillAmount:   bigint
  currentPrice: bigint
  reason?:      string
  extras?:      Record<string, unknown>
}
