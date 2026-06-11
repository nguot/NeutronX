import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { parse as parseEnv } from 'dotenv'

// Admin credentials live in backend/.env (ADMIN_USERNAME / ADMIN_PASSWORD) —
// the same config file the Admin → Config tab already reads/writes.
function getCredentials(): { username: string; password: string } {
  let env: Record<string, string> = {}
  try { env = parseEnv(readFileSync(resolve(process.cwd(), '.env'))) } catch { /* ignore */ }
  return {
    username: env.ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin',
    password: env.ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'admin',
  }
}

function tokenFor(username: string, password: string): string {
  return createHash('sha256').update(`${username}:${password}`).digest('hex')
}

// Returns a session token if credentials match, or null otherwise.
export function login(username: string, password: string): string | null {
  const creds = getCredentials()
  if (username !== creds.username || password !== creds.password) return null
  return tokenFor(creds.username, creds.password)
}

// Stateless check — valid as long as the token matches the current credentials.
export function verifyToken(token: string | undefined | null): boolean {
  if (!token) return false
  const creds = getCredentials()
  return token === tokenFor(creds.username, creds.password)
}
