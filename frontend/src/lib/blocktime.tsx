import { useState, useEffect } from 'react'
import { useAppConfig } from '../context/AppConfig'

// Orders use block numbers for deadlines, which are meaningless to a human ("ends
// at block 20500292"). Like every real DeFi UI (Uniswap shows minutes / a clock
// time), we translate the block gap into wall-clock time using a nominal block
// time. On the mainnet fork blocks are mined on demand, so this is an *estimate*
// at mainnet's cadence — enough to convey the time scale, which is the point.
export const NOMINAL_BLOCK_SEC = 12

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  if (s < 60)  return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60)  return `${m} min`
  const h = Math.floor(m / 60), mm = m % 60
  if (h < 24)  return mm ? `${h}h ${mm}m` : `${h}h`
  const d = Math.floor(h / 24), hh = h % 24
  return hh ? `${d}d ${hh}h` : `${d}d`
}

export interface Eta { label: string; clock: string; blocks: number; expired: boolean }

export function blockEta(target: number, current: number, secPerBlock = NOMINAL_BLOCK_SEC): Eta {
  const blocks  = target - current
  const seconds = blocks * secPerBlock
  const clock   = new Date(Date.now() + seconds * 1000)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return blocks <= 0
    ? { label: `ended ≈ ${formatDuration(-seconds)} ago`, clock, blocks, expired: true }
    : { label: `≈ ${formatDuration(seconds)} left`,        clock, blocks, expired: false }
}

// Drop-in human-time label for a block deadline. Reads the current block from
// AppConfig, or takes an explicit `current` when a page already polls it.
export function BlockEta({ target, current, showClock = true, style }: {
  target: number
  current?: number | null
  showClock?: boolean
  style?: React.CSSProperties
}) {
  const { currentBlock } = useAppConfig()
  const cur = current ?? currentBlock
  const title = `block ${target} · estimate at ~${NOMINAL_BLOCK_SEC}s/block`
  if (cur == null) {
    return <span className="uni-label-muted" title={title} style={style}>block {target}</span>
  }
  const eta = blockEta(target, cur)
  return (
    <span title={title} style={{ color: eta.expired ? '#dc2626' : undefined, ...style }}>
      {eta.label}{showClock && !eta.expired ? ` · ~${eta.clock}` : ''}
    </span>
  )
}

// Model 2 timelocks (deadlineBase, t1, t2) are unix timestamps, not block
// numbers — this reads wall-clock time directly instead of estimating via a
// nominal block time.
export function timeEta(targetUnixSec: number, nowUnixSec = Date.now() / 1000): Eta {
  const seconds = targetUnixSec - nowUnixSec
  const clock = new Date(targetUnixSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return seconds <= 0
    ? { label: `ended ≈ ${formatDuration(-seconds)} ago`, clock, blocks: 0, expired: true }
    : { label: `≈ ${formatDuration(seconds)} left`,        clock, blocks: 0, expired: false }
}

// Drop-in human-time label for a unix-timestamp deadline (T1/T2/deadlineBase).
// Self-ticks every 15s so the countdown stays roughly live without a poll.
export function TimeEta({ target, showClock = true, style }: {
  target: number
  showClock?: boolean
  style?: React.CSSProperties
}) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 15000)
    return () => clearInterval(id)
  }, [])
  const eta = timeEta(target, now)
  const title = new Date(target * 1000).toLocaleString()
  return (
    <span title={title} style={{ color: eta.expired ? '#dc2626' : undefined, ...style }}>
      {eta.label}{showClock && !eta.expired ? ` · ~${eta.clock}` : ''}
    </span>
  )
}
