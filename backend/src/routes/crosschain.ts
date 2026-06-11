import { Router } from 'express'
import {
  getOrCreateSession,
  getSessionWithOrders,
  createCrossChainOrder,
  setSwapperSig,
  getCrossChainOrder,
  listOpenCCOrders,
  markSlotDone,
  updateSlotFiller,
  resetSlotToAvailable,
  getTokenDirectory,
} from '../services/crosschainService'

const router = Router()

// GET /cc/tokens
// Token directory for the cross-chain swap UI's token-pill selectors:
// input tokens live on Chain A, output tokens on Chain B.
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
//                    deadline, nonce, chainAId, reactorAddr, t2Buffer }
// Build Merkle tree, cosign, persist. Returns { orderHash, merkleRoot, numSlots,
// cosignerSig } — the swapper signs orderHash (EIP-712) next and PATCHes it to
// /cc/orders/:hash/swapperSig. No on-chain tx from the swapper: EscrowSrcFactory
// registers the order lazily on the first fillSlot() call by a filler.
router.post('/orders', async (req, res) => {
  try {
    const { swapper, inputToken, inputAmount, outputToken, minOutput,
            deadline, nonce, chainAId, reactorAddr, t2Buffer } = req.body

    if (!swapper || !inputToken || !inputAmount || !outputToken || !minOutput
        || !deadline || !nonce || !chainAId || !reactorAddr) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const result = await createCrossChainOrder({
      swapper: swapper.toLowerCase(),
      inputToken, inputAmount, outputToken, minOutput,
      deadline: parseInt(deadline),
      nonce: String(nonce),
      chainAId: parseInt(chainAId),
      reactorAddr,
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

// PATCH /cc/orders/:hash/slots/:index/filler  { filler: "0x..." }
// Filler records itself as the registered filler so the UI can grey-out
// "Claim WETH" buttons on the other filler's UI.
router.patch('/orders/:hash/slots/:index/filler', async (req, res) => {
  try {
    const { filler } = req.body
    if (!filler) return res.status(400).json({ error: 'filler required' })
    await updateSlotFiller(req.params.hash, parseInt(req.params.index), filler)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// PATCH /cc/orders/:hash/slots/:index/reset
// Resets a stuck 'claimed' slot back to 'available' when Chain B was restarted
// and the original escrow no longer exists on the current Chain B instance.
router.patch('/orders/:hash/slots/:index/reset', async (req, res) => {
  try {
    await resetSlotToAvailable(req.params.hash, parseInt(req.params.index))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

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

export default router
