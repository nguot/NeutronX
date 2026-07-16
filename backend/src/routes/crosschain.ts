import { Router } from 'express'
import {
  createIntent,
  setOrderSwapperSig,
  getCrossChainOrder,
  listOpenCCOrders,
  createFillQuote,
  setFillSwapperSig,
  getFillById,
  getTokenDirectory,
  getFillerFills,
} from '../services/crosschainService'
import { previewFill, rankFillersByOutputBalance } from '../services/preflightService'
import { fillerRegistry } from '../services/fillerRegistry'
import { getFillerSwapFills, getFillerRegistrations } from '../services/orderService'

const router = Router()

// GET /cc/tokens
// Token directory for the cross-chain swap UI's token-pill selectors.
router.get('/tokens', async (_req, res) => {
  try {
    const dir = await getTokenDirectory()
    return res.json(dir)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// POST /cc/orders  { swapper, inputToken, inputAmount, outputToken, minOutput,
//                    deadlineBase, nonce, feeTier, chainAId, dstChainId }
// Persists the swapper's INTENT only — no secret, no Merkle tree, no cosigner.
// Returns { orderHash }; the swapper signs it next (EIP-712) and PATCHes it to
// /cc/orders/:hash/swapperSig. Fillers can only quote against a signed intent.
router.post('/orders', async (req, res) => {
  try {
    const { swapper, inputToken, inputAmount, outputToken, minOutput,
            deadlineBase, nonce, feeTier, chainAId, dstChainId } = req.body

    if (!swapper || !inputToken || !inputAmount || !outputToken || !minOutput
        || !deadlineBase || !nonce || feeTier === undefined || !chainAId || !dstChainId) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const result = await createIntent({
      swapper: swapper.toLowerCase(),
      inputToken, inputAmount, outputToken, minOutput,
      deadlineBase: parseInt(deadlineBase),
      nonce: String(nonce),
      feeTier: parseInt(feeTier),
      chainAId: parseInt(chainAId),
      dstChainId: parseInt(dstChainId),
    })

    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// PATCH /cc/orders/:hash/swapperSig  { swapperSig }
// Swapper's wallet signs orderHash via EIP-712 (_signTypedData) once the
// intent is created. Required before any filler can quote a fill against it.
router.patch('/orders/:hash/swapperSig', async (req, res) => {
  try {
    const { swapperSig } = req.body
    if (!swapperSig) return res.status(400).json({ error: 'swapperSig required' })
    await setOrderSwapperSig(req.params.hash, swapperSig)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(400).json({ error: e.message })
  }
})

// GET /cc/orders
// Open/partial signed orders (for filler dev UI).
router.get('/orders', async (_req, res) => {
  try {
    const orders = await listOpenCCOrders()
    return res.json({ orders })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /cc/orders/:hash
// Full order state, including every fill and its status.
router.get('/orders/:hash', async (req, res) => {
  try {
    const order = await getCrossChainOrder(req.params.hash)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    return res.json(order)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// POST /cc/orders/:hash/fills  { filler, hashlock, fillAmount, t1, t2, rate }
// Filler proposes a quote for a chunk of the order — BEFORE funding anything.
// Backend does not verify a hashlock/secret relationship (the filler holds the
// secret, not the backend) — only that the order is signed and t2 > t1.
router.post('/orders/:hash/fills', async (req, res) => {
  try {
    const { filler, hashlock, fillAmount, t1, t2, rate } = req.body
    if (!filler || !hashlock || !fillAmount || !t1 || !t2) {
      return res.status(400).json({ error: 'Missing required fields' })
    }
    const result = await createFillQuote(req.params.hash, {
      filler, hashlock, fillAmount: String(fillAmount),
      t1: parseInt(t1), t2: parseInt(t2), rate: rate ? String(rate) : undefined,
    })
    return res.json(result)
  } catch (e: any) {
    return res.status(400).json({ error: e.message })
  }
})

// GET /cc/fills/:id
// Poll a single fill's status (quoted → dst_funded → authorized → src_locked
// → revealed → claimed, or aborted/slashed).
router.get('/fills/:id', async (req, res) => {
  try {
    const fill = await getFillById(parseInt(req.params.id))
    if (!fill) return res.status(404).json({ error: 'Fill not found' })
    return res.json(fill)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// PATCH /cc/fills/:id/swapperSig  { swapperSig, t1? }
// Swapper's per-fill authorization (FillAuth), signed AFTER verifying the
// filler's dest escrow (client-side, or via this same fill's status — the
// backend only accepts this once its OWN watcher has independently confirmed
// the dest escrow is genuine and marked the fill 'dst_funded'; see
// crosschainService.setFillSwapperSig). Optional `t1` lets the swapper revise
// the filler's proposed source-escrow deadline before countersigning.
router.patch('/fills/:id/swapperSig', async (req, res) => {
  try {
    const { swapperSig, t1 } = req.body
    if (!swapperSig) return res.status(400).json({ error: 'swapperSig required' })
    await setFillSwapperSig(parseInt(req.params.id), swapperSig, t1 !== undefined ? parseInt(t1) : undefined)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(400).json({ error: e.message })
  }
})

// GET /cc/fillers
// Public registry of fillers (name, address, chains) plus each filler's
// historical fills — both cross-chain (cc_fills) and single-chain Dutch-
// auction fills (fills/orders). Powers the "Fillers" page.
router.get('/fillers', async (_req, res) => {
  try {
    const list = await fillerRegistry.list()
    const fillers = await Promise.all(list.map(async f => ({
      name:     f.name,
      address:  f.address,
      chains:   f.chains,
      fills:    f.address ? await getFillerFills(f.address) : [],
      swapFills: f.address ? await getFillerSwapFills(f.address) : [],
      registrations: f.address ? await getFillerRegistrations(f.address) : [],
    })))
    return res.json({ fillers })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /cc/orders/:hash/fillers
// Registered fillers (with a known address operating on this order's dst
// chain) ranked by their current balance of the output token — suggests
// which filler to try first on the Simulate page.
router.get('/orders/:hash/fillers', async (req, res) => {
  try {
    const result = await rankFillersByOutputBalance(req.params.hash)
    if (!result) return res.status(404).json({ error: 'Order not found' })
    return res.json({ fillers: result })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /cc/fills/:id/preflight?filler=0x...
// Dry-runs EscrowSrcFactory.fillSlot() for an already-AUTHORIZED fill (both
// signatures already recorded) without sending a transaction — catches
// timing/balance/allowance issues with the real revert reason. Only
// meaningful once the fill has both signatures; earlier states have nothing
// concrete to dry-run yet (Model 2 requires the swapper's live participation
// before a real fillSlot call is even constructible).
router.get('/fills/:id/preflight', async (req, res) => {
  try {
    const filler = req.query.filler as string
    if (!filler || !/^0x[0-9a-fA-F]{40}$/.test(filler)) {
      return res.status(400).json({ error: 'filler query param (address) required' })
    }
    const result = await previewFill(parseInt(req.params.id), filler)
    if (!result) return res.status(404).json({ error: 'Fill not found' })
    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

export default router
