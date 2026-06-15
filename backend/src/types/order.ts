export interface OrderInput {
  swapper:         string
  inputToken:      string
  inputAmount:     string
  outputToken:     string
  minOutputAmount: string
  deadline:        number
  nonce:           number
  minFillBps:      number
  startPrice:      string
  decayPerBlock:   number
  feeTier:         number
}

export interface CreateOrderRequest {
  order:     OrderInput
  signature: string
  /** Aggregator key (see GET /config/aggregators) to use for the fallback
   *  route, or omit/null for "auto" — best price across all of them. */
  preferredAggregator?: string | null
}

export interface CreateOrderResponse {
  orderHash: string
  status:    string
}

export interface OrderSummary {
  hash:        string
  swapper:     string
  inputToken:  string
  outputToken: string
  inputAmount: string
  minOutput:   string
  deadline:    number
  status:      string
  fills:       number
  createdAt:   string
  preferredAggregator: string | null
}

export interface FillSummary {
  id:           string
  filler:       string
  fillAmount:   string
  outputAmount: string
  txHash:       string
  path:         PathStep[] | null
  blockNumber:  number | null
  createdAt:    string
}

export interface PathStep {
  tokenIn:  string
  tokenOut: string
  pool:     string
  type:     'public' | 'private' | 'cow'
}

export interface OrderDetail extends Omit<OrderSummary, 'fills'> {
  nonce:         number
  minFillBps:    number
  startPrice:    string
  decayPerBlock: number
  feeTier:       number
  signature:     string
  fills:         FillSummary[]
}

export interface GetOrdersRequest {
  swapper?: string
  status?:  string
  page?:    number
  limit?:   number
}

export interface GetOrdersResponse {
  orders: OrderSummary[]
  total:  number
  page:   number
}

export interface CancelOrderResponse {
  success:   boolean
  orderHash: string
}

export interface ErrorResponse {
  error: string
}