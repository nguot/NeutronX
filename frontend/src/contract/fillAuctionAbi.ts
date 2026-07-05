import { ethers } from 'ethers'

// Human-readable ABI for the FillAuction surface the StakeConfig pages need —
// see contract/src/FillAuction.sol / contract/src/libs/DynamicStakeLib.sol.
// StakeConfig itself is defined in DynamicStakeLib but embedded here as a tuple
// since ethers v5 needs the shape spelled out at every call site.
const STAKE_CONFIG_TUPLE =
  'tuple(uint256[] sizeThresholds, uint32[] collateralRate, uint256[] timeThresholds, uint32[] timeMult, uint256[] ratioThresholds, uint32[] refundTable, uint256 minCollateral)'

export const FILL_AUCTION_ABI = [
  `function stakeConfig() view returns (${STAKE_CONFIG_TUPLE})`,
  `function pendingConfig() view returns (${STAKE_CONFIG_TUPLE})`,
  `function setStakeConfig(${STAKE_CONFIG_TUPLE} c) external`,
  'function commitPending() external',
  'function cancelPendingConfig() external',
  'function rollback() external',
  'function pendingEffective() view returns (uint256)',
  'function lastChange() view returns (uint256)',

  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account) external',
  'function revokeRole(bytes32 role, address account) external',
  'function PARAM_ADMIN_ROLE() view returns (bytes32)',
  'function GUARDIAN_ROLE() view returns (bytes32)',
  'function KEEPER_ROLE() view returns (bytes32)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',

  'function MIN_COLLATERAL_RATE() view returns (uint32)',
  'function MAX_COLLATERAL_RATE() view returns (uint32)',
  'function MAX_REFUND_BPS() view returns (uint32)',
  'function MAX_BUCKETS() view returns (uint256)',
  'function MAX_DELTA_BPS() view returns (uint256)',
  'function MIN_PENALTY_BPS() view returns (uint256)',
  'function CHANGE_COOLDOWN() view returns (uint256)',
  'function LOOSEN_DELAY() view returns (uint256)',

  'event StakeConfigUpdated()',
  'event PendingConfigQueued(uint256 effectiveAt)',
  'event PendingConfigCancelled()',
  'event ConfigRollback()',

  // B4 state-machine custom errors (see FillAuction.sol's comment-code legend) —
  // included so ethers can decode a revert into a readable name instead of raw hex.
  'error Cooldown()',
  'error PendingExists()',
  'error NoPending()',
  'error StillPending()',
  'error NoPreviousConfig()',
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
]

// Mirrors DynamicStakeLib.StakeConfig — ethers v5 decodes a `tuple(...)` return
// into an array-like object with both numeric AND named-field access; this is
// the named shape we actually read/write in the UI.
export interface StakeConfigStruct {
  sizeThresholds:  ethers.BigNumber[]
  collateralRate:  number[]
  timeThresholds:  ethers.BigNumber[]
  timeMult:        number[]
  ratioThresholds: ethers.BigNumber[]
  refundTable:     number[]
  minCollateral:   ethers.BigNumber
}

// `_pending`'s "no pending queued" sentinel (see FillAuction.sol) — a validated
// config always has at least one size bucket, so an empty array means nothing
// is queued.
export function hasPending(cfg: StakeConfigStruct | null): boolean {
  return !!cfg && cfg.collateralRate.length > 0
}

// # of size / time / fill-ratio buckets a config actually has (thresholds are
// always bucket-count − 1).
export function sizeBucketCount(cfg: StakeConfigStruct): number  { return cfg.collateralRate.length }
export function timeBucketCount(cfg: StakeConfigStruct): number  { return cfg.timeMult.length }
export function ratioBucketCount(cfg: StakeConfigStruct): number { return cfg.ratioThresholds.length + 1 }

// refundTable is stored row-major flattened: refundTable[s*R + r].
export function refundAt(cfg: StakeConfigStruct, s: number, r: number): number {
  const R = ratioBucketCount(cfg)
  return cfg.refundTable[s * R + r]
}

export function bpsToPct(bps: number | ethers.BigNumberish): string {
  const n = typeof bps === 'number' ? bps : Number(bps)
  return `${(n / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
}

export function weiToEth(wei: ethers.BigNumberish): string {
  return ethers.utils.formatEther(wei)
}

// Best-effort human message out of an ethers v5 revert — require(string) reverts
// usually surface via err.reason already; custom errors (Cooldown, etc.) need the
// ABI's `error` fragments to decode, which FILL_AUCTION_ABI provides.
export function extractRevertReason(err: any, iface: ethers.utils.Interface): string {
  const data = err?.data ?? err?.error?.data ?? err?.error?.error?.data
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try { return iface.parseError(data).name } catch { /* not a known custom error */ }
  }
  return err?.reason || err?.error?.message || err?.message || 'Transaction failed'
}
