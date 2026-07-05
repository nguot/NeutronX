import { Router, Request, Response, NextFunction } from 'express'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { parse as parseEnv } from 'dotenv'
import { fillerRegistry } from '../services/fillerRegistry'
import { login, verifyToken } from '../services/adminAuth'
import { loadChainRegistry } from '../config/chains'

const router = Router()

// ── Auth ───────────────────────────────────────────────────────────────────
// POST /admin/login  { username, password }
// Checks credentials against backend/.env (ADMIN_USERNAME / ADMIN_PASSWORD)
// and returns a token to send back as the x-admin-token header.
router.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body ?? {}
  if (!username || !password) { res.status(400).json({ error: 'username and password required' }); return }
  const token = login(username, password)
  if (!token) { res.status(401).json({ error: 'Invalid credentials' }); return }
  res.json({ token })
})

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!verifyToken(req.header('x-admin-token'))) { res.status(401).json({ error: 'Unauthorized' }); return }
  next()
}

// ── Helpers ────────────────────────────────────────────────────────────────
function readEnvFile(): Record<string, string> {
  try { return parseEnv(readFileSync(resolve(process.cwd(), '.env'))) }
  catch { return {} }
}

function writeEnvFile(patch: Record<string, string>) {
  try {
    const env = readEnvFile()
    Object.assign(env, patch)
    writeFileSync(resolve(process.cwd(), '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'))
  } catch { /* best-effort */ }
}

async function pingFiller(url: string): Promise<{ alive: boolean; latencyMs: number; error?: string }> {
  const start = Date.now()
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
    return { alive: res.ok, latencyMs: Date.now() - start }
  } catch {
    try {
      await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) })
      return { alive: true, latencyMs: Date.now() - start }
    } catch (e: any) {
      return { alive: false, latencyMs: Date.now() - start, error: e.message }
    }
  }
}

// ── Config ─────────────────────────────────────────────────────────────────
router.get('/config', (_req: Request, res: Response) => {
  const env = readEnvFile()
  const get = (key: string, fallback = '') =>
    env[key] ?? process.env[key] ?? fallback
  res.json({
    chains:             loadChainRegistry(),
    partialFillReactor: get('PARTIAL_FILL_REACTOR'),
    fallbackExecutor:   get('FALLBACK_EXECUTOR'),
    fillAuction:        get('FILL_AUCTION'),
  })
})

router.post('/config', requireAdmin, (req: Request, res: Response) => {
  const map: Record<string, string> = {
    partialFillReactor: 'PARTIAL_FILL_REACTOR',
    fallbackExecutor:   'FALLBACK_EXECUTOR',
  }
  const patch: Record<string, string> = {}
  for (const [field, envKey] of Object.entries(map)) {
    if (req.body[field] !== undefined) {
      process.env[envKey] = req.body[field]
      patch[envKey] = req.body[field]
    }
  }
  writeEnvFile(patch)
  res.json({ ok: true })
})

// ── Fillers ────────────────────────────────────────────────────────────────
router.get('/fillers', async (_req: Request, res: Response) => {
  const list = await fillerRegistry.list()
  const pings = await Promise.allSettled(list.map(f => pingFiller(f.url)))
  const fillers = list.map((f, i) => ({
    name:    f.name,
    url:     f.url,
    address: f.address,
    chains:  f.chains,
    ...(pings[i].status === 'fulfilled' ? pings[i].value : { alive: false, latencyMs: 0, error: 'unknown' }),
  }))
  res.json({ fillers })
})

router.post('/fillers', requireAdmin, async (req: Request, res: Response) => {
  const { name, url, address, chains } = req.body
  if (!name || !url) { res.status(400).json({ error: 'name and url required' }); return }
  try {
    await fillerRegistry.add(name, url, address ?? '', Array.isArray(chains) ? chains : [])
    res.status(201).json({ ok: true })
  } catch (e: any) { res.status(400).json({ error: e.message }) }
})

// PATCH /admin/fillers/:name  { url?, address?, chains? }
// Updates an existing (possibly env-seeded) filler's address/chains/url —
// used by the Admin Fillers tab to record a filler's on-chain wallet address.
router.patch('/fillers/:name', requireAdmin, async (req: Request, res: Response) => {
  const { url, address, chains } = req.body
  try {
    await fillerRegistry.update(req.params['name'] as string, {
      ...(url !== undefined ? { url } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(chains !== undefined ? { chains: Array.isArray(chains) ? chains : [] } : {}),
    })
    res.json({ ok: true })
  } catch (e: any) { res.status(404).json({ error: e.message }) }
})

router.delete('/fillers/:name', requireAdmin, async (req: Request, res: Response) => {
  try {
    await fillerRegistry.remove(req.params['name'] as string)
    res.json({ ok: true })
  } catch (e: any) { res.status(404).json({ error: e.message }) }
})

// ── Block mining ───────────────────────────────────────────────────────────
router.post('/mine', requireAdmin, async (req: Request, res: Response) => {
  const blocks   = Math.max(1, parseInt(req.body.blocks   ?? '1'))
  const interval = Math.max(0, parseInt(req.body.interval ?? '0'))
  const rpcUrl   = process.env.RPC_URL || 'http://127.0.0.1:8545'
  try {
    const r = await fetch(rpcUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'anvil_mine',
        params: [`0x${blocks.toString(16)}`, `0x${interval.toString(16)}`],
      }),
    })
    const data = await r.json() as any
    if (data.error) throw new Error(data.error.message)
    res.json({ ok: true, blocks })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET current block numbers for every registry chain
router.get('/blocks', async (_req: Request, res: Response) => {
  async function getBlock(rpc: string) {
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(3000),
    })
    const d = await r.json() as any
    return parseInt(d.result, 16)
  }
  const chains = loadChainRegistry()
  const results = await Promise.allSettled(chains.map(c => getBlock(c.rpc)))
  const blocks: Record<string, number | null> = {}
  chains.forEach((c, i) => {
    const r = results[i]
    blocks[String(c.id)] = r.status === 'fulfilled' ? r.value : null
  })
  res.json({ blocks })
})

export default router
