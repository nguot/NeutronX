import { useEffect, useMemo, useState, useCallback } from 'react'
import { ethers } from 'ethers'
import { useAppConfig } from '../context/AppConfig'
import type { WalletState } from '../hooks/useWallet'

interface CCTokenInfo { symbol: string; address: string; decimals: number; chainId: number; name?: string }
interface Row extends CCTokenInfo { name: string; role: 'input' | 'output' }

interface ApprovalRow {
  symbol:     string
  address:    string
  erc20Ok:    boolean
  reactorOk:  boolean
  fallbackOk: boolean
}

const ICON_COLORS = ['#7c3aed', '#2563eb', '#16a34a', '#ea580c', '#db2777', '#0891b2']
function iconColor(symbol: string) {
  let hash = 0
  for (const c of symbol) hash = (hash * 31 + c.charCodeAt(0)) % ICON_COLORS.length
  return ICON_COLORS[Math.abs(hash)]
}
function short(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}` }
function copy(text: string) { navigator.clipboard?.writeText(text) }

// Permit2 AllowanceTransfer — shared across chains, used to gate the swap UI.
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const P2_ABI  = ['function allowance(address,address,address) view returns (uint160,uint48,uint48)', 'function approve(address,address,uint160,uint48)']
const ERC_ABI = ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']
const MAX_UINT160 = ethers.BigNumber.from('0xffffffffffffffffffffffffffffffff')
const MAX_UINT48  = ethers.BigNumber.from('0xffffffffffff')

// Shows the allowance state for one (token, spender) pair, with an inline
// "Approve" button when it isn't enabled yet — so the whole approval set can
// be granted here instead of one-at-a-time from the Swap page.
function ApprovalCell({ ok, busy, err, onApprove }: { ok: boolean; busy: boolean; err?: string; onApprove: () => void }) {
  if (ok) return <span className="status ok">✓ enabled</span>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
      <span className="status bad">✗ not enabled</span>
      <button className="ghost sm" disabled={busy} onClick={onApprove}>
        {busy ? 'Approving…' : 'Approve'}
      </button>
      {err && <span style={{ fontSize: '0.7rem', color: '#dc2626' }}>{err}</span>}
    </div>
  )
}

export default function Explore({ wallet }: { wallet: WalletState }) {
  const { backendUrl, chainId, chainARpc, chainBRpc, chains, partialFillReactor, fallbackExecutor } = useAppConfig()
  const [inputTokens,  setInputTokens]  = useState<CCTokenInfo[]>([])
  const [outputTokens, setOutputTokens] = useState<CCTokenInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [approvals, setApprovals] = useState<ApprovalRow[]>([])
  const [approvalsLoading, setApprovalsLoading] = useState(false)

  // /cc/tokens returns a map of chainId -> tokens on that chain. chains[0] is
  // the input (source) side, chains[1] the output (destination) side.
  useEffect(() => {
    const srcId = chains[0]?.id
    const dstId = chains[1]?.id
    if (srcId == null || dstId == null) return
    fetch(`${backendUrl}/cc/tokens`)
      .then(r => r.json())
      .then((data: Record<number, CCTokenInfo[]>) => {
        setInputTokens(data[srcId] ?? [])
        setOutputTokens(data[dstId] ?? [])
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [backendUrl, chains])

  // ── approvals ──────────────────────────────────────────────────────────────
  // For each Chain-A input token, check the three Permit2 allowances the swap
  // flow depends on: ERC20→Permit2, and Permit2→{PartialFillReactor,FallbackExecutor}.
  const refreshApprovals = useCallback(async () => {
    if (!wallet.connected || !wallet.provider || !wallet.account || inputTokens.length === 0 || !partialFillReactor) {
      setApprovals([])
      return
    }
    setApprovalsLoading(true)
    const provider = wallet.provider
    const account = wallet.account
    try {
      const p2  = new ethers.Contract(PERMIT2, P2_ABI, provider)
      const now = Date.now() / 1000
      const checkSpender = async (token: string, spender: string) => {
        if (!spender) return false
        const [amount, expiration] = await p2.allowance(account, token, spender)
        return amount.gt(0) && Number(expiration) > now
      }
      const rows = await Promise.all(inputTokens.map(async t => {
        try {
          const erc = new ethers.Contract(t.address, ERC_ABI, provider)
          const erc20Ok = (await erc.allowance(account, PERMIT2)).gt(0)
          const [reactorOk, fallbackOk] = await Promise.all([
            checkSpender(t.address, partialFillReactor),
            checkSpender(t.address, fallbackExecutor),
          ])
          return { symbol: t.symbol, address: t.address, erc20Ok, reactorOk, fallbackOk }
        } catch {
          return { symbol: t.symbol, address: t.address, erc20Ok: false, reactorOk: false, fallbackOk: false }
        }
      }))
      setApprovals(rows)
    } finally {
      setApprovalsLoading(false)
    }
  }, [wallet.connected, wallet.provider, wallet.account, inputTokens, partialFillReactor, fallbackExecutor])

  useEffect(() => { refreshApprovals() }, [refreshApprovals])

  // ── approve actions ───────────────────────────────────────────────────────
  // Lets the swapper grant every allowance the swap flow needs right here,
  // instead of being walked through "Approve" / "Enable spending" one token
  // at a time on the Swap page.
  const [approving,  setApproving]  = useState<Record<string, boolean>>({})
  const [approveErr, setApproveErr] = useState<Record<string, string>>({})

  async function withApproval(key: string, fn: () => Promise<void>) {
    setApproving(a => ({ ...a, [key]: true }))
    setApproveErr(e => ({ ...e, [key]: '' }))
    try {
      await fn()
      await refreshApprovals()
    } catch (e: any) {
      setApproveErr(err => ({ ...err, [key]: e.message ?? String(e) }))
    } finally {
      setApproving(a => ({ ...a, [key]: false }))
    }
  }

  function approveErc20(token: ApprovalRow) {
    const signer = wallet.signer
    if (!signer) return
    return withApproval(`${token.address}:erc20`, async () => {
      const erc = new ethers.Contract(token.address, ERC_ABI, signer)
      await (await erc.approve(PERMIT2, ethers.constants.MaxUint256)).wait()
    })
  }

  function approvePermit2(token: ApprovalRow, spender: string, key: string) {
    const signer = wallet.signer
    if (!signer || !spender) return
    return withApproval(key, async () => {
      const p2 = new ethers.Contract(PERMIT2, P2_ABI, signer)
      await (await p2.approve(token.address, spender, MAX_UINT160, MAX_UINT48)).wait()
    })
  }

  const chainAId = inputTokens[0]?.chainId  ?? Number(chainId) ?? 31337
  const chainBId = outputTokens[0]?.chainId ?? 31338

  const chainChips = [
    { id: chainAId, name: 'Anvil — Chain A', role: 'Source chain', rpcUrl: chainARpc },
    { id: chainBId, name: 'Anvil — Chain B', role: 'Destination chain', rpcUrl: chainBRpc },
  ]

  const rows: Row[] = useMemo(() => [
    ...inputTokens.map(t => ({ ...t, role: 'input' as const, name: t.name ?? t.symbol })),
    ...outputTokens.map(t => ({ ...t, role: 'output' as const, name: t.name ?? t.symbol })),
  ], [inputTokens, outputTokens])

  const filtered = rows.filter(r => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return r.symbol.toLowerCase().includes(q) || r.address.toLowerCase().includes(q)
  })

  return (
    <>
      <div className="page-header">
        <div className="page-title">Explore</div>
      </div>

      {/* Chains */}
      <div className="chain-chips">
        {chainChips.map(c => (
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

      {/* Your Approvals */}
      {wallet.connected && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Your Approvals</h2>
            <div className="addr-cell">
              <span title={wallet.account}>{short(wallet.account)}</span>
              <button className="copy-btn" onClick={() => copy(wallet.account)} title="Copy address">⧉</button>
            </div>
          </div>

          {approvalsLoading && <div className="status info">Checking allowances…</div>}

          {!approvalsLoading && approvals.length === 0 && (
            <div className="status warn">No Chain-A input tokens to check.</div>
          )}

          {!approvalsLoading && approvals.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>ERC20 → Permit2</th>
                  <th>Permit2 → Reactor</th>
                  <th>Permit2 → FallbackExecutor</th>
                </tr>
              </thead>
              <tbody>
                {approvals.map(a => {
                  const erc20Key    = `${a.address}:erc20`
                  const reactorKey  = `${a.address}:reactor`
                  const fallbackKey = `${a.address}:fallback`
                  return (
                    <tr key={a.address}>
                      <td>{a.symbol}</td>
                      <td>
                        <ApprovalCell ok={a.erc20Ok} busy={!!approving[erc20Key]} err={approveErr[erc20Key]}
                          onApprove={() => approveErc20(a)} />
                      </td>
                      <td>
                        <ApprovalCell ok={a.reactorOk} busy={!!approving[reactorKey]} err={approveErr[reactorKey]}
                          onApprove={() => approvePermit2(a, partialFillReactor, reactorKey)} />
                      </td>
                      <td>
                        {fallbackExecutor
                          ? <ApprovalCell ok={a.fallbackOk} busy={!!approving[fallbackKey]} err={approveErr[fallbackKey]}
                              onApprove={() => approvePermit2(a, fallbackExecutor, fallbackKey)} />
                          : <span className="text-muted">not configured</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Search */}
      <div className="explore-search">
        <span className="explore-search-icon">🔍</span>
        <input placeholder="Search by symbol or address" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {!loaded && <div className="status info">Loading…</div>}
      {loaded && rows.length === 0 && (
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
