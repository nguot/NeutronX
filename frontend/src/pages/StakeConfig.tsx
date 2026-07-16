import { useState, useEffect, useCallback, useMemo } from 'react'
import { ethers } from 'ethers'
import type { WalletState } from '../hooks/useWallet'
import { useAppConfig } from '../context/AppConfig'
import {
  FILL_AUCTION_ABI, type StakeConfigStruct, hasPending, sizeBucketCount, timeBucketCount,
  ratioBucketCount, refundAt, bpsToPct, weiToEth, extractRevertReason,
} from '../contract/fillAuctionAbi'

type SubTab = 'overview' | 'guardian' | 'paramadmin' | 'admin' | 'history'

const EMPTY_CFG: StakeConfigStruct = {
  sizeThresholds: [], collateralRate: [], timeThresholds: [], timeMult: [],
  ratioThresholds: [], refundTable: [], minCollateral: ethers.BigNumber.from(0),
}

interface Constants {
  maxDeltaBps: number; changeCooldown: number; loosenDelay: number; minPenaltyBps: number
  minRate: number; maxRate: number; maxRefundBps: number; maxBuckets: number
  minWorstCaseKappaBps: number
}

// ── bucket range labels ──────────────────────────────────────────────────────
// Mirrors DynamicStakeLib.getOrderSizeBucketETH/getFillRatioBucket/getTimeBucket:
// size/ratio buckets are picked by the first threshold the value is STRICTLY
// BELOW (ascending thresholds); time buckets by the first threshold the
// blocks-left is STRICTLY ABOVE (thresholds are DECREASING).
function ascendingRangeLabel(thresholds: string[], i: number, unit: string): string {
  if (thresholds.length === 0) return 'any'
  if (i === 0) return `< ${thresholds[0]} ${unit}`
  if (i === thresholds.length) return `>= ${thresholds[i - 1]} ${unit}`
  return `${thresholds[i - 1]} – ${thresholds[i]} ${unit}`
}
function timeRangeLabel(thresholds: string[], i: number): string {
  if (thresholds.length === 0) return 'any'
  if (i === 0) return `> ${thresholds[0]} blocks left`
  if (i === thresholds.length) return `<= ${thresholds[i - 1]} blocks left`
  return `${thresholds[i]} – ${thresholds[i - 1]} blocks left`
}

export default function StakeConfigPage({ wallet, switchNetwork }: {
  wallet: WalletState
  switchNetwork: (chainId: number) => Promise<void>
}) {
  const { fillAuction, chainARpc, chainId } = useAppConfig()
  const chainAId = Number(chainId) || 0
  const wrongNetwork = wallet.connected && chainAId !== 0 && wallet.chainId !== chainAId

  const [subTab, setSubTab] = useState<SubTab>('overview')
  const [config, setConfig] = useState<StakeConfigStruct>(EMPTY_CFG)
  const [pending, setPending] = useState<StakeConfigStruct | null>(null)
  const [pendingEffective, setPendingEffective] = useState(0)
  const [consts, setConsts] = useState<Constants | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState('')

  const [isGuardian, setIsGuardian] = useState(false)
  const [isParamAdmin, setIsParamAdmin] = useState(false)
  const [isDefaultAdmin, setIsDefaultAdmin] = useState(false)

  const iface = useMemo(() => new ethers.utils.Interface(FILL_AUCTION_ABI), [])

  // Config is Chain-A-only, so reads always go through a Chain A RPC regardless
  // of whichever network the connected wallet currently happens to be on
  // (matters once cross-chain is in play — CrossChain.tsx has the same split).
  const readProvider = useMemo(() => {
    if (wallet.connected && !wrongNetwork && wallet.provider) return wallet.provider
    return chainARpc ? new ethers.providers.JsonRpcProvider(chainARpc) : null
  }, [wallet.connected, wrongNetwork, wallet.provider, chainARpc])

  const load = useCallback(async () => {
    if (!fillAuction || !readProvider) return
    setLoading(true)
    setLoadErr('')
    try {
      const c = new ethers.Contract(fillAuction, FILL_AUCTION_ABI, readProvider)
      const [cfg, pend, pendEff] = await Promise.all([c.stakeConfig(), c.pendingConfig(), c.pendingEffective()])
      setConfig(cfg)
      setPending(hasPending(pend) ? pend : null)
      setPendingEffective(pendEff.toNumber())

      if (!consts) {
        const [maxDeltaBps, changeCooldown, loosenDelay, minPenaltyBps, minRate, maxRate, maxRefundBps, maxBuckets, minKappa] =
          await Promise.all([
            c.MAX_DELTA_BPS(), c.CHANGE_COOLDOWN(), c.LOOSEN_DELAY(), c.MIN_PENALTY_BPS(),
            c.MIN_COLLATERAL_RATE(), c.MAX_COLLATERAL_RATE(), c.MAX_REFUND_BPS(), c.MAX_BUCKETS(),
            // Defensive fallback so an older FillAuction (deployed before this
            // constant existed) doesn't brick the whole page — 1000 = 10% mirrors
            // the contract default.
            c.MIN_WORST_CASE_KAPPA_BPS().catch(() => ethers.BigNumber.from(1000)),
          ])
        setConsts({
          maxDeltaBps: maxDeltaBps.toNumber(), changeCooldown: changeCooldown.toNumber(),
          loosenDelay: loosenDelay.toNumber(), minPenaltyBps: minPenaltyBps.toNumber(),
          minRate, maxRate, maxRefundBps, maxBuckets: maxBuckets.toNumber(),
          minWorstCaseKappaBps: minKappa.toNumber(),
        })
      }

      if (wallet.connected && wallet.account && !wrongNetwork) {
        const [gRole, pRole, aRole] = await Promise.all([c.GUARDIAN_ROLE(), c.PARAM_ADMIN_ROLE(), c.DEFAULT_ADMIN_ROLE()])
        const [isG, isP, isA] = await Promise.all([
          c.hasRole(gRole, wallet.account), c.hasRole(pRole, wallet.account), c.hasRole(aRole, wallet.account),
        ])
        setIsGuardian(isG); setIsParamAdmin(isP); setIsDefaultAdmin(isA)
      } else {
        setIsGuardian(false); setIsParamAdmin(false); setIsDefaultAdmin(false)
      }
    } catch (e: any) {
      setLoadErr(e.message ?? String(e))
    }
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillAuction, readProvider, wallet.connected, wallet.account, wrongNetwork])

  useEffect(() => { load() }, [load])
  useEffect(() => { const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(id) }, [])

  if (!fillAuction) {
    return (
      <>
        <div className="page-header"><div className="page-title">Stake Config</div></div>
        <div className="card"><div className="empty-state"><div className="empty-icon">⛓️</div>FillAuction address not configured (check backend/.env FILL_AUCTION).</div></div>
      </>
    )
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">Stake Config</div>
        <div className="page-sub">
          Sets how much collateral fillers must stake and how refunds are calculated. Anyone can
          view the live settings — changing them requires a wallet with Guardian or Param Admin access.
        </div>
      </div>

      <div className="tabs">
        <button className={`tab-btn ${subTab === 'overview' ? 'active' : ''}`} onClick={() => setSubTab('overview')}>Overview</button>
        <button className={`tab-btn ${subTab === 'guardian' ? 'active' : ''}`} onClick={() => setSubTab('guardian')}>Guardian</button>
        <button className={`tab-btn ${subTab === 'paramadmin' ? 'active' : ''}`} onClick={() => setSubTab('paramadmin')}>Param Admin</button>
        <button className={`tab-btn ${subTab === 'admin' ? 'active' : ''}`} onClick={() => setSubTab('admin')}>Admin</button>
        <button className={`tab-btn ${subTab === 'history' ? 'active' : ''}`} onClick={() => setSubTab('history')}>History</button>
      </div>

      {loadErr && <div className="status bad">{loadErr}</div>}

      {subTab === 'overview' && (
        <Overview
          config={config} pending={pending} pendingEffective={pendingEffective} now={now}
          consts={consts} loading={loading} onRefresh={load}
          fillAuction={fillAuction} wallet={wallet} wrongNetwork={wrongNetwork} chainAId={chainAId}
          switchNetwork={switchNetwork} iface={iface}
        />
      )}
      {subTab === 'guardian' && (
        <Guardian
          pending={pending} pendingEffective={pendingEffective} now={now}
          fillAuction={fillAuction} wallet={wallet} wrongNetwork={wrongNetwork} chainAId={chainAId}
          switchNetwork={switchNetwork} isGuardian={isGuardian} iface={iface} onDone={load}
        />
      )}
      {subTab === 'paramadmin' && (
        <ParamAdmin
          config={config} consts={consts}
          fillAuction={fillAuction} wallet={wallet} wrongNetwork={wrongNetwork} chainAId={chainAId}
          switchNetwork={switchNetwork} isParamAdmin={isParamAdmin} iface={iface} onDone={load}
        />
      )}
      {subTab === 'admin' && (
        <Admin
          fillAuction={fillAuction} wallet={wallet} wrongNetwork={wrongNetwork} chainAId={chainAId}
          switchNetwork={switchNetwork} isDefaultAdmin={isDefaultAdmin} iface={iface}
        />
      )}
      {subTab === 'history' && <History />}
    </>
  )
}

