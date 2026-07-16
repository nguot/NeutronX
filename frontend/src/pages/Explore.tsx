import { useEffect, useMemo, useState, useCallback } from 'react'
import { ethers } from 'ethers'
import { useAppConfig } from '../context/AppConfig'
import type { WalletState } from '../hooks/useWallet'
import { safeApproveErc20 } from '../lib/erc20'

interface CCTokenInfo { symbol: string; address: string; decimals: number; chainId: number; name?: string }
interface Row extends CCTokenInfo { name: string; role: 'input' | 'output' }

interface SpenderSpec { key: string; label: string; address: string }

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
function ApprovalCell({ ok, busy, err, onApprove, label }: { ok: boolean; busy: boolean; err?: string; onApprove: () => void; label?: string }) {
  if (ok) return <span className="status ok">✓ enabled</span>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
      <span className="status bad">✗ not enabled</span>
      <button className="ghost sm" disabled={busy} onClick={onApprove}>
        {busy ? 'Approving…' : (label ?? 'Approve')}
      </button>
      {err && <span style={{ fontSize: '0.7rem', color: '#dc2626' }}>{err}</span>}
    </div>
  )
}

// ── Approvals (manual alternative to setup_cc.sh's fund_and_approve_swapper) ──
//
// One table per chain, one column per spender that can pull that chain's
// tokens through Permit2 (Reactor/FallbackExecutor on Chain A, EscrowSrcFactory
// on whichever chain is acting as the swap's source). Reads allowances straight
// from that chain's RPC (not wallet.provider) so it's accurate no matter which
// network MetaMask is currently on; writing still needs the wallet's signer to
// actually be on that chain, so cells offer "Switch network" until it is.
interface ApprovalTableRow { symbol: string; address: string; erc20Ok: boolean; spenderOk: Record<string, boolean> }

function useApprovals(rpcUrl: string, tokens: CCTokenInfo[], spenders: SpenderSpec[], account: string) {
  const [rows, setRows] = useState<ApprovalTableRow[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!account || spenders.length === 0 || tokens.length === 0 || !rpcUrl) { setRows([]); return }
    setLoading(true)
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
      const p2  = new ethers.Contract(PERMIT2, P2_ABI, provider)
      const now = Date.now() / 1000
      const result = await Promise.all(tokens.map(async t => {
        try {
          const erc = new ethers.Contract(t.address, ERC_ABI, provider)
          const erc20Ok = (await erc.allowance(account, PERMIT2)).gt(0)
          const spenderOk: Record<string, boolean> = {}
          await Promise.all(spenders.map(async s => {
            const [amount, expiration] = await p2.allowance(account, t.address, s.address)
            spenderOk[s.key] = amount.gt(0) && Number(expiration) > now
          }))
          return { symbol: t.symbol, address: t.address, erc20Ok, spenderOk }
        } catch {
          return { symbol: t.symbol, address: t.address, erc20Ok: false, spenderOk: {} }
        }
      }))
      setRows(result)
    } finally {
      setLoading(false)
    }
  }, [rpcUrl, tokens, spenders, account])

  useEffect(() => { refresh() }, [refresh])
  return { rows, loading, refresh }
}

