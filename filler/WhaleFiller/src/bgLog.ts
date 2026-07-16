import { createWriteStream, mkdirSync } from 'fs'
import { join } from 'path'

// Background watchers (OrderListener, Executor's per-block loop, the quote
// server) run continuously and asynchronously — independent of whatever the
// interactive REPL is doing. Writing their output to the same stdout the
// REPL's readline prompt owns is what caused the "typing does nothing"
// terminal corruption (a monkey-patched console.log coordinating the two was
// the previous fix; this removes the need for that entirely by giving
// background output its own destination). REPL/CLI foreground output
// (actions.ts, repl.ts, crossChainFill's own progress logs) is unaffected —
// those still use plain console.log straight to the real terminal.
const LOG_DIR = join(__dirname, '..', 'logs')
mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = join(LOG_DIR, 'whalefiller.log')
const stream = createWriteStream(LOG_FILE, { flags: 'a' })

function write(level: string, args: unknown[]): void {
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  stream.write(`[${new Date().toISOString()}] ${level.padEnd(5)} ${msg}\n`)
}

export function bgLog(...args: unknown[]):   void { write('LOG',   args) }
export function bgWarn(...args: unknown[]):  void { write('WARN',  args) }
export function bgError(...args: unknown[]): void { write('ERROR', args) }

export const BG_LOG_FILE = LOG_FILE
