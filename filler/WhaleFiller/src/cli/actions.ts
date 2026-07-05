import Table from 'cli-table3'
import ora from 'ora'
import { ethers } from 'ethers'
import { wallet, fillAuction } from '../contract/contracts'
import { decide } from '../strategy/strategy'
import { fill } from '../fill/partialFill'
import { crossChainFill, crossChainClaim } from '../fill/crossChainFill'
import {
  fetchOpenOrders, fetchOrder, fetchCcOrders, resetSlot,
  currentBlock, readBalances,
} from './data'
import {
  sym, human, humanRaw, priceHuman, progressBar, shortHash,
  statusLabel, banner, c,
} from './format'
import type { OrderInfo } from '../types'

export const FILLER_NAME = 'WhaleFiller'

// ── Hash resolution — accepts either a full 0x-prefixed 32-byte hash or any
// unambiguous prefix of one (e.g. the truncated form the tables print, like
// "0x2a5c33"). Lets every command be driven from what's already on screen —
// no second terminal/curl needed to go fetch the full hash. ─────────────────
function pickByPrefix(input: string, candidates: string[]): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(input)) return input
  const norm = input.toLowerCase()
  const matches = candidates.filter(h => h.toLowerCase().startsWith(norm))
  if (matches.length === 0) throw new Error(`no open order matches '${input}'`)
  if (matches.length > 1) throw new Error(`'${input}' matches ${matches.length} open orders — use more characters`)
  return matches[0]
}

export async function resolveOrderHash(input: string): Promise<string> {
  const orders = await fetchOpenOrders()
  return pickByPrefix(input, orders.map(o => o.hash))
}

export async function resolveCcOrderHash(input: string): Promise<string> {
  const orders = await fetchCcOrders()
  return pickByPrefix(input, orders.map((o: any) => o.orderHash))
}

// ── Derived per-order view (filled %, live auction price, blocks left) ─────────
function orderView(o: OrderInfo, block: number) {
  const inputAmt = BigInt(o.inputAmount || '0')
  const fills    = o.fills ?? []
  const filled   = fills.reduce((s, f) => s + BigInt(f.fillAmount ?? '0'), 0n)
  const remaining = inputAmt > filled ? inputAmt - filled : 0n
  const filledPct = inputAmt > 0n ? Number((filled * 100n) / inputAmt) : 0

  const lastFillBlock = fills.length > 0 ? (fills[fills.length - 1].blockNumber ?? block) : block
  const blocksPassed  = BigInt(Math.max(0, block - lastFillBlock))
  const sp  = BigInt(o.startPrice ?? '0')
  const dpb = BigInt(o.decayPerBlock ?? 0)
  const price = sp > dpb * blocksPassed ? sp - dpb * blocksPassed : 0n
  const blocksLeft = Math.max(0, o.deadline - block)

  return { inputAmt, filled, remaining, filledPct, price, blocksLeft }
}

// ── orders ────────────────────────────────────────────────────────────────────
export async function renderOrders(): Promise<void> {
  const block  = await currentBlock()
  const orders = await fetchOpenOrders()
  console.log(banner(FILLER_NAME, `open orders · block #${block}`))
  if (!orders.length) { console.log(c.dim('\n  no open orders.\n')); return }

  // Pull per-order detail (fills) so the progress + price columns are accurate.
  const details = await Promise.all(orders.map(o => fetchOrder(o.hash).catch(() => o)))

  const table = new Table({
    head: ['HASH', 'PAIR', 'FILLED', 'PRICE', 'LEFT'].map(h => c.bold(c.dim(h))),
    style: { head: [], border: [] },
  })
  details.forEach(o => {
    const v = orderView(o, block)
    const pair = `${sym(o.inputToken)}→${sym(o.outputToken)}`
    const price = v.price > 0n ? `${priceHuman(v.price, o.inputToken, o.outputToken)}` : c.dim('—')
    table.push([
      c.yellow(shortHash(o.hash)),
      pair,
      `${progressBar(v.filledPct, 12)} ${String(v.filledPct).padStart(3)}%`,
      price,
      `${v.blocksLeft} blk`,
    ])
  })
  console.log('\n' + table.toString() + '\n')
}

