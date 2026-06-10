import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

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
})

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<AppConfig>(DEFAULT)
  const [loading, setLoading] = useState(false)

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

  function setBackendUrl(url: string) {
    setCfg(prev => ({ ...prev, backendUrl: url }))
  }

  return (
    <Ctx.Provider value={{ ...cfg, setBackendUrl, reload, loading }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAppConfig() { return useContext(Ctx) }
