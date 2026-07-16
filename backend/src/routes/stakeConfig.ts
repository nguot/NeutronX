import { Router, Request, Response } from 'express'
import { ethers } from 'ethers'
import { db } from '../db/client'

const router = Router()

// GET /stake-config/history?limit=100 — most-recent-first feed of StakeConfig
// changes (see indexer/stakeConfigIndexer.ts). Public/read-only — the frontend's
// Overview/Guardian/ParamAdmin panels read LIVE state straight from the chain;
// this is the one piece (past history) that only the indexer can answer.
router.get('/history', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  try {
    const { rows } = await db.query(
      `SELECT id, event_type, block_number, tx_hash, effective_at, config_snapshot, created_at
       FROM stake_config_history
       ORDER BY block_number DESC, id DESC
       LIMIT $1`,
      [limit]
    )
    res.json({ history: rows })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /stake-config/validate — dry-run a candidate StakeConfig and, on failure,
// say EXACTLY which cell is wrong instead of the raw "execution reverted: kappa
// floor breached". Two layers:
//   1. A pure-TS mirror of DynamicStakeLib.worstCaseKappaBps (+ the shape/order
//      invariants) that PINPOINTS the offending size row / fill-ratio column.
//      Needs no RPC and no `from`.
//   2. If layer 1 passes and `from` is supplied, an eth_call (callStatic)
//      dry-run of setStakeConfig against the LIVE contract — this is the only
//      way to catch guardCheck's comparison against the live config (per-call
//      delta cap, penalty floor vs. live, cooldown, already-pending), which
//      cannot be computed from the candidate config alone.
//
// Body (contract-native units — same shape the frontend already builds in
// StakeConfig.tsx submit()):
//   { from?: "0x…",
//     config: { sizeThresholds: string[] /*wei*/, collateralRate: number[] /*bps*/,
//               timeThresholds: string[] /*blocks*/, timeMult: number[] /*bps*/,
//               ratioThresholds: string[] /*bps*/, refundTable: number[] /*flat bps*/,
//               minCollateral: string /*wei*/ } }
// ─────────────────────────────────────────────────────────────────────────────

const STAKE_CONFIG_TUPLE =
  'tuple(uint256[] sizeThresholds, uint32[] collateralRate, uint256[] timeThresholds, uint32[] timeMult, uint256[] ratioThresholds, uint32[] refundTable, uint256 minCollateral)'

const FILL_AUCTION_ABI = [
  `function setStakeConfig(${STAKE_CONFIG_TUPLE} c) external`,
  'function MIN_WORST_CASE_KAPPA_BPS() view returns (uint256)',
  'error Cooldown()',
  'error PendingExists()',
  'error NoPending()',
  'error StillPending()',
  'error NoPreviousConfig()',
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
]

// Plain-English rewrites for the contract's terse require-strings / custom errors.
const FRIENDLY: Record<string, string> = {
  'kappa floor breached':
    'This config would let a filler snipe (partial-fill then abandon) at a smaller price edge than the required floor. See `culprit` for the exact row/column that is too generous.',
  'penalty floor breached':
    'At some fill %, the penalty for stopping early drops below the required minimum. Reduce the refund at that fill %.',
  'collateral delta too large':
    'Change too large in one call: the collateral required moved more than the per-call cap (20%) at some sample point vs. the LIVE config. Make a smaller change, or split it across calls.',
  'penalty delta too large':
    'Change too large in one call: the penalty moved more than the per-call cap (20%) at some sample point vs. the LIVE config. Make a smaller change, or split it across calls.',
  Cooldown: 'A previous change is still within its cooldown window. Wait for the cooldown to elapse before submitting another.',
  PendingExists: 'A pending (queued) config already exists. Commit or cancel it before submitting a new one.',
  AccessControlUnauthorizedAccount: 'The `from` address does not hold PARAM_ADMIN_ROLE, so it cannot set the config.',
}
function friendly(reason: string): string {
  for (const key of Object.keys(FRIENDLY)) if (reason.includes(key)) return FRIENDLY[key]
  return reason
}

type Config = {
  sizeThresholds: string[]
  collateralRate: number[]
  timeThresholds: string[]
  timeMult: number[]
  ratioThresholds: string[]
  refundTable: number[]
  minCollateral: string
}

// weiSizeThreshold -> human ETH label for the culprit message.
function sizeRowLabel(sizeThresholds: string[], s: number): string {
  const eth = (w: string) => ethers.utils.formatEther(w)
  if (sizeThresholds.length === 0) return 'any size'
  if (s === 0) return `< ${eth(sizeThresholds[0])} ETH`
  if (s === sizeThresholds.length) return `>= ${eth(sizeThresholds[s - 1])} ETH`
  return `${eth(sizeThresholds[s - 1])} – ${eth(sizeThresholds[s])} ETH`
}

// Pure-TS mirror of DynamicStakeLib.worstCaseKappaBps operating on the flat,
// contract-native config. Returns the worst (lowest) breakeven edge across all
// (size, time) buckets and the argmin cell, or null when the config is
// shape-inconsistent (a shape error will already have been reported).
function worstCaseKappa(cfg: Config): { kappaBps: number; s: number; idx: number } | null {
  const S = cfg.collateralRate.length
  const T = cfg.timeMult.length
  const R = cfg.ratioThresholds.length + 1
  if (S < 1 || T < 1 || cfg.refundTable.length !== S * R) return null
  if (R < 2) return { kappaBps: 0, s: 0, idx: 0 }

  let best: { kappaBps: number; s: number; idx: number } | null = null
  for (let s = 0; s < S; s++) {
    let idx = -1
    for (let k = R - 1; k > 0; k--) {
      if (cfg.refundTable[s * R + (k - 1)] < 10000) { idx = k - 1; break }
    }
    if (idx === -1) return { kappaBps: 0, s, idx: 0 } // refunds 100% from bucket 0 — no deterrent

    const x = BigInt(cfg.ratioThresholds[idx])
    if (x === 0n) return { kappaBps: 0, s, idx }
    const penalty = 10000n - BigInt(cfg.refundTable[s * R + idx])
    const rho = BigInt(cfg.collateralRate[s])
    for (let t = 0; t < T; t++) {
      const mult = BigInt(cfg.timeMult[t])
      const combined = (rho * mult) / 10000n
      const kappa = Number((combined * penalty) / x)
      if (best === null || kappa < best.kappaBps) best = { kappaBps: kappa, s, idx }
    }
  }
  return best
}

router.post('/validate', async (req: Request, res: Response) => {
  const body = req.body as { from?: string; config?: Config }
  const cfg = body?.config
  if (!cfg || !Array.isArray(cfg.collateralRate) || !Array.isArray(cfg.refundTable)) {
    res.status(400).json({ error: 'Missing or malformed `config` in body.' })
    return
  }

  const S = cfg.collateralRate.length
  const T = cfg.timeMult.length
  const R = cfg.ratioThresholds.length + 1
  const minKappaBps = 1000 // mirrors FillAuction.MIN_WORST_CASE_KAPPA_BPS default (10%); refined below if RPC reachable

  // ── shape sanity (only the bits worstCaseKappa relies on; the frontend and
  // the contract enforce the full invariant set) ──
  if (cfg.refundTable.length !== S * R) {
    res.json({
      ok: false,
      reason: 'bad refund shape',
      message: `Refund table must be exactly ${S} rows × ${R} columns (${S * R} cells) — got ${cfg.refundTable.length}.`,
    })
    return
  }

  // ── layer 1: worst-case-kappa, with the culprit cell ──
  const wc = worstCaseKappa(cfg)
  if (wc && wc.kappaBps < minKappaBps) {
    const fillPct = wc.idx < cfg.ratioThresholds.length ? `${Number(cfg.ratioThresholds[wc.idx]) / 100}%` : 'the last non-100% column'
    res.json({
      ok: false,
      reason: 'kappa floor breached',
      message: friendly('kappa floor breached'),
      culprit: {
        sizeBucket: wc.s,
        sizeLabel: sizeRowLabel(cfg.sizeThresholds, wc.s),
        ratioBucket: wc.idx,
        fillPct,
        refundBps: cfg.refundTable[wc.s * R + wc.idx],
        collateralRateBps: cfg.collateralRate[wc.s],
        worstCaseKappaBps: wc.kappaBps,
      },
      worstCaseKappaBps: wc.kappaBps,
      minWorstCaseKappaBps: minKappaBps,
    })
    return
  }

  // ── layer 2: live dry-run (catches guardCheck / cooldown / pending) ──
  const addr = process.env.FILL_AUCTION
  const rpc = process.env.RPC_URL || process.env.ALCHEMY_RPC_URL || 'http://127.0.0.1:8545'
  if (!addr) {
    // Config is economically sound; we just can't reach the live contract to
    // check the vs-live guard. Report success at layer 1.
    res.json({ ok: true, worstCaseKappaBps: wc?.kappaBps ?? null, minWorstCaseKappaBps: minKappaBps, liveCheck: 'skipped: FILL_AUCTION not set' })
    return
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(rpc)
    const auction = new ethers.Contract(addr, FILL_AUCTION_ABI, provider)
    const liveMinKappa = await auction.MIN_WORST_CASE_KAPPA_BPS().then((v: ethers.BigNumber) => v.toNumber()).catch(() => minKappaBps)

    const tuple = {
      sizeThresholds: cfg.sizeThresholds.map(v => ethers.BigNumber.from(v)),
      collateralRate: cfg.collateralRate,
      timeThresholds: cfg.timeThresholds.map(v => ethers.BigNumber.from(v)),
      timeMult: cfg.timeMult,
      ratioThresholds: cfg.ratioThresholds.map(v => ethers.BigNumber.from(v)),
      refundTable: cfg.refundTable,
      minCollateral: ethers.BigNumber.from(cfg.minCollateral),
    }

    const overrides = body.from ? { from: body.from } : {}
    await auction.callStatic.setStakeConfig(tuple, overrides)
    // No revert -> either applies immediately (tighten) or queues as pending
    // (loosen); both are "acceptable" for validation purposes.
    res.json({ ok: true, worstCaseKappaBps: wc?.kappaBps ?? null, minWorstCaseKappaBps: liveMinKappa })
  } catch (e: any) {
    const reason: string =
      e?.errorName || e?.reason || e?.error?.message || e?.data?.message || e?.message || 'reverted'
    res.json({ ok: false, reason, message: friendly(reason), worstCaseKappaBps: wc?.kappaBps ?? null, minWorstCaseKappaBps: minKappaBps })
  }
})

export default router
