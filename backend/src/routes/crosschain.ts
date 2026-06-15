import { Router } from 'express'
import {
  getOrCreateSession,
  getSessionWithOrders,
  createCrossChainOrder,
  setSwapperSig,
  getCrossChainOrder,
  listOpenCCOrders,
  markSlotDone,
  getTokenDirectory,
  getFillerFills,
} from '../services/crosschainService'
import { preflightFillSlot, rankFillersByOutputBalance } from '../services/preflightService'
import { fillerRegistry } from '../services/fillerRegistry'
import { getFillerSwapFills } from '../services/orderService'

const router = Router()

// GET /cc/tokens
// Token directory for the cross-chain swap UI's token-pill selectors:
// a map of chainId -> tokens available on that chain.
router.get('/tokens', async (_req, res) => {
  try {
    const dir = await getTokenDirectory()
    return res.json(dir)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// POST /cc/session  { swapper }
// Create or restore a session for a swapper. Returns cosigner address.
// The backend generates the root secret — no sensitive data needed from the frontend.
router.post('/session', async (req, res) => {
  try {
    const { swapper } = req.body
    if (!swapper) return res.status(400).json({ error: 'swapper required' })
    const session = await getOrCreateSession(swapper.toLowerCase())
    return res.json(session)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /cc/session/:swapper
// Restore full session — returns cosigner address + all orders with slot statuses.
router.get('/session/:swapper', async (req, res) => {
  try {
    const data = await getSessionWithOrders(req.params.swapper.toLowerCase())
    if (!data) return res.status(404).json({ error: 'Session not found' })
    return res.json(data)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// POST /cc/orders  { swapper, inputToken, inputAmount, outputToken, minOutput,
//                    deadline, nonce, chainAId, dstChainId, t2Buffer }
// Build Merkle tree, cosign, persist. Returns { orderHash, merkleRoot, numSlots,
// cosignerSig } — the swapper signs orderHash (EIP-712) next and PATCHes it to
// /cc/orders/:hash/swapperSig. No on-chain tx from the swapper: EscrowSrcFactory
// registers the order lazily on the first fillSlot() call by a filler.
router.post('/orders', async (req, res) => {
  try {
    const { swapper, inputToken, inputAmount, outputToken, minOutput,
            deadline, nonce, chainAId, dstChainId, t2Buffer } = req.body

    if (!swapper || !inputToken || !inputAmount || !outputToken || !minOutput
        || !deadline || !nonce || !chainAId || !dstChainId) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const result = await createCrossChainOrder({
      swapper: swapper.toLowerCase(),
      inputToken, inputAmount, outputToken, minOutput,
      deadline: parseInt(deadline),
      nonce: String(nonce),
      chainAId: parseInt(chainAId),
      dstChainId: parseInt(dstChainId),
      t2Buffer: parseInt(t2Buffer ?? '50'),
    })

    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /cc/orders
// Returns all CC orders that have at least one available slot (for filler dev UI).
router.get('/orders', async (req, res) => {
  try {
    const orders = await listOpenCCOrders()
    return res.json({ orders })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// PATCH /cc/orders/:hash/swapperSig  { swapperSig }
// Swapper's wallet signs orderHash via EIP-712 (_signTypedData) after order
// creation. Required by EscrowSrcFactory.fillSlot() alongside cosignerSig.
router.patch('/orders/:hash/swapperSig', async (req, res) => {
  try {
    const { swapperSig } = req.body
    if (!swapperSig) return res.status(400).json({ error: 'swapperSig required' })
    await setSwapperSig(req.params.hash, swapperSig)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(400).json({ error: e.message })
  }
})

// Trufy 3.8: the public PATCH /orders/:hash/slots/:index/filler endpoint was
// REMOVED. `assigned_filler` is settlement-critical — escrowDstWatcher refuses
// to reveal the secret unless the destination escrow's funder matches it — so it
// must never be writable from an unauthenticated API. It is now written ONLY by
// escrowSrcWatcher.handleSlotFilled() from the on-chain SlotFilled event
// (msg.sender of fillSlot), i.e. watcher-derived on-chain truth, not mutable API
// state. No client (frontend / CoWFiller / WhaleFiller) ever called this route.
//
// The public PATCH /orders/:hash/slots/:index/reset endpoint was also REMOVED
// for the same reason: it nulled `assigned_filler` + reset `status` with no auth,
// a desync/DoS vector on in-flight slots. It only ever served local Chain-B
// restarts; recovery is now simply to create a new order (the stale order keeps
// no available slots, so it stays inert and never re-appears as open).

// PATCH /cc/orders/:hash/slots/:index/done
// Filler calls this after successfully calling claimSlot() on Chain A so the
// DB transitions from 'claimed' → 'done' and the UI stops showing "Claim WETH".
router.patch('/orders/:hash/slots/:index/done', async (req, res) => {
  try {
    await markSlotDone(req.params.hash, parseInt(req.params.index))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /cc/orders/:hash
// Returns order state with slot statuses and proofs (for claimSlot() calls).
router.get('/orders/:hash', async (req, res) => {
  try {
    const order = await getCrossChainOrder(req.params.hash)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    return res.json(order)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /cc/fillers
// Public registry of fillers (name, address, chains they operate on, set via
// the Admin → Fillers tab) plus each filler's historical fills — both
// cross-chain slot fills (cc_slots) and single-chain Dutch-auction fills
// (fills/orders). Powers the "Fillers" page — addresses are shown as plain
// text, no explorer links.
router.get('/fillers', async (_req, res) => {
  try {
    const list = await fillerRegistry.list()
    const fillers = await Promise.all(list.map(async f => ({
      name:     f.name,
      address:  f.address,
      chains:   f.chains,
      fills:    f.address ? await getFillerFills(f.address) : [],
      swapFills: f.address ? await getFillerSwapFills(f.address) : [],
    })))
    return res.json({ fillers })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /cc/orders/:hash/slots/:index/fillers
// Registered fillers (with a known address operating on this order's dst
// chain) ranked by their current balance of the slot's output token —
// suggests which filler to preflight first on the Simulate page.
router.get('/orders/:hash/slots/:index/fillers', async (req, res) => {
  try {
    const result = await rankFillersByOutputBalance(req.params.hash, parseInt(req.params.index))
    if (!result) return res.status(404).json({ error: 'Order not found' })
    return res.json({ fillers: result })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /cc/orders/:hash/slots/:index/preflight?filler=0x...
// Dry-runs ccFill()'s on-chain steps for `filler` without sending any
// transaction: callStatic's EscrowSrcFactory.fillSlot() on the src chain
// (catches signature/proof/expiry/balance issues with the real revert
// reason) and checks the dst-chain balances ccFill would need to fund the
// EscrowDst clone. Used by the Simulate page's "Cross-chain order" tab.
router.get('/orders/:hash/slots/:index/preflight', async (req, res) => {
  try {
    const filler = req.query.filler as string
    if (!filler || !/^0x[0-9a-fA-F]{40}$/.test(filler)) {
      return res.status(400).json({ error: 'filler query param (address) required' })
    }
    const result = await preflightFillSlot(req.params.hash, parseInt(req.params.index), filler)
    if (!result) return res.status(404).json({ error: 'Order not found' })
    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

export default router
