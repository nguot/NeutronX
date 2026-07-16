import * as readline from 'readline'
import {
  FILLER_NAME, renderOrders, renderBalances, renderSim, runFill,
  renderCcOrders, runCcFill, runCcResume, runQuote,
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
  cc list                       list cross-chain orders + fill status
  cc fill <hash> <pct>          start a new fill for <pct>% of what's still fillable
  cc resume <hash> <fillId>     resume an in-flight fill after a crash/restart
  quote --in <a> --out <a> --amount <wei> --start-price <raw> --decay <n>
  shutdown                      stop the bot (same as Ctrl+C)
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
        } else if (sub === 'fill') {
          if (!pos[2] || !pos[3]) { console.log(c.red('usage: cc fill <hash> <pct>')); break }
          await runCcFill(await resolveCcOrderHash(pos[2]), Number(pos[3]))
        } else if (sub === 'resume') {
          if (!pos[2] || !pos[3]) { console.log(c.red('usage: cc resume <hash> <fillId>')); break }
          await runCcResume(await resolveCcOrderHash(pos[2]), Number(pos[3]))
        } else {
          console.log(c.red(`unknown 'cc ${sub ?? ''}' — try: cc list | cc fill <hash> <pct> | cc resume <hash> <fillId>`))
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

      case 'shutdown':
        console.log(c.dim('shutting down…'))
        process.kill(process.pid, 'SIGTERM')
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
  // Hard guarantee: Ctrl+C always exits, even if a command is stuck on a
  // hung network call (e.g. an unresponsive backend/RPC with no timeout —
  // the actual cause of "types fine, Enter does nothing, Ctrl+C doesn't
  // either": the in-flight dispatch() never resolves, so process.exit() from
  // the SIGTERM/SIGINT handler in index.ts never gets a turn to run either).
  // Bypass all of that and force-kill immediately on the readline interface's
  // own Ctrl+C detection, independent of whatever else the process is doing.
  rl.on('SIGINT', () => process.exit(1))
  rl.on('close', () => {
    console.log(c.dim('\nconsole closed (bot keeps running) — Ctrl+C to stop the process.'))
  })
}
