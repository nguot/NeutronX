import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { type TokenInfo } from '../lib/tokens'

export interface ChainConfig {
  id: number
  name: string
  rpc: string
  confirmations: number
  escrowSrcFactory: string
  escrowDstFactory: string
}

interface RawConfig {
  backendUrl:         string
  partialFillReactor: string
  fallbackExecutor:   string
  chains:             ChainConfig[]
}

export interface AppConfig extends RawConfig {
  // Derived from chains[0]/chains[1] for pages not yet migrated to the N-chain
  // registry (CrossChain.tsx, Explore.tsx, Admin.tsx ConfigTab). See M2 in
  // the chain-registry refactor plan.
  crossChainReactor:  string
  escrowSrcFactoryB:  string
  chainBFactory:      string
  chainBRpc:          string
  chainARpc:          string
  chainId:            string
}

interface AppConfigCtx extends AppConfig {
  setBackendUrl: (url: string) => void
  reload:        () => void
  loading:       boolean
  tokens:        TokenInfo[]   // DB-backed token directory (Chain A) for the swap UI
  currentBlock:  number | null // Chain A head, polled — powers block→time deadline ETAs
}

const DEFAULT: RawConfig = {
  backendUrl:         'http://localhost:3000',
  partialFillReactor: '',
  fallbackExecutor:   '',
  chains:             [],
}

function deriveLegacy(chains: ChainConfig[]): Omit<AppConfig, keyof RawConfig> {
  const [a, b] = chains
  return {
    crossChainReactor: a?.escrowSrcFactory ?? '',
    escrowSrcFactoryB: b?.escrowSrcFactory ?? '',
    chainBFactory:     b?.escrowDstFactory ?? '',
    chainBRpc:         b?.rpc ?? '',
    chainARpc:         a?.rpc ?? '',
    chainId:           String(a?.id ?? ''),
  }
}

const Ctx = createContext<AppConfigCtx>({
  ...DEFAULT,
  ...deriveLegacy(DEFAULT.chains),
  setBackendUrl: () => {},
  reload: () => {},
  loading: false,
  tokens: [],
  currentBlock: null,
})

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<RawConfig>(DEFAULT)
  const [loading, setLoading] = useState(false)
  const [tokens, setTokens] = useState<TokenInfo[]>([])
  const [currentBlock, setCurrentBlock] = useState<number | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${cfg.backendUrl}/admin/config`)
      if (res.ok) {
        const data = await res.json()
        setCfg(prev => ({ ...prev, ...data }))
      }
    } catch { /* backend not running yet */ }
    finally { setLoading(false) }
  }, [cfg.backendUrl])

  useEffect(() => { reload() }, [cfg.backendUrl])

  // DB-backed token directory for the swap UI's token pills (Chain A tokens).
  useEffect(() => {
    fetch(`${cfg.backendUrl}/tokens`)
      .then(r => r.json())
      .then(d => setTokens(d.tokens ?? []))
      .catch(() => { /* backend not running yet */ })
  }, [cfg.backendUrl])

  // Poll Chain A's head so any page can render block-deadline ETAs in human time.
  useEffect(() => {
    const chainAId = cfg.chains[0]?.id
    if (chainAId == null) return
    let stop = false
    const tick = async () => {
      try {
        const r = await fetch(`${cfg.backendUrl}/admin/blocks`)
        const d = await r.json()
        const b = d.blocks?.[chainAId]
        if (!stop && typeof b === 'number') setCurrentBlock(b)
      } catch { /* backend not running yet */ }
    }
    tick()
    const id = setInterval(tick, 15000)
    return () => { stop = true; clearInterval(id) }
  }, [cfg.backendUrl, cfg.chains])

  function setBackendUrl(url: string) {
    setCfg(prev => ({ ...prev, backendUrl: url }))
  }

  return (
    <Ctx.Provider value={{ ...cfg, ...deriveLegacy(cfg.chains), setBackendUrl, reload, loading, tokens, currentBlock }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAppConfig() { return useContext(Ctx) }