// ── balances ────────────────────────────────────────────────────────────────
export async function renderBalances(): Promise<void> {
  console.log(banner(FILLER_NAME, `wallet ${wallet.address}`))
  const chains = await readBalances()
  for (const ch of chains) {
    const table = new Table({ head: [c.cyan(ch.label), c.dim('balance')], style: { head: [], border: [] } })
    table.push(['ETH', humanRaw(ch.eth, 18)])
    for (const t of ch.tokens) table.push([t.symbol, humanRaw(t.balance, t.decimals)])
    console.log('\n' + table.toString())
  }
  console.log('')
}

// ── strategy verdict (runs decide(): profit/loss the filler sees) ──────────────
async function renderStrategy(order: OrderInfo, block: number): Promise<void> {
  const d  = await decide(order, block)
  const ex = (d.extras ?? {}) as Record<string, unknown>
  const verdict = d.shouldFill ? c.green('✓ profitable') : c.yellow('✗ no fill')
  console.log(`  ${c.bold('strategy')}  ${verdict}  ${c.dim(d.reason ?? '')}`)
  if (ex.estimatedProfit !== undefined) console.log(`    est. profit   ${c.green('+' + String(ex.estimatedProfit))} ${sym(order.outputToken)}`)
  if (ex.spreadBps       !== undefined) console.log(`    spread        ${c.bold(String(ex.spreadBps))} bps`)
  if (ex.matchedLevels   !== undefined) console.log(`    matched lvls  ${String(ex.matchedLevels)}`)
  if (ex.inventoryHuman  !== undefined) console.log(`    inventory     ${String(ex.inventoryHuman)} ${sym(order.outputToken)}`)
}

// ── sim (dry-run preview of a fill, no tx) ─────────────────────────────────────
export async function renderSim(hash: string, pct: number): Promise<void> {
  const [detail, block] = await Promise.all([fetchOrder(hash), currentBlock()])
  console.log(banner(FILLER_NAME, `sim ${shortHash(hash)} @ ${pct}%`))
  console.log(c.dim(`  full hash   ${hash}`))
  console.log(c.dim(
    `  order size  ${human(detail.inputAmount, detail.inputToken)} ${sym(detail.inputToken)}` +
    ` → min ${human((detail as any).minOutput || '0', detail.outputToken)} ${sym(detail.outputToken)}`
  ) + '\n')
  await renderStrategy(detail, block)
  console.log('')

  const v = orderView(detail, block)
  if (v.remaining === 0n) { console.log(c.red('  order already fully filled')); return }
  if (v.price === 0n)     { console.log(c.red('  price decayed to zero')); return }

  const inputAmt = v.inputAmt
  const fillAmt0 = (v.remaining * BigInt(pct)) / 100n
  const minFill  = (inputAmt * BigInt(detail.minFillBps || 100)) / 10_000n
  let actualFill = fillAmt0 < minFill ? minFill : fillAmt0
  if (actualFill > v.remaining) actualFill = v.remaining
  const outputNeeded = (actualFill * v.price) / 10n ** 18n

  // Honor the swapper's minOutput floor — the reactor reverts any fill below it.
  const minOutput   = BigInt((detail as any).minOutput || '0')
  const requiredOut = inputAmt > 0n ? (actualFill * minOutput) / inputAmt : 0n

  const inS = sym(detail.inputToken), outS = sym(detail.outputToken)
  if (outputNeeded < requiredOut) {
    console.log(c.red(
      `  ✗ would REVERT — provides ${human(outputNeeded, detail.outputToken)} ${outS}` +
      ` < swapper minimum ${human(requiredOut, detail.outputToken)} ${outS} (auction price below floor)\n`
    ))
    return
  }

  // D-1: same view call partialFill.ts uses right before register() — the
  // exact ETH collateral this fill would require, not an estimate.
  let stakeLine: string
  try {
    const stakeWei = (await fillAuction.previewCollateral(
      detail.inputToken, detail.feeTier, actualFill, detail.deadline
    )).toBigInt()
    stakeLine = `    stake     ${c.bold(ethers.utils.formatEther(stakeWei))} ETH`
  } catch (e: any) {
    stakeLine = c.dim(`    stake     unavailable (${e?.reason ?? e?.message ?? e})`)
  }

  const filledPctAfter = inputAmt > 0n ? Number(((v.filled + actualFill) * 100n) / inputAmt) : 0
  // Requested `pct` is of REMAINING; minFillBps is a floor on % of the TOTAL
  // order — the two are different bases, so silently bumping without saying so
  // makes the header lie about what's about to execute (you asked for 21%,
  // this call actually fills 30% of the order — a real fill amount, not a typo).
  const wasBumped = fillAmt0 < minFill && v.remaining > minFill
  const headline = wasBumped
    ? `  ${c.green('✓ fillable')} — requested ${pct}% of remaining, bumped to ${human(actualFill, detail.inputToken)} ${inS}` +
      ` (${filledPctAfter.toFixed(1)}% of total order — swapper's minFillBps floor, can't fill less)`
    : `  ${c.green('✓ fillable')} @ ${pct}% of remaining`
  console.log(
    headline + '\n' +
    `    receive   ${c.bold(human(actualFill, detail.inputToken))} ${inS}\n` +
    `    provide   ${c.bold(human(outputNeeded, detail.outputToken))} ${outS}\n` +
    `    price     ${priceHuman(v.price, detail.inputToken, detail.outputToken)} ${outS}/${inS}\n` +
    stakeLine + '\n' +
    `    fills to  ${filledPctAfter.toFixed(1)}%\n`
  )
}

