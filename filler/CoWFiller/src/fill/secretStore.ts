import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

// Model 2 (filler-holds-key): the filler generates its own HTLC secret per
// fill — the backend never sees it. If this process crashes between quoting
// a fill and calling EscrowSrc.withdraw(), the secret must survive locally so
// `crossChainResume` can pick the fill back up; there is nowhere else to
// recover it from (unlike Model 1, where the backend derived it on demand).
// Lives at the package root, same convention as PID_FILE (pidfile.ts).
const STORE_FILE = join(__dirname, '..', '..', '.cc-secrets.json')

type SecretStore = Record<string, string> // fillId -> secret (0x-prefixed 32 bytes)

function load(): SecretStore {
  if (!existsSync(STORE_FILE)) return {}
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

export function saveSecret(fillId: number, secret: string): void {
  const store = load()
  store[String(fillId)] = secret
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2))
}

export function loadSecret(fillId: number): string | null {
  return load()[String(fillId)] ?? null
}
