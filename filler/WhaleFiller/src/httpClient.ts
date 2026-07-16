import axios from 'axios'

// Plain axios has no timeout by default — a stalled backend (slow query,
// overloaded watcher, mid-restart) leaves any `await axios.get(...)` pending
// forever with zero feedback. In the REPL that means the whole terminal looks
// "frozen": the in-flight command's dispatch() never resolves, so rl.prompt()
// never runs, while newly typed commands queue up behind it looking like
// nothing works. A bounded timeout turns a silent hang into a normal caught
// error instead.
export const http = axios.create({ timeout: 10_000 })