// ── fill (executes the partial fill) ───────────────────────────────────────────
export async function runFill(hash: string, pct: number): Promise<void> {
  // Show the strategy's profit/loss read before committing the fill.
  const order = await fetchOrder(hash).catch(() => null)
  if (order) { await renderStrategy(order, await currentBlock().catch(() => 0)); console.log('') }

  // Same bump math as partialFill.ts's fill() — recomputed here only so the
  // spinner/success message reports what will ACTUALLY be filled, instead of
  // just echoing --pct back (misleading once minFillBps silently bumps it up).
  let pctLabel = `${pct}%`
  if (order) {
    const inputAmt  = BigInt(order.inputAmount)
    const filled    = (order.fills ?? []).reduce((s, f) => s + BigInt(f.fillAmount ?? '0'), 0n)
    const remaining = inputAmt > filled ? inputAmt - filled : 0n
    const requested = (remaining * BigInt(pct)) / 100n
    const minFill   = (inputAmt * BigInt(order.minFillBps || 100)) / 10_000n
    let actualFill  = requested < minFill ? minFill : requested
    if (actualFill > remaining) actualFill = remaining
    if (actualFill !== requested) {
      const actualPctOfOrder = inputAmt > 0n ? Number((actualFill * 100n) / inputAmt) : 0
      pctLabel = `${pct}% requested → ${actualPctOfOrder.toFixed(1)}% of order (minFillBps floor)`
    }
  }

  const spin = ora(`fill ${shortHash(hash)} @ ${pctLabel} — register → approve → execute`).start()
  try {
    const tx = await fill(hash, pct * 100)
    spin.succeed(`filled ${shortHash(hash)} @ ${pctLabel}   ${c.dim('tx')} ${tx}`)
  } catch (e: any) {
    spin.fail(c.red(e?.message ?? String(e)))
    process.exitCode = 1
  }
}

