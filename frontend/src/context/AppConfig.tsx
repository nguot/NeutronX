import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { type TokenInfo } from '../lib/tokens'

export interface AppConfig {
  backendUrl:         string
  partialFillReactor: string
  crossChainReactor:  string
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

const DEFAULT: AppConfig = {
  backendUrl:         'http://localhost:3000',
  partialFillReactor: '',
  crossChainReactor:  '',
  chainBFactory:      '',
  chainBRpc:          'http://127.0.0.1:8546',
  chainARpc:          'http://127.0.0.1:8545',
  chainId:            '31337',
}

const Ctx = createContext<AppConfigCtx>({
  ...DEFAULT,
  setBackendUrl: () => {},
  reload: () => {},
  loading: false,
  tokens: [],
  currentBlock: null,
})

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<AppConfig>(DEFAULT)
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

  // Poll the Chain A head so any page can render block-deadline ETAs in human time.
  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const r = await fetch(`${cfg.backendUrl}/admin/blocks`)
        const d = await r.json()
        if (!stop && typeof d.chainA === 'number') setCurrentBlock(d.chainA)
      } catch { /* backend not running yet */ }
    }
    tick()
    const id = setInterval(tick, 6000)
    return () => { stop = true; clearInterval(id) }
  }, [cfg.backendUrl])

  function setBackendUrl(url: string) {
    setCfg(prev => ({ ...prev, backendUrl: url }))
  }

  return (
    <Ctx.Provider value={{ ...cfg, setBackendUrl, reload, loading, tokens, currentBlock }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAppConfig() { return useContext(Ctx) }
