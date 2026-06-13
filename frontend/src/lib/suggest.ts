// Shared parameter-suggestion client, used by both the Swap (DutchAuction) and
// Simulate pages so they request and interpret /suggest-params identically.
export interface Suggestion {
  startPrice:           string
  minOutputAmount:      string
  decayPerBlock:        number
  deadline:             number
  minFillBps:           number
  marketRate:           string
  currentBlock:         number
  decayHuman:           number
  startPriceHuman:      number
  floorPriceHuman:      number
  projectedCoverageBps: number
  meetsTarget:          boolean
  note:                 string
}

export interface SuggestArgs {
  inputToken:     string
  outputToken:    string
  inputAmount:    string   // wei
  inputDecimals:  number
  outputDecimals: number
  inputSymbol:    string
  outputSymbol:   string
}

export async function requestSuggestion(backendUrl: string, args: SuggestArgs): Promise<Suggestion> {
  const res  = await fetch(`${backendUrl}/suggest-params`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Suggestion failed')
  return data as Suggestion
}
