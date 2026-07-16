import type { Ora } from 'ora'

// A foreground command's own progress logs (e.g. crossChainFill.ts's
// "[crossChainFill] 1/6 fillSlot...") fire WHILE that same command's `ora`
// spinner (actions.ts's runCcOp/runFill) is still animating — the spinner
// repaints its line via raw ANSI cursor codes assuming nothing else touches
// stdout in between, so an interleaved plain console.log corrupts its cursor
// math for every redraw after it. (Background watcher noise — OrderListener,
// Executor, the quote server — no longer goes through here at all; see
// bgLog.ts, which routes it to a log file instead of stdout, removing that
// entire class of conflict at the source.)
//
// Fix: route console.log/error/warn through here. While a spinner is
// registered active, clear its line first, print normally, then let it
// re-render — instead of writing underneath/through it.
let activeSpinner: Ora | null = null

export function setActiveSpinner(spinner: Ora | null): void {
  activeSpinner = spinner
}

const orig = {
  log:   console.log.bind(console),
  error: console.error.bind(console),
  warn:  console.warn.bind(console),
}

function wrap(fn: (...args: any[]) => void) {
  return (...args: any[]) => {
    if (activeSpinner) {
      activeSpinner.clear()
      fn(...args)
      activeSpinner.render()
    } else {
      fn(...args)
    }
  }
}

let installed = false
export function installLogGate(): void {
  if (installed) return
  installed = true
  console.log   = wrap(orig.log)
  console.error = wrap(orig.error)
  console.warn  = wrap(orig.warn)
}
