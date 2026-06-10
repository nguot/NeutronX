import { Router, Request, Response } from 'express'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { parse as parseEnv } from 'dotenv'
import { fillerRegistry } from '../services/fillerRegistry'

const router = Router()

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
    partialFillReactor: get('PARTIAL_FILL_REACTOR'),
    crossChainReactor:  get('CROSS_CHAIN_REACTOR'),
    chainBFactory:      get('CHAIN_B_FACTORY'),
    chainBRpc:          get('CHAIN_B_RPC'),
    chainARpc:          get('RPC_URL', 'http://127.0.0.1:8545'),
    chainId:            get('CHAIN_ID', '31337'),
  })
})

router.post('/config', (req: Request, res: Response) => {
  const map: Record<string, string> = {
    partialFillReactor: 'PARTIAL_FILL_REACTOR',
    crossChainReactor:  'CROSS_CHAIN_REACTOR',
    chainBFactory:      'CHAIN_B_FACTORY',
    chainBRpc:          'CHAIN_B_RPC',
    chainARpc:          'RPC_URL',
    chainId:            'CHAIN_ID',
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
  const list = fillerRegistry.list()
  const pings = await Promise.allSettled(list.map(f => pingFiller(f.url)))
  const fillers = list.map((f, i) => ({
    name:    f.name,
    url:     f.url,
    ...(pings[i].status === 'fulfilled' ? pings[i].value : { alive: false, latencyMs: 0, error: 'unknown' }),
  }))
  res.json({ fillers })
})

router.post('/fillers', (req: Request, res: Response) => {
  const { name, url } = req.body
  if (!name || !url) { res.status(400).json({ error: 'name and url required' }); return }
  try {
    fillerRegistry.add(name, url)
    res.status(201).json({ ok: true })
  } catch (e: any) { res.status(400).json({ error: e.message }) }
})

router.delete('/fillers/:name', (req: Request, res: Response) => {
  try {
    fillerRegistry.remove(req.params['name'])
    res.json({ ok: true })
  } catch (e: any) { res.status(404).json({ error: e.message }) }
})

// ── Block mining ───────────────────────────────────────────────────────────
router.post('/mine', async (req: Request, res: Response) => {
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

// GET current block numbers for both chains
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
  const chainARpc = process.env.RPC_URL        || 'http://127.0.0.1:8545'
  const chainBRpc = process.env.CHAIN_B_RPC    || 'http://127.0.0.1:8546'
  const [a, b] = await Promise.allSettled([getBlock(chainARpc), getBlock(chainBRpc)])
  res.json({
    chainA: a.status === 'fulfilled' ? a.value : null,
    chainB: b.status === 'fulfilled' ? b.value : null,
  })
})

export default router