// ── cross-chain ────────────────────────────────────────────────────────────────
export async function renderCcOrders(): Promise<void> {
  const orders = await fetchCcOrders()
  console.log(banner(FILLER_NAME, 'cross-chain orders'))
  if (!orders.length) { console.log(c.dim('\n  no cross-chain orders with available slots.\n')); return }
  for (const o of orders) {
    const pair = `${sym(o.inputToken)}→${sym(o.outputToken)}`
    console.log(
      `\n  ${c.yellow(shortHash(o.orderHash))}  ${c.bold(pair)}  ` +
      `${c.dim(`chain ${o.chainAId}→${o.dstChainId}`)}  ${c.dim(`${o.numSlots} slots`)}`
    )
    const table = new Table({ head: ['SLOT', 'STATUS', 'FILLER'].map(h => c.dim(h)), style: { head: [], border: [] } })
    for (const s of (o.slots ?? [])) {
      table.push([String(s.index), statusLabel(s.status), s.assignedFiller ? shortHash(s.assignedFiller) : c.dim('—')])
    }
    console.log(table.toString())
  }
  console.log('')
}

export async function runCcOp(label: string, hash: string, slot: number, fn: () => Promise<string>): Promise<void> {
  const spin = ora(`${label} ${shortHash(hash)} slot ${slot}`).start()
  try {
    const res = await fn()
    if (res === 'reset-to-available') spin.warn(`slot ${slot} was stale — reset to available, re-run cc fill`)
    else if (res === 'already-claimed') spin.succeed(`slot ${slot} was already claimed — marked done`)
    else spin.succeed(`${label} slot ${slot} done   ${c.dim('tx')} ${res}`)
  } catch (e: any) {
    spin.fail(c.red(e?.message ?? String(e)))
    process.exitCode = 1
  }
}

export async function runCcFill(hash: string, slot: number): Promise<void> {
  await runCcOp('cc fill', hash, slot, () => crossChainFill(hash, slot))
}

export async function runCcClaim(hash: string, slot: number): Promise<void> {
  await runCcOp('cc claim', hash, slot, () => crossChainClaim(hash, slot))
}

export async function runCcReset(hash: string, slot: number): Promise<void> {
  await runCcOp('cc reset', hash, slot, async () => { await resetSlot(hash, slot); return 'reset' })
}

// ── quote (parity with the /quote API: run the strategy on an ad-hoc order) ─────
export async function runQuote(opts: any): Promise<void> {
  const block = await currentBlock()
  const order: OrderInfo = {
    hash: '0x' + '0'.repeat(64), swapper: '0x' + '0'.repeat(40),
    inputToken: opts.in, outputToken: opts.out, inputAmount: opts.amount,
    minOutput: '0', deadline: Number(opts.deadline ?? block + 100), nonce: 0,
    minFillBps: Number(opts.minFillBps ?? 100), startPrice: opts.startPrice,
    decayPerBlock: Number(opts.decay), feeTier: Number(opts.feeTier ?? 500),
    signature: '0x' + '0'.repeat(130), status: 'pending', fills: [],
  }
  const d = await decide(order, block)
  console.log(banner(FILLER_NAME, 'quote'))
  console.log(
    `\n  wouldFill   ${d.shouldFill ? c.green('yes') : c.red('no')}\n` +
    `    fillAmount  ${human(d.fillAmount, opts.in)} ${sym(opts.in)}\n` +
    `    price       ${priceHuman(d.currentPrice, opts.in, opts.out)} ${sym(opts.out)}/${sym(opts.in)}\n` +
    `    reason      ${d.reason ?? '—'}\n`
  )
}

// ── watch wrapper: re-render every `seconds` with a cleared screen ─────────────
export async function withWatch(seconds: number | undefined, render: () => Promise<void>): Promise<void> {
  if (!seconds) { await render(); return }
  const tick = async () => { process.stdout.write('\x1Bc'); await render().catch(e => console.error(c.red(e.message))) }
  await tick()
  setInterval(tick, seconds * 1000)
}
