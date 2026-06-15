import { readFileSync } from 'fs'
import { resolve } from 'path'

export interface ChainConfig {
  id: number
  name: string
  rpc: string
  confirmations: number
  escrowSrcFactory: string
  escrowDstFactory: string
}

let cache: ChainConfig[] | null = null

export function loadChainRegistry(): ChainConfig[] {
  if (cache) return cache
  const raw = readFileSync(resolve(process.cwd(), 'config', 'chains.json'), 'utf-8')
  const parsed = JSON.parse(raw) as ChainConfig[]
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('config/chains.json: must be a non-empty array')
  }
  for (const c of parsed) {
    if (!c.id || !c.rpc || !c.escrowSrcFactory || !c.escrowDstFactory) {
      throw new Error(`config/chains.json: chain ${c.id ?? '?'} missing required field`)
    }
  }
  cache = parsed
  return cache
}

export function getChain(id: number): ChainConfig {
  const c = loadChainRegistry().find(c => c.id === id)
  if (!c) throw new Error(`Unknown chain id ${id} — not in config/chains.json`)
  return c
}

export function chainIds(): number[] {
  return loadChainRegistry().map(c => c.id)
}

// Only valid for a 2-chain registry — used solely by the dst_chain_id
// backfill migration for pre-existing rows.
export function otherChain(id: number): ChainConfig {
  const all = loadChainRegistry()
  if (all.length !== 2) throw new Error('otherChain() only valid for a 2-chain registry')
  const other = all.find(c => c.id !== id)
  if (!other) throw new Error(`Chain ${id} not found in registry`)
  return other
}
