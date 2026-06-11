import { useEffect, useMemo, useState } from 'react'
import { useAppConfig } from '../context/AppConfig'

interface CCTokenInfo { symbol: string; address: string; decimals: number; chainId: number }
interface Row extends CCTokenInfo { name: string; role: 'input' | 'output' | 'infra' }

const PERMIT2: Row = {
  symbol: 'Permit2', address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', decimals: 0,
  chainId: 0, role: 'infra', name: 'Approval router used by both reactors',
}

const ICON_COLORS = ['#7c3aed', '#2563eb', '#16a34a', '#ea580c', '#db2777', '#0891b2']
function iconColor(symbol: string) {
  let hash = 0
  for (const c of symbol) hash = (hash * 31 + c.charCodeAt(0)) % ICON_COLORS.length
  return ICON_COLORS[Math.abs(hash)]
}
function short(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}` }
function copy(text: string) { navigator.clipboard?.writeText(text) }

export default function Explore() {
  const { backendUrl, chainId, chainARpc, chainBRpc } = useAppConfig()
  const [inputTokens,  setInputTokens]  = useState<CCTokenInfo[]>([])
  const [outputTokens, setOutputTokens] = useState<CCTokenInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch(`${backendUrl}/cc/tokens`)
      .then(r => r.json())
      .then(data => {
        setInputTokens(data.inputTokens ?? [])
        setOutputTokens(data.outputTokens ?? [])
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [backendUrl])

  const chainAId = inputTokens[0]?.chainId  ?? Number(chainId) ?? 31337
  const chainBId = outputTokens[0]?.chainId ?? 31338

  const chains = [
    { id: chainAId, name: 'Anvil — Chain A', role: 'Source chain (swapper funds locked here)', rpcUrl: chainARpc },
    { id: chainBId, name: 'Anvil — Chain B', role: 'Destination chain (filler output tokens)', rpcUrl: chainBRpc },
  ]

  const rows: Row[] = useMemo(() => [
    ...inputTokens.map(t => ({ ...t, role: 'input' as const, name: 'Input token — locked by the swapper on Chain A' })),
    { ...PERMIT2, chainId: chainAId },
    ...outputTokens.map(t => ({ ...t, role: 'output' as const, name: 'Output token — claimed by fillers on Chain B' })),
  ], [inputTokens, outputTokens, chainAId])

  const filtered = rows.filter(r => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return r.symbol.toLowerCase().includes(q) || r.address.toLowerCase().includes(q)
  })

  return (
    <>
      <div className="page-header">
        <div className="page-title">Explore</div>
        <div className="page-sub">
          Tokens and chains configured for this devnet, loaded live from{' '}
          <code>GET /cc/tokens</code> and the admin config — click an address to copy.
        </div>
      </div>

      {/* Chains */}
      <div className="chain-chips">
        {chains.map(c => (
          <div key={c.id} className="chain-chip">
            <div className="chain-chip-icon">⬡</div>
            <div className="chain-chip-info">
              <div className="chain-chip-name">
                {c.name} <span className="badge chain">chain {c.id}</span>
              </div>
              <div className="chain-chip-sub" title={c.role}>{c.role}</div>
              <div className="chain-chip-sub" title={c.rpcUrl}>RPC {c.rpcUrl}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="explore-search">
        <span className="explore-search-icon">🔍</span>
        <input placeholder="Search by symbol or address" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {!loaded && <div className="status info">Loading…</div>}
      {loaded && rows.length <= 1 && (
        <div className="status warn">
          Couldn't load the token directory from the backend — is it running and is <code>cc_tokens</code> seeded?
        </div>
      )}

      {/* Tokens table */}
      {filtered.length > 0 && (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Token</th>
                <th>Chain</th>
                <th>Decimals</th>
                <th>Address</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t, i) => (
                <tr key={`${t.chainId}-${t.address}`}>
                  <td className="text-muted">{i + 1}</td>
                  <td>
                    <div className="token-row">
                      <div className="token-icon" style={{ background: iconColor(t.symbol) }}>
                        {t.symbol.slice(0, 1)}
                      </div>
                      <div className="token-meta">
                        <span className="token-symbol">{t.symbol}</span>
                        <span className="token-name">{t.name}</span>
                      </div>
                    </div>
                  </td>
                  <td>{t.chainId ? <span className="badge chain">chain {t.chainId}</span> : <span className="text-muted">all chains</span>}</td>
                  <td className="text-muted">{t.decimals}</td>
                  <td>
                    <div className="addr-cell">
                      <span title={t.address}>{short(t.address)}</span>
                      <button className="copy-btn" onClick={() => copy(t.address)} title="Copy address">⧉</button>
                    </div>
                  </td>
                  <td><span className={`badge ${t.role}`}>{t.role}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