// ── shared bits ───────────────────────────────────────────────────────────────

function countdown(target: number, now: number): string {
  const secs = target - now
  if (secs <= 0) return 'ready'
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${secs % 60}s`
}

function NetworkGuard({ wrongNetwork, chainAId, switchNetwork }: {
  wrongNetwork: boolean; chainAId: number; switchNetwork: (id: number) => Promise<void>
}) {
  if (!wrongNetwork) return null
  return (
    <div className="status warn" style={{ marginBottom: 12 }}>
      Wallet is on the wrong network for FillAuction.
      <button className="sm" style={{ marginLeft: 8 }} onClick={() => switchNetwork(chainAId)}>Switch network</button>
    </div>
  )
}

// ── Overview (public, no wallet required) ────────────────────────────────────

function Overview({ config, pending, pendingEffective, now, consts, loading, onRefresh, fillAuction, wallet, wrongNetwork, chainAId, switchNetwork, iface }: {
  config: StakeConfigStruct; pending: StakeConfigStruct | null; pendingEffective: number; now: number
  consts: Constants | null; loading: boolean; onRefresh: () => void
  fillAuction: string; wallet: WalletState; wrongNetwork: boolean; chainAId: number
  switchNetwork: (id: number) => Promise<void>; iface: ethers.utils.Interface
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const canCommit = pending !== null && now >= pendingEffective

  async function commitPending() {
    if (!wallet.signer) { setErr('Connect a wallet first (anyone can commit — no role required).'); return }
    setErr(''); setMsg(''); setBusy(true)
    try {
      const c = new ethers.Contract(fillAuction, FILL_AUCTION_ABI, wallet.signer)
      const tx = await c.commitPending()
      setMsg('Committing…'); await tx.wait()
      setMsg('Pending config committed — now live.'); onRefresh()
    } catch (e: any) { setErr(extractRevertReason(e, iface)) }
    setBusy(false)
  }

  return (
    <>
      <div className="card">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <div className="card-title"><span className="icon">📋</span>Live config</div>
          <button className="ghost sm" onClick={onRefresh} disabled={loading} style={{ marginTop: 0 }}>{loading ? '…' : '↻ Refresh'}</button>
        </div>
        <ConfigTables cfg={config} />
        <div style={{ marginTop: 12, fontSize: '0.82rem', color: '#475569' }}>
          Absolute collateral floor: <strong>{weiToEth(config.minCollateral)} ETH</strong>
        </div>
      </div>

      {pending && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}><span className="icon">⏳</span>Pending config (queued loosening)</div>
          <div className={`status ${canCommit ? 'ok' : 'info'}`} style={{ marginBottom: 12 }}>
            {canCommit ? 'Delay elapsed — ready to commit.' : `Takes effect in ${countdown(pendingEffective, now)}`}
          </div>
          <ConfigTables cfg={pending} />
          <div className="btn-row">
            <button onClick={commitPending} disabled={!canCommit || busy}>
              {busy ? 'Committing…' : 'Commit pending config'}
            </button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: 6 }}>
            Permissionless — any connected wallet can trigger this once the delay elapses.
          </div>
          {err && <div className="status bad" style={{ marginTop: 8 }}>{err}</div>}
          {msg && <div className="status ok" style={{ marginTop: 8 }}>{msg}</div>}
        </div>
      )}

      {consts && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}><span className="icon">⚙️</span>Guard parameters</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px 16px', fontSize: '0.82rem' }}>
            <div title="Caps how far any single number in the config can move in one setStakeConfig() call.">
              <span style={{ color: '#64748b' }}>Max change per call:</span> {bpsToPct(consts.maxDeltaBps)} ⓘ
            </div>
            <div title="PARAM_ADMIN must wait this long since the last change before submitting another.">
              <span style={{ color: '#64748b' }}>Cooldown between changes:</span> {Math.round(consts.changeCooldown / 3600)}h ⓘ
            </div>
            <div title="A change that makes stakes cheaper (a 'loosening') is queued for this long before it can be committed — gives Guardians time to veto a compromised or malicious update. Tightening changes apply instantly since they can only make the system safer.">
              <span style={{ color: '#64748b' }}>Loosening delay:</span> {Math.round(consts.loosenDelay / 3600)}h ⓘ
            </div>
            <div title="The refund table can never promise back more than (100% − this floor) — some penalty always applies below full delivery.">
              <span style={{ color: '#64748b' }}>Min penalty floor:</span> {bpsToPct(consts.minPenaltyBps)} ⓘ
            </div>
            <div title="Sanity clamp — no size bucket's collateral rate can be set outside this range, however the change is proposed.">
              <span style={{ color: '#64748b' }}>Collateral rate bounds:</span> {bpsToPct(consts.minRate)} – {bpsToPct(consts.maxRate)} ⓘ
            </div>
            <div title="Hard cap on how many size/time/fill-ratio buckets a single config can define, to keep gas costs bounded.">
              <span style={{ color: '#64748b' }}>Max buckets per dimension:</span> {consts.maxBuckets} ⓘ
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Red (harsh penalty) → green (no penalty), interpolated by refund %.
function refundColor(bps: number): { background: string; color: string } {
  const pct = Math.max(0, Math.min(100, bps / 100))
  const hue = (pct / 100) * 120 // 0 = red, 120 = green
  return { background: `hsl(${hue}, 70%, 90%)`, color: `hsl(${hue}, 70%, 28%)` }
}

function ConfigTables({ cfg }: { cfg: StakeConfigStruct }) {
  const S = sizeBucketCount(cfg), T = timeBucketCount(cfg), R = ratioBucketCount(cfg)
  const sizeLabels  = cfg.sizeThresholds.map(t => weiToEth(t))
  const timeLabels  = cfg.timeThresholds.map(t => t.toString())
  const ratioLabels = cfg.ratioThresholds.map(t => bpsToPct(t.toNumber ? t.toNumber() : Number(t)))
  const sizeRangeLabels = Array.from({ length: S }, (_, i) => ascendingRangeLabel(sizeLabels, i, 'ETH'))

  // Headline: the worst-case combined stake multiplier — largest order size ×
  // most-urgent (fewest blocks left) registration — so the tables below open
  // with a concrete "what does this actually cost" instead of raw bps.
  const worstSizeRate  = cfg.collateralRate[S - 1]
  const worstTimeMult  = cfg.timeMult[T - 1]
  const worstCombined  = S > 0 && T > 0 ? (worstSizeRate / 10000) * (worstTimeMult / 10000) : 0

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {S > 0 && T > 0 && (
        <div className="status info" style={{ fontSize: '0.82rem' }}>
          ℹ Worst case: an order in the <strong>{sizeRangeLabels[S - 1]}</strong> bucket, registered with{' '}
          <strong>{timeRangeLabel(timeLabels, T - 1)}</strong>, needs up to <strong>{worstCombined.toFixed(1)}x</strong>{' '}
          its notional value as stake ({bpsToPct(worstSizeRate)} size × {bpsToPct(worstTimeMult)} time).
        </div>
      )}

      <div>
        <div className="table-caption">Size buckets × collateral rate</div>
        <table className="table">
          <thead><tr><th>Order size (ETH notional)</th><th>Collateral rate</th></tr></thead>
          <tbody>
            {Array.from({ length: S }, (_, i) => (
              <tr key={i}><td>{sizeRangeLabels[i]}</td><td>{bpsToPct(cfg.collateralRate[i])}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="table-caption">Time buckets × multiplier</div>
        <table className="table">
          <thead><tr><th>Blocks left at registration</th><th>Multiplier</th></tr></thead>
          <tbody>
            {Array.from({ length: T }, (_, i) => (
              <tr key={i}><td>{timeRangeLabel(timeLabels, i)}</td><td>{bpsToPct(cfg.timeMult[i])}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="table-caption">Refund table — rows match the size buckets above; darker red = harsher penalty for stopping early</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Order size (ETH)</th>
                {Array.from({ length: R }, (_, r) => <th key={r}>{ascendingRangeLabel(ratioLabels, r, '')} filled</th>)}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: S }, (_, s) => (
                <tr key={s}>
                  <td>{sizeRangeLabels[s]}</td>
                  {Array.from({ length: R }, (_, r) => {
                    const bps = refundAt(cfg, s, r)
                    return <td key={r} style={{ fontWeight: 600, ...refundColor(bps) }}>{bpsToPct(bps)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Guardian panel ────────────────────────────────────────────────────────────

function Guardian({ pending, pendingEffective, now, fillAuction, wallet, wrongNetwork, chainAId, switchNetwork, isGuardian, iface, onDone }: {
  pending: StakeConfigStruct | null; pendingEffective: number; now: number
  fillAuction: string; wallet: WalletState; wrongNetwork: boolean; chainAId: number
  switchNetwork: (id: number) => Promise<void>; isGuardian: boolean; iface: ethers.utils.Interface; onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  async function call(method: 'rollback' | 'cancelPendingConfig', confirmMsg: string) {
    if (!window.confirm(confirmMsg)) return
    setErr(''); setMsg(''); setBusy(true)
    try {
      const c = new ethers.Contract(fillAuction, FILL_AUCTION_ABI, wallet.signer!)
      const tx = await c[method]()
      setMsg('Submitting…'); await tx.wait()
      setMsg(method === 'rollback' ? 'Rolled back to the previous config.' : 'Pending config cancelled.')
      onDone()
    } catch (e: any) { setErr(extractRevertReason(e, iface)) }
    setBusy(false)
  }

  if (!wallet.connected) {
    return <div className="card"><div className="empty-state"><div className="empty-icon">🔒</div>Connect a wallet (top-right) to use Guardian actions.</div></div>
  }

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 12 }}><span className="icon">🛡️</span>Guardian actions</div>
      <NetworkGuard wrongNetwork={wrongNetwork} chainAId={chainAId} switchNetwork={switchNetwork} />

      {!wrongNetwork && !isGuardian && (
        <div className="status warn">Connected wallet (<span className="mono">{wallet.account}</span>) does not have Guardian access.</div>
      )}

      {!wrongNetwork && isGuardian && (
        <>
          <p style={{ fontSize: '0.82rem', color: '#475569' }}>
            <strong>Rollback</strong> restores the config that was replaced by the last change (one step
            only — calling it twice in a row is a no-op). <strong>Cancel pending</strong> vetoes a
            not-yet-effective loosening.
          </p>
          <div className="btn-row">
            <button className="red" disabled={busy} onClick={() => call('rollback', 'Roll back to the previous StakeConfig? This restores exactly one step back.')}>
              Rollback
            </button>
            <button className="outline" disabled={busy || !pending} onClick={() => call('cancelPendingConfig', 'Cancel the currently pending (queued) config?')}>
              Cancel pending{pending ? ` (ready in ${countdown(pendingEffective, now)})` : ' (none queued)'}
            </button>
          </div>
        </>
      )}

      {err && <div className="status bad" style={{ marginTop: 12 }}>{err}</div>}
      {msg && <div className="status ok" style={{ marginTop: 12 }}>{msg}</div>}
    </div>
  )
}

// ── Admin panel (DEFAULT_ADMIN_ROLE — grant/revoke the other 3 roles) ────────

const ADMIN_ROLE_NAMES = ['PARAM_ADMIN_ROLE', 'GUARDIAN_ROLE', 'KEEPER_ROLE'] as const
type AdminRoleName = typeof ADMIN_ROLE_NAMES[number]
const ROLE_LABELS: Record<AdminRoleName, string> = {
  PARAM_ADMIN_ROLE: 'Param Admin', GUARDIAN_ROLE: 'Guardian', KEEPER_ROLE: 'Keeper',
}

function Admin({ fillAuction, wallet, wrongNetwork, chainAId, switchNetwork, isDefaultAdmin, iface }: {
  fillAuction: string; wallet: WalletState; wrongNetwork: boolean; chainAId: number
  switchNetwork: (id: number) => Promise<void>; isDefaultAdmin: boolean; iface: ethers.utils.Interface
}) {
  const [roleName, setRoleName] = useState<AdminRoleName>('PARAM_ADMIN_ROLE')
  const [address, setAddress] = useState('')
  const [checkResult, setCheckResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const validAddress = /^0x[0-9a-fA-F]{40}$/.test(address)

  // AccessControl has no on-chain enumeration of who holds a role — the only
  // way to know is to ask about one specific address at a time.
  async function checkRole() {
    if (!validAddress) { setErr('Enter a valid address to check'); return }
    setErr(''); setMsg(''); setCheckResult(null); setBusy(true)
    try {
      const provider = wallet.provider ?? new ethers.providers.JsonRpcProvider()
      const c = new ethers.Contract(fillAuction, FILL_AUCTION_ABI, provider)
      const role = await c[roleName]()
      const has = await c.hasRole(role, address)
      setCheckResult(has ? `Has ${ROLE_LABELS[roleName]} access` : `Does not have ${ROLE_LABELS[roleName]} access`)
    } catch (e: any) { setErr(e.message ?? String(e)) }
    setBusy(false)
  }

  async function call(method: 'grantRole' | 'revokeRole', confirmMsg: string) {
    if (!validAddress) { setErr('Enter a valid address first'); return }
    if (!window.confirm(confirmMsg)) return
    setErr(''); setMsg(''); setBusy(true)
    try {
      const c = new ethers.Contract(fillAuction, FILL_AUCTION_ABI, wallet.signer!)
      const role = await c[roleName]()
      const tx = await c[method](role, address)
      setMsg('Submitting…'); await tx.wait()
      setMsg(`${method === 'grantRole' ? 'Granted' : 'Revoked'} ${ROLE_LABELS[roleName]} ${method === 'grantRole' ? 'to' : 'from'} ${address}.`)
      setCheckResult(null)
    } catch (e: any) { setErr(extractRevertReason(e, iface)) }
    setBusy(false)
  }

  if (!wallet.connected) {
    return <div className="card"><div className="empty-state"><div className="empty-icon">🔒</div>Connect a wallet (top-right) to use Admin actions.</div></div>
  }

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 12 }}><span className="icon">👑</span>Admin actions</div>
      <NetworkGuard wrongNetwork={wrongNetwork} chainAId={chainAId} switchNetwork={switchNetwork} />

      {!wrongNetwork && !isDefaultAdmin && (
        <div className="status warn">Connected wallet (<span className="mono">{wallet.account}</span>) does not have Admin access.</div>
      )}

      {!wrongNetwork && isDefaultAdmin && (
        <>
          <p style={{ fontSize: '0.82rem', color: '#475569' }}>
            Grants or revokes Param Admin, Guardian, and Keeper access for any wallet. This role only
            manages permissions — it can't change stake settings itself.
          </p>

          <div className="row" style={{ marginTop: 8 }}>
            <div>
              <label style={{ fontSize: '0.78rem', color: '#64748b' }}>Role</label>
              <select value={roleName} onChange={e => { setRoleName(e.target.value as AdminRoleName); setCheckResult(null) }}>
                {ADMIN_ROLE_NAMES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '0.78rem', color: '#64748b' }}>Address</label>
              <input value={address} onChange={e => { setAddress(e.target.value); setCheckResult(null) }} placeholder="0x…" />
            </div>
          </div>

          <div className="btn-row">
            <button className="ghost" disabled={busy || !validAddress} onClick={checkRole}>Check</button>
            <button disabled={busy || !validAddress} onClick={() => call('grantRole', `Grant ${ROLE_LABELS[roleName]} to ${address}?`)}>Grant</button>
            <button className="red" disabled={busy || !validAddress} onClick={() => call('revokeRole', `Revoke ${ROLE_LABELS[roleName]} from ${address}?`)}>Revoke</button>
          </div>

          {checkResult && <div className="status info" style={{ marginTop: 8 }}>{checkResult}</div>}
        </>
      )}

      {err && <div className="status bad" style={{ marginTop: 12 }}>{err}</div>}
      {msg && <div className="status ok" style={{ marginTop: 12 }}>{msg}</div>}
    </div>
  )
}

// ── Param Admin panel ─────────────────────────────────────────────────────────

interface FormState {
  sizeThresholds: string[]; collateralRate: string[]
  timeThresholds: string[]; timeMult: string[]
  ratioThresholds: string[]; refundTable: string[][]
  minCollateral: string
}

// Mirrors DynamicStakeLib.worstCaseKappaBps() — the config's true worst-case
// economic floor: the smallest price edge (bps of delivered notional) at which
// ANY partial-fill-then-abandon strategy first turns a profit, across every
// (size, time) bucket. Returned alongside the argmin (size row + fill-ratio
// bucket) so the UI can point at the exact cell to fix. Returns null when the
// form is still incomplete/non-numeric (leave it to the other validators).
// Uses BigInt floor division to match the contract's FullMath.mulDiv exactly.
function worstCaseKappaForm(form: FormState): { kappaBps: number; s: number; idx: number } | null {
  const S = form.collateralRate.length
  const T = form.timeMult.length
  const R = form.ratioThresholds.length + 1
  if (R < 2) return { kappaBps: 0, s: 0, idx: 0 } // one ratio bucket -> always 100% refund -> no deterrent

  let best: { kappaBps: number; s: number; idx: number } | null = null
  for (let s = 0; s < S; s++) {
    // last "genuinely non-honest" bucket in this row: walk R-2..0 for refund < 100%
    let idx = -1
    for (let k = R - 1; k > 0; k--) {
      const cell = Number(form.refundTable[s]?.[k - 1])
      if (!Number.isFinite(cell)) return null // incomplete row — other validators handle it
      if (cell < 10000) { idx = k - 1; break }
    }
    if (idx === -1) return { kappaBps: 0, s, idx: 0 } // refunds 100% from bucket 0 — free snipe

    const x = BigInt(Math.trunc(Number(form.ratioThresholds[idx])))
    if (x === 0n) return { kappaBps: 0, s, idx }
    const penalty = 10000n - BigInt(Math.trunc(Number(form.refundTable[s][idx])))
    const rho = BigInt(Math.trunc(Number(form.collateralRate[s])))
    for (let t = 0; t < T; t++) {
      const mult = BigInt(Math.trunc(Number(form.timeMult[t])))
      const combined = (rho * mult) / 10000n
      const kappa = Number((combined * penalty) / x)
      if (best === null || kappa < best.kappaBps) best = { kappaBps: kappa, s, idx }
    }
  }
  return best
}

// Mirrors DynamicStakeLib.validate() exactly (contract/src/libs/DynamicStakeLib.sol:334)
// so a bad submission is caught here instead of burning gas on a guaranteed revert.
// This does NOT replicate guardCheck()'s economic delta/penalty-floor comparison
// against the LIVE config (that needs on-chain state at specific sampled notionals) —
// only the shape/ordering/bounds invariants that are checkable from the form alone,
// PLUS the worst-case-kappa floor (Invariant 8), which IS computable from the form.
function validateForm(form: FormState, consts: Constants | null): string[] {
  const errs: string[] = []
  const num = (v: string) => (v.trim() === '' ? NaN : Number(v))
  const notInt = (v: string) => { const n = num(v); return !isNaN(n) && !Number.isInteger(n) }

  const S = form.collateralRate.length
  const T = form.timeMult.length
  const R = form.ratioThresholds.length + 1

  // sizeThresholds/minCollateral are the ONLY fields allowed a fraction — they're
  // ETH amounts converted via parseEther (exact down to wei). Everything else
  // below is either a block count or a bps value, both indivisible on-chain:
  // ethers.BigNumber.from("2.5") throws outright, so catch it here with a clear
  // message instead of a raw ethers error at submit time.
  if (form.sizeThresholds.some(v => isNaN(num(v))) || form.collateralRate.some(v => isNaN(num(v)))) {
    errs.push('Size buckets: every threshold and rate must be a number.')
  }
  if (form.collateralRate.some(notInt)) errs.push('Collateral rate is in bps (whole numbers only, e.g. 2000 = 20%) — no decimals.')

  if (form.timeThresholds.some(v => isNaN(num(v))) || form.timeMult.some(v => isNaN(num(v)))) {
    errs.push('Time buckets: every threshold and multiplier must be a number.')
  }
  if (form.timeThresholds.some(notInt)) errs.push('Time thresholds are a block count — whole numbers only, no decimals.')
  if (form.timeMult.some(notInt)) errs.push('Time multiplier is in bps (whole numbers only, e.g. 15000 = 150%) — no decimals.')

  if (form.ratioThresholds.some(v => isNaN(num(v))) || form.refundTable.some(row => row.some(v => isNaN(num(v))))) {
    errs.push('Fill-ratio buckets / refund table: every value must be a number.')
  }
  if (form.ratioThresholds.some(notInt)) errs.push('Fill-ratio thresholds are in bps (whole numbers only, e.g. 2000 = 20%) — no decimals.')
  if (form.refundTable.some(row => row.some(notInt))) errs.push('Refund table values are in bps (whole numbers only, e.g. 5000 = 50%) — no decimals.')

  // Invariants 1-3 (shape) — bad shape means a bucket lookup could read out of
  // bounds or another row's cell entirely.
  if (form.sizeThresholds.length !== S - 1) errs.push(`Size buckets: ${S} bucket(s) need exactly ${S - 1} threshold(s) — currently ${form.sizeThresholds.length}.`)
  if (form.timeThresholds.length !== T - 1) errs.push(`Time buckets: ${T} bucket(s) need exactly ${T - 1} threshold(s) — currently ${form.timeThresholds.length}.`)
  if (form.refundTable.length !== S || form.refundTable.some(row => row.length !== R)) {
    errs.push(`Refund table must be exactly ${S} rows × ${R} columns.`)
  }

  // Invariant 7 (bounded bucket counts)
  const maxB = consts?.maxBuckets ?? 16
  if (S < 1 || S > maxB) errs.push(`Size bucket count (${S}) must be between 1 and ${maxB}.`)
  if (T < 1 || T > maxB) errs.push(`Time bucket count (${T}) must be between 1 and ${maxB}.`)
  if (R < 1 || R > maxB) errs.push(`Fill-ratio bucket count (${R}) must be between 1 and ${maxB}.`)

  // Invariant 4 (strict ordering) — size/ratio ascending, time descending.
  for (let i = 1; i < form.sizeThresholds.length; i++) {
    if (!(num(form.sizeThresholds[i]) > num(form.sizeThresholds[i - 1]))) {
      errs.push(`Size thresholds must strictly increase — bucket ${i} (${form.sizeThresholds[i]}) is not greater than bucket ${i - 1} (${form.sizeThresholds[i - 1]}).`)
      break
    }
  }
  for (let i = 1; i < form.ratioThresholds.length; i++) {
    if (!(num(form.ratioThresholds[i]) > num(form.ratioThresholds[i - 1]))) {
      errs.push(`Fill-ratio thresholds must strictly increase — bucket ${i} (${form.ratioThresholds[i]}) is not greater than bucket ${i - 1} (${form.ratioThresholds[i - 1]}).`)
      break
    }
  }
  for (let i = 1; i < form.timeThresholds.length; i++) {
    if (!(num(form.timeThresholds[i]) < num(form.timeThresholds[i - 1]))) {
      errs.push(`Time thresholds must strictly decrease — bucket ${i} (${form.timeThresholds[i]}) is not less than bucket ${i - 1} (${form.timeThresholds[i - 1]}).`)
      break
    }
  }

  // Invariant 5 (absolute rate bounds)
  if (consts) {
    form.collateralRate.forEach((v, i) => {
      const n = num(v)
      if (!isNaN(n) && !(n >= consts.minRate && n <= consts.maxRate)) {
        errs.push(`Collateral rate bucket ${i} (${v} bps) must be between ${consts.minRate} and ${consts.maxRate} bps.`)
      }
    })
  }

  // Invariant 6 (refund rows non-decreasing, ending exactly at 100%)
  const maxRefund = consts?.maxRefundBps ?? 10000
  form.refundTable.forEach((row, s) => {
    let prev = 0
    for (let r = 0; r < row.length; r++) {
      const v = num(row[r])
      if (isNaN(v)) continue
      if (v > maxRefund) errs.push(`Refund table row ${s}, col ${r}: ${row[r]} bps exceeds 100% (${maxRefund} bps).`)
      if (v < prev) errs.push(`Refund table row ${s} is not monotonic — col ${r} (${row[r]} bps) is less than the previous column (${prev} bps).`)
      prev = v
    }
    if (prev !== maxRefund) errs.push(`Refund table row ${s} must end at 100% (${maxRefund} bps) — currently ${prev} bps.`)
  })

  // Invariant 8 (worst-case-kappa floor) — only meaningful once the shape/order/
  // bounds above are clean (otherwise indices/values are unreliable), matching
  // the contract, which runs this check at the END of validate().
  if (consts && errs.length === 0) {
    const wc = worstCaseKappaForm(form)
    const minK = consts.minWorstCaseKappaBps
    if (wc && wc.kappaBps < minK) {
      const sizeLabel = ascendingRangeLabel(form.sizeThresholds, wc.s, 'ETH')
      const ratioBps  = form.ratioThresholds[wc.idx]
      const edgePct   = ratioBps != null && ratioBps !== '' ? bpsToPct(Number(ratioBps)) : 'the last non-100% column'
      errs.push(
        `Economic floor: this config lets a filler snipe profitably at only ${bpsToPct(wc.kappaBps)} price edge — ` +
        `the minimum required is ${bpsToPct(minK)}. Worst point is the "${sizeLabel}" size row at the ${edgePct}-filled ` +
        `column: its refund is too generous (small penalty at a near-honest fill). Lower that refund, or raise the ` +
        `collateral rate for that row.`,
      )
    }
  }

  return errs
}

function toForm(cfg: StakeConfigStruct): FormState {
  const S = sizeBucketCount(cfg), R = ratioBucketCount(cfg)
  const rows: string[][] = Array.from({ length: S }, (_, s) =>
    Array.from({ length: R }, (_, r) => String(refundAt(cfg, s, r))))
  return {
    sizeThresholds: cfg.sizeThresholds.map(weiToEth),
    collateralRate: cfg.collateralRate.map(String),
    timeThresholds: cfg.timeThresholds.map(t => t.toString()),
    timeMult: cfg.timeMult.map(String),
    ratioThresholds: cfg.ratioThresholds.map(t => t.toString()),
    refundTable: rows,
    minCollateral: weiToEth(cfg.minCollateral),
  }
}

function ParamAdmin({ config, consts, fillAuction, wallet, wrongNetwork, chainAId, switchNetwork, isParamAdmin, iface, onDone }: {
  config: StakeConfigStruct; consts: Constants | null
  fillAuction: string; wallet: WalletState; wrongNetwork: boolean; chainAId: number
  switchNetwork: (id: number) => Promise<void>; isParamAdmin: boolean; iface: ethers.utils.Interface; onDone: () => void
}) {
  const { backendUrl } = useAppConfig()
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => { if (!form && config.collateralRate.length > 0) setForm(toForm(config)) }, [config, form])

  if (!wallet.connected) {
    return <div className="card"><div className="empty-state"><div className="empty-icon">🔒</div>Connect a wallet (top-right) to manage stake parameters.</div></div>
  }
  if (!form) {
    return <div className="card"><div className="empty-state"><div className="empty-icon">⏳</div>Loading current config…</div></div>
  }

  const R = form.ratioThresholds.length + 1

  function addSizeBucket() {
    setForm(f => {
      if (!f) return f
      // Leave the new threshold blank rather than guessing a step (2x, +N, ...) —
      // any guess is arbitrary, and live validation already flags it in red with
      // an exact reason (and the placeholder shows the constraint) until filled in.
      const nextRate = f.collateralRate[f.collateralRate.length - 1] ?? '10000'
      const lastRow = f.refundTable[f.refundTable.length - 1] ?? Array(R).fill('10000')
      return { ...f, sizeThresholds: [...f.sizeThresholds, ''], collateralRate: [...f.collateralRate, nextRate], refundTable: [...f.refundTable, [...lastRow]] }
    })
  }
  function removeSizeBucket() {
    setForm(f => {
      if (!f || f.collateralRate.length <= 1) return f
      return { ...f, sizeThresholds: f.sizeThresholds.slice(0, -1), collateralRate: f.collateralRate.slice(0, -1), refundTable: f.refundTable.slice(0, -1) }
    })
  }
  function addTimeBucket() {
    setForm(f => {
      if (!f) return f
      return { ...f, timeThresholds: [...f.timeThresholds, ''], timeMult: [...f.timeMult, f.timeMult[f.timeMult.length - 1] ?? '10000'] }
    })
  }
  function removeTimeBucket() {
    setForm(f => {
      if (!f || f.timeMult.length <= 1) return f
      return { ...f, timeThresholds: f.timeThresholds.slice(0, -1), timeMult: f.timeMult.slice(0, -1) }
    })
  }
  function addRatioBucket() {
    setForm(f => {
      if (!f) return f
      return { ...f, ratioThresholds: [...f.ratioThresholds, ''], refundTable: f.refundTable.map(row => [...row, row[row.length - 1] ?? '10000']) }
    })
  }
  function removeRatioBucket() {
    setForm(f => {
      if (!f || f.ratioThresholds.length === 0) return f
      return { ...f, ratioThresholds: f.ratioThresholds.slice(0, -1), refundTable: f.refundTable.map(row => row.slice(0, -1)) }
    })
  }
  function set1D(key: 'sizeThresholds' | 'collateralRate' | 'timeThresholds' | 'timeMult' | 'ratioThresholds', i: number, v: string) {
    setForm(f => { if (!f) return f; const arr = [...f[key]]; arr[i] = v; return { ...f, [key]: arr } })
  }
  function setCell(s: number, r: number, v: string) {
    setForm(f => { if (!f) return f; const rows = f.refundTable.map(row => [...row]); rows[s][r] = v; return { ...f, refundTable: rows } })
  }

  async function submit() {
    if (!form || !wallet.signer || !isParamAdmin || wrongNetwork) return
    setErr(''); setMsg(''); setBusy(true)
    try {
      const tuple = {
        sizeThresholds: form.sizeThresholds.map(v => ethers.utils.parseEther(v || '0')),
        collateralRate: form.collateralRate.map(v => Number(v || '0')),
        timeThresholds: form.timeThresholds.map(v => ethers.BigNumber.from(v || '0')),
        timeMult: form.timeMult.map(v => Number(v || '0')),
        ratioThresholds: form.ratioThresholds.map(v => ethers.BigNumber.from(v || '0')),
        refundTable: form.refundTable.flat().map(v => Number(v || '0')),
        minCollateral: ethers.utils.parseEther(form.minCollateral || '0'),
      }

      // Backend dry-run first: this callStatic's setStakeConfig against the LIVE
      // contract, so it catches the guardCheck reverts the client-side
      // validateForm can't (per-call delta cap, penalty-vs-live, cooldown,
      // already-pending) AND pinpoints a kappa-floor cell. If the backend is
      // unreachable we fall through to the contract, which is authoritative and
      // now returns a friendly reason via extractRevertReason.
      if (backendUrl) {
        try {
          const res = await fetch(`${backendUrl}/stake-config/validate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: wallet.account,
              config: {
                sizeThresholds: tuple.sizeThresholds.map(v => v.toString()),
                collateralRate: tuple.collateralRate,
                timeThresholds: tuple.timeThresholds.map(v => v.toString()),
                timeMult: tuple.timeMult,
                ratioThresholds: tuple.ratioThresholds.map(v => v.toString()),
                refundTable: tuple.refundTable,
                minCollateral: tuple.minCollateral.toString(),
              },
            }),
          })
          const data = await res.json()
          if (res.ok && data.ok === false) {
            let m: string = data.message || data.reason || 'Config rejected by dry-run.'
            if (data.culprit) {
              m += ` — worst point: "${data.culprit.sizeLabel}" size row at the ${data.culprit.fillPct}-filled column ` +
                   `(refund ${bpsToPct(data.culprit.refundBps)}, snipe breaks even at ${bpsToPct(data.culprit.worstCaseKappaBps)} edge).`
            }
            setErr(m); setBusy(false); return
          }
        } catch { /* backend down — let the on-chain call be the source of truth */ }
      }

      const c = new ethers.Contract(fillAuction, FILL_AUCTION_ABI, wallet.signer)
      const tx = await c.setStakeConfig(tuple)
      setMsg('Submitting…'); await tx.wait()
      setMsg('Applied. If this was a net loosening it was queued as pending instead — check Overview.')
      onDone()
    } catch (e: any) { setErr(extractRevertReason(e, iface)) }
    setBusy(false)
  }

  const S = form.collateralRate.length
  const canEdit = isParamAdmin && !wrongNetwork
  const errors = validateForm(form, consts)

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 12 }}><span className="icon">🧮</span>Edit StakeConfig</div>
      <NetworkGuard wrongNetwork={wrongNetwork} chainAId={chainAId} switchNetwork={switchNetwork} />

      {!wrongNetwork && !isParamAdmin && (
        <div className="status warn">
          Connected wallet (<span className="mono">{wallet.account}</span>) does not have Param Admin access.
        </div>
      )}

      {canEdit && (
        <>
          <p style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: 12 }}>
            A tightening change (more collateral / less refund at any sampled point) applies immediately;
            a loosening change is queued as pending for {consts ? Math.round(consts.loosenDelay / 3600) : '…'}h.
            Every change is capped at {consts ? bpsToPct(consts.maxDeltaBps) : '…'} relative move per call, and
            gated by a {consts ? Math.round(consts.changeCooldown / 3600) : '…'}h cooldown since the last change.
          </p>

          <div style={{ display: 'grid', gap: 20 }}>
            <div>
              <div className="flex-between"><div className="table-caption">Size buckets (ETH notional threshold → collateral rate bps)</div>
                <div><button className="ghost sm" onClick={addSizeBucket} style={{ marginTop: 0 }}>+ bucket</button> <button className="ghost sm" onClick={removeSizeBucket} style={{ marginTop: 0 }}>− bucket</button></div>
              </div>
              {Array.from({ length: S }, (_, i) => (
                <div className="row" key={i} style={{ marginTop: 6 }}>
                  <div>
                    {i < form.sizeThresholds.length
                      ? <input value={form.sizeThresholds[i]} onChange={e => set1D('sizeThresholds', i, e.target.value)}
                          placeholder={i === 0 ? 'threshold (ETH)' : `> ${form.sizeThresholds[i - 1] || '0'}`} />
                      : <input value="∞ (last bucket)" readOnly />}
                  </div>
                  <div><input value={form.collateralRate[i]} onChange={e => set1D('collateralRate', i, e.target.value)} placeholder="rate (bps)" /></div>
                </div>
              ))}
            </div>

            <div>
              <div className="flex-between"><div className="table-caption">Time buckets (blocks-left threshold, decreasing → multiplier bps)</div>
                <div><button className="ghost sm" onClick={addTimeBucket} style={{ marginTop: 0 }}>+ bucket</button> <button className="ghost sm" onClick={removeTimeBucket} style={{ marginTop: 0 }}>− bucket</button></div>
              </div>
              {Array.from({ length: form.timeMult.length }, (_, i) => (
                <div className="row" key={i} style={{ marginTop: 6 }}>
                  <div>
                    {i < form.timeThresholds.length
                      ? <input value={form.timeThresholds[i]} onChange={e => set1D('timeThresholds', i, e.target.value)}
                          placeholder={i === 0 ? 'threshold (blocks)' : `< ${form.timeThresholds[i - 1] || '0'}`} />
                      : <input value="0 (last bucket)" readOnly />}
                  </div>
                  <div><input value={form.timeMult[i]} onChange={e => set1D('timeMult', i, e.target.value)} placeholder="multiplier (bps)" /></div>
                </div>
              ))}
            </div>

            <div>
              <div className="flex-between"><div className="table-caption">Fill-ratio buckets (bps threshold, increasing)</div>
                <div><button className="ghost sm" onClick={addRatioBucket} style={{ marginTop: 0 }}>+ bucket</button> <button className="ghost sm" onClick={removeRatioBucket} style={{ marginTop: 0 }}>− bucket</button></div>
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {form.ratioThresholds.map((v, i) => (
                  <div key={i} style={{ maxWidth: 140 }}>
                    <input value={v} onChange={e => set1D('ratioThresholds', i, e.target.value)}
                      placeholder={i === 0 ? 'bps' : `> ${form.ratioThresholds[i - 1] || '0'}`} />
                  </div>
                ))}
              </div>

              <div className="table-caption" style={{ marginTop: 12 }}>Refund table — rows match the size buckets above (bps, last column must be 10000)</div>
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Order size (ETH)</th>
                      {Array.from({ length: R }, (_, r) => (
                        <th key={r}>{ascendingRangeLabel(form.ratioThresholds.map(v => bpsToPct(Number(v))), r, '')} filled</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {form.refundTable.map((row, s) => (
                      <tr key={s}>
                        <td>{ascendingRangeLabel(form.sizeThresholds, s, 'ETH')}</td>
                        {row.map((v, r) => (
                          <td key={r}><input value={v} onChange={e => setCell(s, r, e.target.value)} style={{ width: 70 }} /></td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="row">
              <div><label style={{ fontSize: '0.78rem', color: '#64748b' }}>Absolute collateral floor (ETH)</label>
                <input value={form.minCollateral} onChange={e => setForm(f => f && { ...f, minCollateral: e.target.value })} /></div>
            </div>
          </div>

          {errors.length > 0 && (
            <div className="status bad" style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 4 }}>This would revert on-chain — fix before submitting:</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          <div className="btn-row">
            <button className="ghost" onClick={() => setForm(toForm(config))} disabled={busy}>Reset to live config</button>
            <button onClick={submit} disabled={busy || errors.length > 0}>{busy ? 'Submitting…' : 'Submit setStakeConfig'}</button>
          </div>
        </>
      )}

      {err && <div className="status bad" style={{ marginTop: 12 }}>{err}</div>}
      {msg && <div className="status ok" style={{ marginTop: 12 }}>{msg}</div>}
    </div>
  )
}

// ── History (backend-indexed, see indexer/stakeConfigIndexer.ts) ────────────

interface HistoryRow {
  id: string
  event_type: 'applied' | 'pending_queued' | 'pending_cancelled' | 'rollback'
  block_number: number
  tx_hash: string
  effective_at: number | null
  config_snapshot: {
    sizeThresholds: string[]; collateralRate: number[]
    timeThresholds: string[]; timeMult: number[]
    ratioThresholds: string[]; refundTable: number[]
    minCollateral: string
  } | null
  created_at: string
}

const EVENT_LABEL: Record<HistoryRow['event_type'], { text: string; badge: string }> = {
  applied:            { text: 'Applied',   badge: 'filled' },
  pending_queued:      { text: 'Queued (loosening)', badge: 'pending' },
  pending_cancelled:  { text: 'Cancelled', badge: 'cancelled' },
  rollback:           { text: 'Rollback',  badge: 'chain' },
}

// The indexer stores plain strings/numbers (see stakeConfigIndexer.ts's
// snapshotToJson) — wrap back into the BigNumber-bearing shape ConfigTables
// expects so the same renderer works for both live and historical config.
function jsonToStakeConfig(s: NonNullable<HistoryRow['config_snapshot']>): StakeConfigStruct {
  return {
    sizeThresholds:  s.sizeThresholds.map(v => ethers.BigNumber.from(v)),
    collateralRate:  s.collateralRate,
    timeThresholds:  s.timeThresholds.map(v => ethers.BigNumber.from(v)),
    timeMult:        s.timeMult,
    ratioThresholds: s.ratioThresholds.map(v => ethers.BigNumber.from(v)),
    refundTable:     s.refundTable,
    minCollateral:   ethers.BigNumber.from(s.minCollateral),
  }
}

function short(addr: string): string { return addr ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : '—' }

type ConfigSnapshot = NonNullable<HistoryRow['config_snapshot']>

function arraysEqual(a: (string | number)[], b: (string | number)[]): boolean {
  return a.length === b.length && a.every((v, i) => String(v) === String(b[i]))
}

// Human-readable list of what changed vs. the nearest older snapshot — empty
// array means "no change", null prev means "nothing to compare against" (the
// very first indexed entry). Showing only the delta is far more legible than
// repeating all ~30 numbers when usually only one bucket actually moved.
function diffConfig(curr: ConfigSnapshot, prev: ConfigSnapshot | null): string[] {
  if (!prev) return []
  const diffs: string[] = []
  if (!arraysEqual(curr.collateralRate, prev.collateralRate)) {
    diffs.push(`Collateral rate: [${prev.collateralRate.map(v => bpsToPct(v)).join(', ')}] → [${curr.collateralRate.map(v => bpsToPct(v)).join(', ')}]`)
  }
  if (!arraysEqual(curr.timeMult, prev.timeMult)) {
    diffs.push(`Time multiplier: [${prev.timeMult.map(v => bpsToPct(v)).join(', ')}] → [${curr.timeMult.map(v => bpsToPct(v)).join(', ')}]`)
  }
  if (!arraysEqual(curr.refundTable, prev.refundTable)) {
    diffs.push(`Refund table changed (${curr.refundTable.length} cells — see full snapshot below)`)
  }
  if (!arraysEqual(curr.sizeThresholds, prev.sizeThresholds)) {
    diffs.push(`Size thresholds: [${prev.sizeThresholds.map(weiToEth).join(', ')}] → [${curr.sizeThresholds.map(weiToEth).join(', ')}] ETH`)
  }
  if (!arraysEqual(curr.timeThresholds, prev.timeThresholds)) {
    diffs.push(`Time thresholds: [${prev.timeThresholds.join(', ')}] → [${curr.timeThresholds.join(', ')}] blocks`)
  }
  if (!arraysEqual(curr.ratioThresholds, prev.ratioThresholds)) {
    diffs.push(`Fill-ratio thresholds: [${prev.ratioThresholds.map(v => bpsToPct(Number(v))).join(', ')}] → [${curr.ratioThresholds.map(v => bpsToPct(Number(v))).join(', ')}]`)
  }
  if (curr.minCollateral !== prev.minCollateral) {
    diffs.push(`Collateral floor: ${weiToEth(prev.minCollateral)} → ${weiToEth(curr.minCollateral)} ETH`)
  }
  return diffs
}

// Rows arrive most-recent-first (see GET /stake-config/history) — the "config
// live just before this one" is the nearest LATER entry in the array that
// actually carries a snapshot (pending_cancelled rows have none).
// Only 'applied' and 'rollback' rows ever actually change what's LIVE —
// 'pending_queued'/'pending_cancelled' snapshots are just proposals that may
// never take effect (or get re-proposed identically after a cancel, as here),
// so they must never be used as the "previous config" baseline for a diff.
function findPrevSnapshot(rows: HistoryRow[], index: number): ConfigSnapshot | null {
  for (let j = index + 1; j < rows.length; j++) {
    if ((rows[j].event_type === 'applied' || rows[j].event_type === 'rollback') && rows[j].config_snapshot) {
      return rows[j].config_snapshot
    }
  }
  return null
}

function History() {
  const { backendUrl } = useAppConfig()
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch(`${backendUrl}/stake-config/history`)
      const data = await res.json()
      if (res.ok) setRows(data.history ?? [])
      else setErr(data.error ?? 'Failed to load history')
    } catch (e: any) {
      setErr(e.message ?? String(e))
    }
    setLoading(false)
  }, [backendUrl])

  useEffect(() => { load() }, [load])

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <div className="card-title"><span className="icon">🕘</span>StakeConfig change history</div>
        <button className="ghost sm" onClick={load} disabled={loading} style={{ marginTop: 0 }}>{loading ? '…' : '↻ Refresh'}</button>
      </div>

      {err && <div className="status bad" style={{ marginBottom: 12 }}>{err}</div>}

      {!loading && rows.length === 0 && !err && (
        <div className="empty-state"><div className="empty-icon">🕘</div>No StakeConfig changes indexed yet.</div>
      )}

      {rows.map((row, i) => {
        const label = EVENT_LABEL[row.event_type]
        const isOpen = expanded === row.id
        return (
          <div key={row.id} className="slot-card" style={{ marginBottom: 10 }}>
            <div className="flex-between" style={{ cursor: row.config_snapshot ? 'pointer' : 'default' }}
                 onClick={() => row.config_snapshot && setExpanded(isOpen ? null : row.id)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className={`badge ${label.badge}`}>{label.text}</span>
                <span className="mono" style={{ fontSize: '0.78rem' }}>block #{row.block_number}</span>
                <span className="mono" style={{ fontSize: '0.78rem', color: '#94a3b8' }}>{short(row.tx_hash)}</span>
                {row.effective_at != null && (
                  <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                    effective {new Date(row.effective_at * 1000).toLocaleString()}
                  </span>
                )}
              </div>
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                {new Date(row.created_at).toLocaleString()} {row.config_snapshot ? (isOpen ? '▲' : '▼') : ''}
              </span>
            </div>
            {isOpen && row.config_snapshot && (() => {
              const prevSnap = findPrevSnapshot(rows, i)
              const diffs = diffConfig(row.config_snapshot, prevSnap)
              return (
                <div style={{ marginTop: 12 }}>
                  {diffs.length > 0 ? (
                    <div style={{ marginBottom: 10 }}>
                      <div className="table-caption">Changed vs. the config live just before this</div>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: '0.8rem', color: '#334155' }}>
                        {diffs.map((d, k) => <li key={k} style={{ marginBottom: 4 }}>{d}</li>)}
                      </ul>
                    </div>
                  ) : prevSnap ? (
                    <div className="status info" style={{ marginBottom: 10, fontSize: '0.8rem' }}>No changes vs. the previous config.</div>
                  ) : null}
                  <details>
                    <summary style={{ fontSize: '0.78rem', color: '#94a3b8', cursor: 'pointer' }}>show full config snapshot</summary>
                    <div style={{ marginTop: 10 }}><ConfigTables cfg={jsonToStakeConfig(row.config_snapshot)} /></div>
                  </details>
                </div>
              )
            })()}
          </div>
        )
      })}
    </div>
  )
}
