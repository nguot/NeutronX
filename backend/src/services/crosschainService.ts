import { ethers } from 'ethers'
import { db } from '../db/client'
import { listTokens } from './tokenService'
import { chainIds, getChain } from '../config/chains'

// ─────────────────────────────────────────────────────────────────────────────
// Model 2 (filler-holds-key, continuous fill). Backend is a RELAY + STATUS
// BOARD ONLY — it never generates or holds a secret, never signs an order
// (no cosigner), and never derives a Merkle tree. See
// CROSSCHAIN_INTENT_REDESIGN_HUONG_PHAT_TRIEN.md §6 for the full spec this
// schema/state-machine implements.
//
// State machine (one row per filler fill, cc_fills.status):
//   quoted ─(watcher sees EscrowCreated, verifies genuine)→ dst_funded
//          ─(swapper verifies + signs FillAuth)→ authorized
//          ─(watcher sees Filled event, verifies genuine)→ src_locked
//          ─(watcher sees Withdrawn event on the escrow)→ revealed (secret filled in)
//          ─(relayer calls EscrowDst.claim)→ claimed ✓
//   dead ends: aborted (quoted/dst_funded never progresses — swapper never signs
//              or filler never locks source) | slashed (griefed — bond forfeited,
//              observed via EscrowSrc.cancel()'s Cancelled event)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Init DB tables (called once at startup) ──────────────────────────────────
export async function initCrossChainSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_orders (
      order_hash    VARCHAR(66) PRIMARY KEY,
      swapper       VARCHAR(42) NOT NULL,
      input_token   VARCHAR(42) NOT NULL,
      input_amount  VARCHAR(78) NOT NULL,
      output_token  VARCHAR(42) NOT NULL,
      min_output    VARCHAR(78) NOT NULL,
      deadline_base BIGINT NOT NULL,   -- unix timestamp (T1 ceiling) — NOT a block number
      nonce         VARCHAR(78) NOT NULL,
      fee_tier      INTEGER NOT NULL,
      swapper_sig   TEXT,              -- NULL until swapper signs the order intent
      reactor_addr  VARCHAR(42) NOT NULL,  -- EscrowSrcFactory address (EIP-712 domain)
      chain_a_id    INTEGER NOT NULL,
      dst_chain_id  INTEGER NOT NULL,
      status        VARCHAR(20) NOT NULL DEFAULT 'open', -- open|partial|filled|expired|cancelled
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_fills (
      fill_id         SERIAL PRIMARY KEY,
      order_hash      VARCHAR(66) NOT NULL REFERENCES cc_orders(order_hash),
      filler          VARCHAR(42) NOT NULL,
      fill_amount     VARCHAR(78) NOT NULL,
      hashlock        VARCHAR(66) NOT NULL,
      t1              BIGINT NOT NULL,
      t2              BIGINT NOT NULL,
      rate            VARCHAR(78),           -- filler's quoted rate — informational only, not enforced on-chain
      bond_amount     VARCHAR(78),           -- filled in once observed from the Filled event
      escrow_src_addr VARCHAR(42),
      escrow_dst_addr VARCHAR(42),
      swapper_sig     TEXT,                  -- per-fill authorization; NULL until swapper signs
      secret          VARCHAR(66),           -- NULL until filler reveals on-chain (Withdrawn event)
      status          VARCHAR(20) NOT NULL DEFAULT 'quoted',
                      -- quoted|dst_funded|authorized|src_locked|revealed|claimed|aborted|slashed
      dst_funded_tx   VARCHAR(66),
      src_locked_tx   VARCHAR(66),
      reveal_tx       VARCHAR(66),
      claim_tx        VARCHAR(66),
      quoted_at       TIMESTAMP DEFAULT NOW(),
      dst_funded_at   TIMESTAMP,
      authorized_at   TIMESTAMP,
      src_locked_at   TIMESTAMP,
      revealed_at     TIMESTAMP,
      claimed_at      TIMESTAMP,
      UNIQUE (order_hash, hashlock)
    )
  `)
}

// ─── Token directory ───────────────────────────────────────────────────────────
// Backs the token-pill selectors in the cross-chain swap UI. Reads the unified
// `tokens` table (seeded by tokenService), one entry per chain in the registry.

export interface CCTokenInfo { symbol: string; address: string; decimals: number; chainId: number; name?: string }

export async function getTokenDirectory(): Promise<Record<number, CCTokenInfo[]>> {
  const strip = (t: { symbol: string; address: string; decimals: number; chainId: number; name?: string }): CCTokenInfo =>
    ({ symbol: t.symbol, address: t.address, decimals: t.decimals, chainId: t.chainId, name: t.name })
  const entries = await Promise.all(
    chainIds().map(async id => [id, (await listTokens(id)).map(strip)] as const)
  )
  return Object.fromEntries(entries)
}

// ─── EIP-712 (mirrors EscrowSrcFactory.sol exactly — ORDER_TYPE_HASH/FILL_TYPE_HASH) ──

const ORDER_TYPE_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(
  'CrossChainOrder(' +
  'address swapper,address inputToken,uint256 inputAmount,' +
  'address outputToken,uint256 minOutput,' +
  'uint256 deadlineBase,uint256 nonce,uint24 feeTier)'
))

const FILL_TYPE_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(
  'CrossChainFill(' +
  'bytes32 orderHash,bytes32 hashlock,uint256 fillAmount,uint256 t1,uint256 t2)'
))

function computeDomainSeparator(chainId: number, reactorAddr: string): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address'],
      [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)')),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes('NeutronX CrossChain')),
        chainId,
        reactorAddr,
      ]
    )
  )
}

interface OrderFields {
  swapper: string; inputToken: string; inputAmount: string
  outputToken: string; minOutput: string
  deadlineBase: number; nonce: string; feeTier: number
}

function hashOrder(p: OrderFields): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint24'],
      [ORDER_TYPE_HASH, p.swapper, p.inputToken, p.inputAmount, p.outputToken, p.minOutput, p.deadlineBase, p.nonce, p.feeTier]
    )
  )
}

interface FillFields {
  orderHash: string; hashlock: string; fillAmount: string; t1: number; t2: number
}

function hashFill(p: FillFields): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256'],
      [FILL_TYPE_HASH, p.orderHash, p.hashlock, p.fillAmount, p.t1, p.t2]
    )
  )
}

function digestFor(domainSeparator: string, structHash: string): string {
  return ethers.utils.keccak256(
    ethers.utils.solidityPack(['string', 'bytes32', 'bytes32'], ['\x19\x01', domainSeparator, structHash])
  )
}

// ─── Relayer wallet (gas-paying only — no on-chain trust check, EscrowDst.claim
//     is permissionless) ────────────────────────────────────────────────────────
export function getRelayerWallet(provider?: ethers.providers.Provider): ethers.Wallet {
  const pk = process.env.RELAYER_PRIVATE_KEY
  if (!pk) throw new Error('RELAYER_PRIVATE_KEY not set — needed to fund EscrowDst.claim() relay transactions')
  return provider ? new ethers.Wallet(pk, provider) : new ethers.Wallet(pk)
}

// ─── Orders (intent) ──────────────────────────────────────────────────────────

export interface CreateIntentParams {
  swapper:      string
  inputToken:   string
  inputAmount:  string
  outputToken:  string
  minOutput:    string
  deadlineBase: number
  nonce:        string
  feeTier:      number
  chainAId:     number
  dstChainId:   number
}

export async function createIntent(p: CreateIntentParams): Promise<{ orderHash: string }> {
  const ids = chainIds()
  if (!ids.includes(p.chainAId))   throw new Error(`Unknown source chain ${p.chainAId}`)
  if (!ids.includes(p.dstChainId)) throw new Error(`Unknown destination chain ${p.dstChainId}`)
  if (p.chainAId === p.dstChainId) throw new Error('Source and destination chains must differ')
  if (!Number.isInteger(p.deadlineBase) || p.deadlineBase <= Math.floor(Date.now() / 1000)) {
    throw new Error('deadlineBase must be a future unix timestamp')
  }

  const reactorAddr = getChain(p.chainAId).escrowSrcFactory
  const orderHash = hashOrder({
    swapper: p.swapper, inputToken: p.inputToken, inputAmount: p.inputAmount,
    outputToken: p.outputToken, minOutput: p.minOutput,
    deadlineBase: p.deadlineBase, nonce: p.nonce, feeTier: p.feeTier,
  })

  await db.query(`
    INSERT INTO cc_orders
      (order_hash, swapper, input_token, input_amount, output_token, min_output,
       deadline_base, nonce, fee_tier, reactor_addr, chain_a_id, dst_chain_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (order_hash) DO NOTHING
  `, [orderHash, p.swapper, p.inputToken, p.inputAmount, p.outputToken, p.minOutput,
      p.deadlineBase, p.nonce, p.feeTier, reactorAddr, p.chainAId, p.dstChainId])

  return { orderHash }
}

// Swapper's wallet signs orderHash (EIP-712, _signTypedData) once the intent is
// created. EscrowSrcFactory.fillSlot() verifies this alongside the per-fill sig.
export async function setOrderSwapperSig(orderHash: string, swapperSig: string): Promise<void> {
  const o = await db.query(
    'SELECT swapper, reactor_addr, chain_a_id FROM cc_orders WHERE order_hash = $1', [orderHash]
  )
  if (!o.rows.length) throw new Error('Order not found')
  const { swapper, reactor_addr, chain_a_id } = o.rows[0]

  const digest = digestFor(computeDomainSeparator(chain_a_id, reactor_addr), orderHash)
  const recovered = ethers.utils.recoverAddress(digest, swapperSig)
  if (recovered.toLowerCase() !== swapper.toLowerCase()) {
    throw new Error('swapperSig does not match order.swapper')
  }

  await db.query('UPDATE cc_orders SET swapper_sig = $1 WHERE order_hash = $2', [swapperSig, orderHash])
}

// ─── Fills (per-filler quotes) ────────────────────────────────────────────────

export interface CreateFillParams {
  filler:     string
  hashlock:   string
  fillAmount: string
  t1:         number
  t2:         number
  rate?:      string
}

export async function createFillQuote(orderHash: string, p: CreateFillParams): Promise<{ fillId: number }> {
  const o = await db.query('SELECT swapper_sig, deadline_base FROM cc_orders WHERE order_hash = $1', [orderHash])
  if (!o.rows.length) throw new Error('Order not found')
  if (!o.rows[0].swapper_sig) throw new Error('Order intent not yet signed by swapper — cannot quote a fill against it')

  if (p.t2 <= p.t1) throw new Error('t2 must exceed t1 (dest closes after source)')
  if (p.t1 > Number(o.rows[0].deadline_base)) throw new Error('t1 beyond the order\'s deadlineBase')

  const r = await db.query(`
    INSERT INTO cc_fills (order_hash, filler, fill_amount, hashlock, t1, t2, rate)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING fill_id
  `, [orderHash, p.filler.toLowerCase(), p.fillAmount, p.hashlock, p.t1, p.t2, p.rate ?? null])

  return { fillId: r.rows[0].fill_id }
}

// Swapper's per-fill authorization — signed AFTER verifying the filler's dest
// escrow is genuine (Điểm A). Only accepted once the watcher has already
// marked this fill 'dst_funded' (i.e. it independently confirmed the escrow is
// a genuine CREATE2 clone with the right recipient/token/amount/expiry) — the
// backend never takes the filler's word for "I funded it" on trust.
// `newT1` lets the swapper SHORTEN (never extend) the filler's proposed T1 at
// sign time. Extending it would undo the security property that makes T1
// short in the first place — a short T1 is what forces the filler to reveal
// early instead of sitting on a locked source escrow deciding whether the
// trade is still profitable (doc §3-4, "late-reveal double-dip"). Letting the
// swapper only tighten it is safe: T2 (the already-deployed EscrowDst's real
// on-chain expiry) is untouched, and a smaller T1 only makes the filler's
// window stricter, never looser.
export async function setFillSwapperSig(fillId: number, swapperSig: string, newT1?: number): Promise<void> {
  const f = await db.query(`
    SELECT f.order_hash, f.hashlock, f.fill_amount, f.t1, f.t2, f.status,
           o.swapper, o.reactor_addr, o.chain_a_id
    FROM cc_fills f JOIN cc_orders o ON o.order_hash = f.order_hash
    WHERE f.fill_id = $1
  `, [fillId])
  if (!f.rows.length) throw new Error('Fill not found')
  const row = f.rows[0]

  if (row.status !== 'dst_funded') {
    throw new Error(`Fill is '${row.status}' — dest escrow must be verified (watcher-confirmed 'dst_funded') before signing`)
  }

  let t1 = Number(row.t1)
  if (newT1 !== undefined && newT1 !== t1) {
    if (!Number.isInteger(newT1)) throw new Error('t1 must be an integer unix timestamp')
    if (newT1 <= Math.floor(Date.now() / 1000)) throw new Error('t1 must be in the future')
    if (newT1 > t1) throw new Error('t1 can only be shortened, not extended past the filler\'s proposed value')
    t1 = newT1
  }

  const structHash = hashFill({
    orderHash: row.order_hash, hashlock: row.hashlock,
    fillAmount: row.fill_amount, t1, t2: row.t2,
  })
  const digest = digestFor(computeDomainSeparator(row.chain_a_id, row.reactor_addr), structHash)
  const recovered = ethers.utils.recoverAddress(digest, swapperSig)
  if (recovered.toLowerCase() !== row.swapper.toLowerCase()) {
    throw new Error('swapperSig does not match order.swapper')
  }

  await db.query(
    "UPDATE cc_fills SET swapper_sig = $1, t1 = $2, status = 'authorized', authorized_at = NOW() WHERE fill_id = $3",
    [swapperSig, t1, fillId]
  )
}

// ─── Watcher-derived transitions (on-chain truth, never client-writable) ─────

// escrowDstWatcher calls this once it has independently verified (via
// escrowAuthenticity.assertGenuineDstClone) that a genuine EscrowDst clone
// exists for this fill's hashlock, matching the quoted amount/recipient/token/expiry.
export async function recordDstFunded(orderHash: string, hashlock: string, escrowDstAddr: string, txHash: string): Promise<void> {
  await db.query(`
    UPDATE cc_fills SET escrow_dst_addr = $1, dst_funded_tx = $2, status = 'dst_funded', dst_funded_at = NOW()
    WHERE order_hash = $3 AND hashlock = $4 AND status = 'quoted'
  `, [escrowDstAddr, txHash, orderHash, hashlock])
}

// escrowSrcWatcher calls this after seeing a genuine Filled event (verified via
// assertGenuineSrcClone) — the filler must already hold a valid swapperSig for
// this to have succeeded on-chain, so this only ever advances an 'authorized' fill.
export async function recordSrcLocked(
  orderHash: string, hashlock: string, escrowSrcAddr: string, filler: string, txHash: string
): Promise<void> {
  await db.query(`
    UPDATE cc_fills SET escrow_src_addr = $1, src_locked_tx = $2, status = 'src_locked', src_locked_at = NOW()
    WHERE order_hash = $3 AND hashlock = $4 AND status = 'authorized' AND LOWER(filler) = LOWER($5)
  `, [escrowSrcAddr, txHash, orderHash, hashlock, filler])
}

// escrowSrcWatcher calls this after seeing EscrowSrc's Withdrawn(filler, secret)
// event — the secret is now public on the source chain; the relayer reads it
// from HERE (not by deriving it) to claim on the dest chain.
export async function recordReveal(orderHash: string, hashlock: string, secret: string, txHash: string): Promise<void> {
  await db.query(`
    UPDATE cc_fills SET secret = $1, reveal_tx = $2, status = 'revealed', revealed_at = NOW()
    WHERE order_hash = $3 AND hashlock = $4 AND status = 'src_locked'
  `, [secret, txHash, orderHash, hashlock])
}

// escrowDstWatcher (acting as relayer) calls this after successfully sending
// EscrowDst.claim(secret).
export async function recordClaimed(orderHash: string, hashlock: string, txHash: string): Promise<void> {
  await db.query(`
    UPDATE cc_fills SET claim_tx = $1, status = 'claimed', claimed_at = NOW()
    WHERE order_hash = $2 AND hashlock = $3 AND status = 'revealed'
  `, [txHash, orderHash, hashlock])
}

// A fill's EscrowSrc was cancelled (griefed — filler never revealed before T1).
// Anyone can call cancel() on-chain; the watcher observes it and marks the row
// so it stops being treated as in-flight.
export async function recordSlashed(orderHash: string, hashlock: string): Promise<void> {
  await db.query(`
    UPDATE cc_fills SET status = 'slashed'
    WHERE order_hash = $1 AND hashlock = $2 AND status IN ('authorized', 'src_locked')
  `, [orderHash, hashlock])
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function mapFillRow(s: any) {
  return {
    fillId:        s.fill_id,
    filler:        s.filler,
    fillAmount:    s.fill_amount,
    hashlock:      s.hashlock,
    t1:            s.t1,
    t2:            s.t2,
    rate:          s.rate,
    bondAmount:    s.bond_amount,
    escrowSrcAddr: s.escrow_src_addr,
    escrowDstAddr: s.escrow_dst_addr,
    // A signature is meant to be used by the filler to construct the on-chain
    // call — unlike a secret, hiding it serves no security purpose, so it's
    // returned raw (NULL until the swapper signs).
    swapperSig:    s.swapper_sig,
    secret:        s.secret,
    status:        s.status,
  }
}

export async function getCrossChainOrder(orderHash: string) {
  const o = await db.query('SELECT * FROM cc_orders WHERE order_hash = $1', [orderHash])
  if (!o.rows.length) return null
  const fills = await db.query('SELECT * FROM cc_fills WHERE order_hash = $1 ORDER BY fill_id', [orderHash])
  const row = o.rows[0]
  return {
    orderHash:    row.order_hash,
    swapper:      row.swapper,
    inputToken:   row.input_token,
    inputAmount:  row.input_amount,
    outputToken:  row.output_token,
    minOutput:    row.min_output,
    deadlineBase: Number(row.deadline_base),
    nonce:        row.nonce,
    feeTier:      row.fee_tier,
    swapperSig:   row.swapper_sig,
    reactorAddr:  row.reactor_addr,
    chainAId:     row.chain_a_id,
    dstChainId:   row.dst_chain_id,
    status:       row.status,
    fills:        fills.rows.map(mapFillRow),
  }
}

export async function getFillById(fillId: number) {
  const f = await db.query(`
    SELECT f.*, o.swapper, o.input_token, o.input_amount, o.output_token, o.min_output,
           o.deadline_base, o.nonce, o.fee_tier, o.reactor_addr, o.chain_a_id, o.dst_chain_id,
           o.swapper_sig AS order_swapper_sig
    FROM cc_fills f JOIN cc_orders o ON o.order_hash = f.order_hash
    WHERE f.fill_id = $1
  `, [fillId])
  if (!f.rows.length) return null
  const row = f.rows[0]
  return {
    ...mapFillRow(row),
    orderHash: row.order_hash,
    order: {
      swapper: row.swapper, inputToken: row.input_token, inputAmount: row.input_amount,
      outputToken: row.output_token, minOutput: row.min_output,
      deadlineBase: Number(row.deadline_base), nonce: row.nonce, feeTier: row.fee_tier,
      reactorAddr: row.reactor_addr, chainAId: row.chain_a_id, dstChainId: row.dst_chain_id,
      swapperSig: row.order_swapper_sig,
    },
  }
}

// List all CC orders that still look open (for filler dev UI)
export async function listOpenCCOrders() {
  const r = await db.query(`
    SELECT order_hash, swapper, input_token, input_amount, output_token, min_output,
           deadline_base, fee_tier, chain_a_id, dst_chain_id, status
    FROM cc_orders
    WHERE status IN ('open', 'partial') AND swapper_sig IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 20
  `)
  const result = []
  for (const row of r.rows) {
    const fills = await db.query(
      'SELECT fill_id, filler, fill_amount, hashlock, status FROM cc_fills WHERE order_hash = $1 ORDER BY fill_id',
      [row.order_hash]
    )
    result.push({
      orderHash:    row.order_hash,
      swapper:      row.swapper,
      inputToken:   row.input_token,
      inputAmount:  row.input_amount,
      outputToken:  row.output_token,
      minOutput:    row.min_output,
      deadlineBase: Number(row.deadline_base),
      feeTier:      row.fee_tier,
      chainAId:     row.chain_a_id,
      dstChainId:   row.dst_chain_id,
      fills: fills.rows.map(s => ({
        fillId: s.fill_id, filler: s.filler, fillAmount: s.fill_amount,
        hashlock: s.hashlock, status: s.status,
      })),
    })
  }
  return result
}

// All fills ever assigned to `address` (any chain, any status) — for the
// Fillers page's "past fills" table.
export async function getFillerFills(address: string) {
  const r = await db.query(`
    SELECT f.fill_id, f.hashlock, f.fill_amount, f.status, f.escrow_src_addr, f.escrow_dst_addr,
           o.chain_a_id, o.dst_chain_id, o.output_token, o.created_at
    FROM cc_fills f
    JOIN cc_orders o ON o.order_hash = f.order_hash
    WHERE LOWER(f.filler) = LOWER($1)
    ORDER BY o.created_at DESC
  `, [address])
  return r.rows.map(row => ({
    fillId:      row.fill_id,
    hashlock:    row.hashlock,
    status:      row.status,
    escrowSrcAddr: row.escrow_src_addr,
    escrowDstAddr: row.escrow_dst_addr,
    chainAId:    row.chain_a_id,
    dstChainId:  row.dst_chain_id,
    outputToken: row.output_token,
    amount:      row.fill_amount,
    createdAt:   row.created_at,
  }))
}
