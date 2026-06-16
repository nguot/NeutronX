import { randomBytes, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { parse as parseEnv } from 'dotenv'

// Admin credentials live in backend/.env (ADMIN_USERNAME / ADMIN_PASSWORD) —
// the same config file the Admin → Config tab already reads/writes.
//
// Trufy 3.2: NO hardcoded fallback. If ADMIN_USERNAME/ADMIN_PASSWORD are unset,
// getCredentials() returns null and every login fails closed — the backend will
// not silently accept admin/admin. Session tokens are random and expiring, not a
// deterministic sha256(user:pass) that stays valid forever.
function getCredentials(): { username: string; password: string } | null {
  let env: Record<string, string> = {}
  try { env = parseEnv(readFileSync(resolve(process.cwd(), '.env'))) } catch { /* ignore */ }
  const username = env.ADMIN_USERNAME ?? process.env.ADMIN_USERNAME
  const password = env.ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD
  if (!username || !password) return null   // fail closed
  return { username, password }
}

// Constant-time string compare (avoids leaking the password via timing).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000   // 12h
const sessions = new Map<string, number>()   // token -> expiresAt (epoch ms)

function sweepExpired(now: number): void {
  for (const [tok, exp] of sessions) if (exp <= now) sessions.delete(tok)
}

// Returns a fresh random session token if credentials match, or null otherwise.
export function login(username: string, password: string): string | null {
  const creds = getCredentials()
  if (!creds) return null   // credentials not configured → no login possible
  if (!safeEqual(username, creds.username) || !safeEqual(password, creds.password)) return null

  const now = Date.now()
  sweepExpired(now)
  const token = randomBytes(32).toString('hex')
  sessions.set(token, now + SESSION_TTL_MS)
  return token
}

// Valid only if the token corresponds to a live, unexpired session.
export function verifyToken(token: string | undefined | null): boolean {
  if (!token) return false
  const now = Date.now()
  const exp = sessions.get(token)
  if (exp === undefined) return false
  if (exp <= now) { sessions.delete(token); return false }
  return true
}

// Invalidate a session (logout).
export function revokeToken(token: string | undefined | null): void {
  if (token) sessions.delete(token)
}
