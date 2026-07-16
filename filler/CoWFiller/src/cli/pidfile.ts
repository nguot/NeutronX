import { join } from 'path'

// Written by the watcher (`npm start` / index.ts) on boot, read by the
// `shutdown` CLI command to find the process to signal. Lives at the package
// root so it resolves the same regardless of which file constructs the path.
export const PID_FILE = join(__dirname, '..', '..', '.filler.pid')