function ApprovalsTable({ chainLabel, chainId, rpcUrl, tokens, spenders, wallet, switchNetwork }: {
  chainLabel: string
  chainId: number
  rpcUrl: string
  tokens: CCTokenInfo[]
  spenders: SpenderSpec[]
  wallet: WalletState
  switchNetwork: (chainId: number) => Promise<void>
}) {
  const { rows, loading, refresh } = useApprovals(rpcUrl, tokens, spenders, wallet.account)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [errs, setErrs]  = useState<Record<string, string>>({})
  const onRightChain = wallet.connected && wallet.chainId === chainId

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(b => ({ ...b, [key]: true })); setErrs(e => ({ ...e, [key]: '' }))
    try { await fn(); await refresh() }
    catch (e: any) { setErrs(er => ({ ...er, [key]: e.message ?? String(e) })) }
    finally { setBusy(b => ({ ...b, [key]: false })) }
  }

  function onSwitch(key: string) {
    return run(key, () => switchNetwork(chainId))
  }
  function approveErc20(row: ApprovalTableRow) {
    if (!wallet.signer || !wallet.account) return
    return run(`${row.address}:erc20`, () => safeApproveErc20(row.address, PERMIT2, ethers.constants.MaxUint256, wallet.signer!, wallet.account))
  }
  function approveSpender(row: ApprovalTableRow, spender: SpenderSpec) {
    if (!wallet.signer) return
    return run(`${row.address}:${spender.key}`, async () => {
      const p2 = new ethers.Contract(PERMIT2, P2_ABI, wallet.signer!)
      await (await p2.approve(row.address, spender.address, MAX_UINT160, MAX_UINT48)).wait()
    })
  }

  if (spenders.length === 0) return <div className="status warn">Nothing to approve on {chainLabel} yet.</div>

  return (
    <>
      {loading && <div className="status info">Checking allowances…</div>}
      {!loading && rows.length === 0 && <div className="status warn">No tokens on {chainLabel}.</div>}

      {!loading && rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Token</th>
              <th>ERC20 → Permit2</th>
              {spenders.map(s => <th key={s.key}>Permit2 → {s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const erc20Key = `${r.address}:erc20`
              return (
                <tr key={r.address}>
                  <td>{r.symbol}</td>
                  <td>
                    <ApprovalCell ok={r.erc20Ok} busy={!!busy[erc20Key]} err={errs[erc20Key]}
                      label={onRightChain ? undefined : `Switch to ${chainLabel}`}
                      onApprove={() => onRightChain ? approveErc20(r) : onSwitch(erc20Key)} />
                  </td>
                  {spenders.map(s => {
                    const key = `${r.address}:${s.key}`
                    return (
                      <td key={s.key}>
                        <ApprovalCell ok={!!r.spenderOk[s.key]} busy={!!busy[key]} err={errs[key]}
                          label={onRightChain ? undefined : `Switch to ${chainLabel}`}
                          onApprove={() => onRightChain ? approveSpender(r, s) : onSwitch(key)} />
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}

interface ExploreProps {
  wallet: WalletState
  switchNetwork: (chainId: number) => Promise<void>
}

export default function Explore({ wallet, switchNetwork }: ExploreProps) {
  const { backendUrl, chainId, chainARpc, chainBRpc, chains, partialFillReactor, fallbackExecutor, crossChainReactor, escrowSrcFactoryB } = useAppConfig()
  const [inputTokens,  setInputTokens]  = useState<CCTokenInfo[]>([])
  const [outputTokens, setOutputTokens] = useState<CCTokenInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [ccChain, setCcChain] = useState<'A' | 'B'>('A')

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

  const chainAId = inputTokens[0]?.chainId  ?? Number(chainId) ?? 31337
  const chainBId = outputTokens[0]?.chainId ?? 31338

  // Every spender that can pull a chain's tokens through Permit2. Chain A hosts
  // the single-chain swap's Reactor/FallbackExecutor as well as its EscrowSrcFactory
  // (A→B cross-chain source); Chain B only has the latter (B→A source).
  const chainASpenders: SpenderSpec[] = useMemo(() => ([
    { key: 'reactor',    label: 'Reactor',           address: partialFillReactor },
    { key: 'fallback',   label: 'FallbackExecutor',  address: fallbackExecutor },
    { key: 'srcFactory', label: 'EscrowSrcFactory',  address: crossChainReactor },
  ].filter(s => s.address)), [partialFillReactor, fallbackExecutor, crossChainReactor])

  const chainBSpenders: SpenderSpec[] = useMemo(() => ([
    { key: 'srcFactory', label: 'EscrowSrcFactory', address: escrowSrcFactoryB },
  ].filter(s => s.address)), [escrowSrcFactoryB])

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

      {/* Approvals — every Permit2 allowance the swap flows depend on, one chain at a time */}
      {wallet.connected && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Your Approvals</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="addr-cell">
                <span title={wallet.account}>{short(wallet.account)}</span>
                <button className="copy-btn" onClick={() => copy(wallet.account)} title="Copy address">⧉</button>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className={`ghost sm${ccChain === 'A' ? ' active' : ''}`} onClick={() => setCcChain('A')}>
                  Chain A ({chainAId})
                </button>
                <button className={`ghost sm${ccChain === 'B' ? ' active' : ''}`} onClick={() => setCcChain('B')}>
                  Chain B ({chainBId})
                </button>
              </div>
            </div>
          </div>

          {ccChain === 'A'
            ? <ApprovalsTable chainLabel="Chain A" chainId={chainAId} rpcUrl={chainARpc}
                tokens={inputTokens} spenders={chainASpenders} wallet={wallet} switchNetwork={switchNetwork} />
            : <ApprovalsTable chainLabel="Chain B" chainId={chainBId} rpcUrl={chainBRpc}
                tokens={outputTokens} spenders={chainBSpenders} wallet={wallet} switchNetwork={switchNetwork} />}
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
