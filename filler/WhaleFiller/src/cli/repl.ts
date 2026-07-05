import * as readline from 'readline'
import {
  FILLER_NAME, renderOrders, renderBalances, renderSim, runFill,
  renderCcOrders, runCcFill, runCcClaim, runCcReset, runQuote,
  resolveOrderHash, resolveCcOrderHash,
} from './actions'
import { c } from './format'

// Splits a typed line into positional args and `--flag value` / `--flag` pairs —
// a minimal stand-in for commander, since the standalone CLI process exits
// after one command but this REPL has to keep parsing lines forever.
function parseLine(line: string): { pos: string[]; flags: Record<string, string> } {
  const tokens = line.trim().split(/\s+/).filter(Boolean)
  const pos: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('--')) {
      const key = t.slice(2)
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ }
      else flags[key] = 'true'
    } else pos.push(t)
  }
  return { pos, flags }
}

const HELP = `
  orders                        list open orders (accepts hash prefixes below)
  balances                      wallet balances on every configured chain
  sim <hash> [--pct n]          dry-run a fill preview, no tx (default 50%)
  fill <hash> [--pct n]         execute a partial fill (default 100%)
  cc list                       list cross-chain orders + slot status
  cc fill <hash> <slot>         fill one cross-chain Merkle slot
  cc claim <hash> <slot>        recover a slot the backend already claimed
  cc reset <hash> <slot>        reset a stuck locked slot back to available
  quote --in <a> --out <a> --amount <wei> --start-price <raw> --decay <n>
  help                          show this
` + c.dim(
  '\n  <hash> accepts the short form shown in tables (e.g. 0x2a5c33) as long as\n' +
  '  it uniquely matches one open order — no need to look up the full hash.\n'
)

async function dispatch(line: string): Promise<void> {
  const { pos, flags } = parseLine(line)
  const cmd = pos[0]
  if (!cmd) return
  try {
    switch (cmd) {
      case 'help': console.log(HELP); break

      case 'orders':
        await renderOrders()
        break

      case 'balances':
        await renderBalances()
        break

      case 'sim': {
        if (!pos[1]) { console.log(c.red('usage: sim <hash> [--pct n]')); break }
        const hash = await resolveOrderHash(pos[1])
        await renderSim(hash, Number(flags.pct ?? 50))
        break
      }

      case 'fill': {
        if (!pos[1]) { console.log(c.red('usage: fill <hash> [--pct n]')); break }
        const hash = await resolveOrderHash(pos[1])
        await runFill(hash, Number(flags.pct ?? 100))
        break
      }

      case 'cc': {
        const sub = pos[1]
        if (sub === 'list') {
          await renderCcOrders()
        } else if (sub === 'fill' || sub === 'claim' || sub === 'reset') {
          if (!pos[2] || !pos[3]) { console.log(c.red(`usage: cc ${sub} <hash> <slot>`)); break }
          const hash = await resolveCcOrderHash(pos[2])
          const slot = Number(pos[3])
          if (sub === 'fill')  await runCcFill(hash, slot)
          if (sub === 'claim') await runCcClaim(hash, slot)
          if (sub === 'reset') await runCcReset(hash, slot)
        } else {
          console.log(c.red(`unknown 'cc ${sub ?? ''}' — try: cc list | cc fill <hash> <slot> | cc claim <hash> <slot> | cc reset <hash> <slot>`))
        }
        break
      }

      case 'quote':
        await runQuote({
          in: flags.in, out: flags.out, amount: flags.amount,
          startPrice: flags['start-price'], decay: flags.decay,
          minFillBps: flags['min-fill-bps'], deadline: flags.deadline, feeTier: flags['fee-tier'],
        })
        break

      default:
        console.log(c.red(`unknown command '${cmd}' — type 'help'`))
    }
  } catch (e: any) {
    console.log(c.red(e?.message ?? String(e)))
  }
}

// Wires an interactive console onto the bot's own stdin, so the same terminal
// that shows listener/executor logs also runs `orders` / `sim` / `fill` / etc —
// no second terminal, no separate `npm run cli` process. Note: unlike the
// standalone CLI, `--watch` isn't offered here — a periodic screen clear would
// wipe the bot's own log history, so just re-run the command when you want a
// refresh.
export function startRepl(): void {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${FILLER_NAME.toLowerCase()}> ` })
  console.log(c.dim(`\ntype 'help' for CLI commands (orders, sim, fill, cc ...) — same terminal, no need to open another.\n`))
  rl.prompt()
  rl.on('line', async (line) => {
    await dispatch(line)
    rl.prompt()
  })
  rl.on('close', () => {
    console.log(c.dim('\nconsole closed (bot keeps running) — Ctrl+C to stop the process.'))
  })
}
