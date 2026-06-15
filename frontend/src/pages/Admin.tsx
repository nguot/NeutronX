import { useState, useEffect, useCallback } from 'react'
import { useAppConfig } from '../context/AppConfig'

type AdminTab = 'config' | 'fillers' | 'chain'

interface FillerInfo {
  name:      string
  url:       string
  address:   string
  chains:    number[]
  alive:     boolean
  latencyMs: number
  error?:    string
}

interface AdminProps {
  token: string
  onUnauthorized: () => void
}

export default function Admin({ token, onUnauthorized }: AdminProps) {
  const [tab, setTab] = useState<AdminTab>('config')

  return (
    <>
      <div className="page-header">
        <div className="page-title">Admin</div>
      </div>

      <div className="card">
        <div className="tabs" style={{ marginBottom: 24 }}>
          {([
            ['config',  '⚙ Config'],
            ['fillers', '🤖 Fillers'],
            ['chain',   '⛓ Chain Control'],
          ] as [AdminTab, string][]).map(([id, label]) => (
            <button key={id} className={`tab-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'config'  && <ConfigTab  token={token} onUnauthorized={onUnauthorized} />}
        {tab === 'fillers' && <FillersTab token={token} onUnauthorized={onUnauthorized} />}
        {tab === 'chain'   && <ChainTab   token={token} onUnauthorized={onUnauthorized} />}
      </div>
    </>
  )
}

// ── Config tab ─────────────────────────────────────────────────────────────
function ConfigTab({ token, onUnauthorized }: AdminProps) {
  const cfg = useAppConfig()
  const [form, setForm] = useState({
    backendUrl:         cfg.backendUrl,
    partialFillReactor: cfg.partialFillReactor,
    fallbackExecutor:   cfg.fallbackExecutor,
    crossChainReactor:  cfg.crossChainReactor,
    escrowSrcFactoryB:  cfg.escrowSrcFactoryB,
    chainBFactory:      cfg.chainBFactory,
    chainBRpc:          cfg.chainBRpc,
    chainARpc:          cfg.chainARpc,
    chainId:            cfg.chainId,
  })
  const [status, setStatus] = useState<{ msg: string; cls: string } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setForm({
      backendUrl:         cfg.backendUrl,
      partialFillReactor: cfg.partialFillReactor,
      fallbackExecutor:   cfg.fallbackExecutor,
      crossChainReactor:  cfg.crossChainReactor,
      escrowSrcFactoryB:  cfg.escrowSrcFactoryB,
      chainBFactory:      cfg.chainBFactory,
      chainBRpc:          cfg.chainBRpc,
      chainARpc:          cfg.chainARpc,
      chainId:            cfg.chainId,
    })
  }, [cfg.partialFillReactor, cfg.fallbackExecutor, cfg.crossChainReactor, cfg.escrowSrcFactoryB])

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function save() {
    setSaving(true)
    setStatus(null)
    try {
      if (form.backendUrl !== cfg.backendUrl) cfg.setBackendUrl(form.backendUrl)
      const res = await fetch(`${form.backendUrl}/admin/config`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body:    JSON.stringify({
          partialFillReactor: form.partialFillReactor,
          fallbackExecutor:   form.fallbackExecutor,
          crossChainReactor:  form.crossChainReactor,
          escrowSrcFactoryB:  form.escrowSrcFactoryB,
          chainBFactory:      form.chainBFactory,
          chainBRpc:          form.chainBRpc,
          chainARpc:          form.chainARpc,
          chainId:            form.chainId,
        }),
      })
      if (res.status === 401) { onUnauthorized(); return }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save')
      cfg.reload()
      setStatus({ msg: 'Config saved and reloaded.', cls: 'ok' })
    } catch (e: any) { setStatus({ msg: e.message, cls: 'bad' }) }
    finally { setSaving(false) }
  }

  return (
    <div>
      <label>Backend URL</label>
      <input value={form.backendUrl} onChange={set('backendUrl')} placeholder="http://localhost:3000" />

      <h2 className="section">Dutch-Auction (Chain A)</h2>
      <div className="row">
        <div>
          <label>PartialFillReactor Address</label>
          <input value={form.partialFillReactor} onChange={set('partialFillReactor')} placeholder="0x…" />
        </div>
        <div>
          <label>Chain A RPC</label>
          <input value={form.chainARpc} onChange={set('chainARpc')} placeholder="http://127.0.0.1:8545" />
        </div>
      </div>
      <div className="row">
        <div>
          <label>FallbackExecutor Address</label>
          <input value={form.fallbackExecutor} onChange={set('fallbackExecutor')} placeholder="0x…" />
        </div>
        <div>
          <label>Chain ID</label>
          <input value={form.chainId} onChange={set('chainId')} className="short" placeholder="31337" />
        </div>
      </div>

      <h2 className="section">Cross-Chain (Chain A ⇄ B)</h2>
      <div className="row">
        <div>
          <label>EscrowSrcFactory Address (Chain A)</label>
          <input value={form.crossChainReactor} onChange={set('crossChainReactor')} placeholder="0x…" />
        </div>
        <div>
          <label>EscrowSrcFactory Address (Chain B)</label>
          <input value={form.escrowSrcFactoryB} onChange={set('escrowSrcFactoryB')} placeholder="0x…" />
        </div>
      </div>
      <div className="row">
        <div>
          <label>EscrowDstFactory Address (Chain B)</label>
          <input value={form.chainBFactory} onChange={set('chainBFactory')} placeholder="0x…" />
        </div>
        <div>
          <label>Chain B RPC</label>
          <input value={form.chainBRpc} onChange={set('chainBRpc')} placeholder="http://127.0.0.1:8546" />
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Config'}</button>
        <button className="ghost" style={{ marginLeft: 8 }} onClick={() => cfg.reload()}>↻ Reload from backend</button>
      </div>
      {status && <div className={`status ${status.cls}`}>{status.msg}</div>}
    </div>
  )
}

// ── Fillers tab ────────────────────────────────────────────────────────────
function FillersTab({ token, onUnauthorized }: AdminProps) {
  const { backendUrl, chains } = useAppConfig()
  const [fillers, setFillers] = useState<FillerInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl,  setNewUrl]  = useState('')
  const [newAddress, setNewAddress] = useState('')
  const [newChains,  setNewChains]  = useState<number[]>([])
  const [addStatus, setAddStatus] = useState<{ msg: string; cls: string } | null>(null)

  // Inline "edit address/chains" form for an existing (possibly env-seeded) filler.
  const [editingName, setEditingName] = useState<string | null>(null)
  const [editAddress, setEditAddress] = useState('')
  const [editChains,  setEditChains]  = useState<number[]>([])
  const [editStatus,  setEditStatus]  = useState<{ msg: string; cls: string } | null>(null)

  const loadFillers = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch(`${backendUrl}/admin/fillers`)
      const data = await res.json()
      setFillers(data.fillers ?? [])
    } catch { setFillers([]) }
    finally { setLoading(false) }
  }, [backendUrl])

  useEffect(() => { loadFillers() }, [loadFillers])

  function toggleChain(list: number[], id: number): number[] {
    return list.includes(id) ? list.filter(c => c !== id) : [...list, id]
  }

  async function addFiller() {
    if (!newName || !newUrl) return setAddStatus({ msg: 'Name and URL are required', cls: 'bad' })
    setAddStatus(null)
    try {
      const res  = await fetch(`${backendUrl}/admin/fillers`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body:    JSON.stringify({ name: newName, url: newUrl, address: newAddress, chains: newChains }),
      })
      if (res.status === 401) return onUnauthorized()
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setNewName(''); setNewUrl(''); setNewAddress(''); setNewChains([])
      setAddStatus({ msg: `Filler "${newName}" added.`, cls: 'ok' })
      loadFillers()
    } catch (e: any) { setAddStatus({ msg: e.message, cls: 'bad' }) }
  }

  function startEdit(f: FillerInfo) {
    setEditingName(f.name)
    setEditAddress(f.address)
    setEditChains(f.chains)
    setEditStatus(null)
  }

  async function saveEdit() {
    if (!editingName) return
    if (editAddress && !/^0x[0-9a-fA-F]{40}$/.test(editAddress)) {
      return setEditStatus({ msg: 'Address must be a 0x… address', cls: 'bad' })
    }
    try {
      const res = await fetch(`${backendUrl}/admin/fillers/${encodeURIComponent(editingName)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body:    JSON.stringify({ address: editAddress, chains: editChains }),
      })
      if (res.status === 401) return onUnauthorized()
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setEditingName(null)
      loadFillers()
    } catch (e: any) { setEditStatus({ msg: e.message, cls: 'bad' }) }
  }

  async function removeFiller(name: string) {
    try {
      const res = await fetch(`${backendUrl}/admin/fillers/${encodeURIComponent(name)}`, {
        method: 'DELETE', headers: { 'x-admin-token': token },
      })
      if (res.status === 401) return onUnauthorized()
      loadFillers()
    } catch { /* ignore */ }
  }

  return (
    <div>
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Registered Fillers</h2>
        <button className="ghost sm" onClick={loadFillers} disabled={loading} style={{ marginTop: 0 }}>
          {loading ? '…' : '↻ Refresh'}
        </button>
      </div>

      {fillers.length === 0 && !loading && (
        <div className="empty-state" style={{ padding: '24px 0' }}>
          <div className="empty-icon">🤖</div>
          No fillers registered
        </div>
      )}

      {fillers.map(f => (
        <div key={f.name} style={{ marginBottom: 8 }}>
          <div className="filler-row">
            <span className={`dot ${f.alive ? 'alive' : 'dead'}`} />
            <span className="filler-name">{f.name}</span>
            <span className="filler-url">{f.url}</span>
            <span className="filler-ping">
              {f.alive ? (
                <span style={{ color: '#16a34a' }}>✓ alive {f.latencyMs}ms</span>
              ) : (
                <span style={{ color: '#dc2626' }} title={f.error}>✗ unreachable</span>
              )}
            </span>
            <button className="ghost sm" style={{ marginTop: 0 }} onClick={() => startEdit(f)}>Edit</button>
            <button className="red sm" style={{ marginTop: 0 }} onClick={() => removeFiller(f.name)}>Remove</button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', paddingLeft: 24 }}>
            address: <span className="mono">{f.address || 'not set'}</span>
            {f.chains.length > 0 && (
              <span style={{ marginLeft: 12 }}>
                chains: {f.chains.map(id => chains.find(c => c.id === id)?.name ?? id).join(', ')}
              </span>
            )}
          </div>

          {editingName === f.name && (
            <div className="row" style={{ marginTop: 6, paddingLeft: 24, alignItems: 'flex-end' }}>
              <div>
                <label>Address</label>
                <input value={editAddress} onChange={e => setEditAddress(e.target.value)} placeholder="0x…" />
              </div>
              <div>
                <label>Chains</label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', height: 36 }}>
                  {chains.map(c => (
                    <label key={c.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: '0.8rem', fontWeight: 400 }}>
                      <input type="checkbox" checked={editChains.includes(c.id)}
                        onChange={() => setEditChains(toggleChain(editChains, c.id))} />
                      {c.name}
                    </label>
                  ))}
                </div>
              </div>
              <button className="sm" style={{ marginTop: 0 }} onClick={saveEdit}>Save</button>
              <button className="ghost sm" style={{ marginTop: 0 }} onClick={() => setEditingName(null)}>Cancel</button>
            </div>
          )}
          {editingName === f.name && editStatus && (
            <div className={`status ${editStatus.cls}`} style={{ paddingLeft: 24 }}>{editStatus.msg}</div>
          )}
        </div>
      ))}

      <hr />
      <h2>Add Filler</h2>
      <div className="row">
        <div>
          <label>Name</label>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. WhaleFiller" />
        </div>
        <div>
          <label>Quote URL (base, without /quote)</label>
          <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="http://localhost:4001" />
        </div>
        <div>
          <label>Address (optional)</label>
          <input value={newAddress} onChange={e => setNewAddress(e.target.value)} placeholder="0x…" />
        </div>
        <div>
          <label>Chains</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', height: 36 }}>
            {chains.map(c => (
              <label key={c.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: '0.8rem', fontWeight: 400 }}>
                <input type="checkbox" checked={newChains.includes(c.id)}
                  onChange={() => setNewChains(toggleChain(newChains, c.id))} />
                {c.name}
              </label>
            ))}
          </div>
        </div>
      </div>
      <button onClick={addFiller}>Add Filler</button>
      {addStatus && <div className={`status ${addStatus.cls}`}>{addStatus.msg}</div>}
    </div>
  )
}

// ── Chain Control tab ──────────────────────────────────────────────────────
function ChainTab({ token, onUnauthorized }: AdminProps) {
  const { backendUrl } = useAppConfig()
  const [blocks,    setBlocks]    = useState('1')
  const [interval,  setInterval_] = useState('0')
  const [mineStatus, setMineStatus] = useState<{ msg: string; cls: string } | null>(null)
  const [mining, setMining] = useState(false)
  const [blockNums, setBlockNums] = useState<{ chainA: number | null; chainB: number | null }>({ chainA: null, chainB: null })
  const [blocksLoading, setBlocksLoading] = useState(false)

  async function fetchBlocks() {
    setBlocksLoading(true)
    try {
      const res  = await fetch(`${backendUrl}/admin/blocks`)
      const data = await res.json()
      setBlockNums(data)
    } catch { /* ignore */ }
    finally { setBlocksLoading(false) }
  }

  useEffect(() => { fetchBlocks() }, [backendUrl])

  async function mine() {
    setMining(true)
    setMineStatus({ msg: `Mining ${blocks} block(s) on Chain A…`, cls: 'info' })
    try {
      const res  = await fetch(`${backendUrl}/admin/mine`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body:    JSON.stringify({ blocks: parseInt(blocks), interval: parseInt(interval) }),
      })
      if (res.status === 401) { onUnauthorized(); return }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setMineStatus({ msg: `✔ Mined ${data.blocks} block(s).`, cls: 'ok' })
      fetchBlocks()
    } catch (e: any) { setMineStatus({ msg: e.message, cls: 'bad' }) }
    finally { setMining(false) }
  }

  return (
    <div>
      <p className="sub">
        Mine blocks to advance the chains. Chain B requires <code>CHAIN_B_RPC</code> to be configured.
      </p>

      {/* Current blocks */}
      <h2>Current Block Numbers</h2>
      <div className="row" style={{ gap: 16, marginBottom: 0 }}>
        <div className="card" style={{ flex: 1, padding: '16px 20px', margin: 0 }}>
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: 4 }}>Chain A (source)</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#7c3aed' }}>
            {blocksLoading ? '…' : (blockNums.chainA ?? '—')}
          </div>
        </div>
        <div className="card" style={{ flex: 1, padding: '16px 20px', margin: 0 }}>
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: 4 }}>Chain B (destination)</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#0ea5e9' }}>
            {blocksLoading ? '…' : (blockNums.chainB ?? '—')}
          </div>
        </div>
      </div>
      <button className="ghost sm" style={{ marginTop: 10 }} onClick={fetchBlocks}>↻ Refresh</button>

      <hr />
      <h2>Mine Blocks (Chain A)</h2>
      <div className="row">
        <div>
          <label>Number of blocks</label>
          <input type="number" min="1" max="1000" value={blocks} onChange={e => setBlocks(e.target.value)} className="short" />
        </div>
        <div>
          <label>Block interval (seconds, 0 = instant)</label>
          <input type="number" min="0" value={interval} onChange={e => setInterval_(e.target.value)} className="short" />
        </div>
      </div>
      <button onClick={mine} disabled={mining}>
        {mining ? 'Mining…' : `⛏ Mine ${blocks} Block${parseInt(blocks) !== 1 ? 's' : ''}`}
      </button>
      {mineStatus && <div className={`status ${mineStatus.cls}`}>{mineStatus.msg}</div>}
    </div>
  )
}
