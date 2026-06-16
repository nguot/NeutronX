import { ethers } from 'ethers'
import { db } from '../db/client'
import { listTokens } from './tokenService'
import { chainIds, getChain, otherChain } from '../config/chains'

// ─── Init DB tables (called once at startup) ──────────────────────────────────
export async function initCrossChainSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_sessions (
      swapper       VARCHAR(42) PRIMARY KEY,
      root_secret   VARCHAR(66) NOT NULL,   -- 0x + 64 hex bytes
      cosigner_addr VARCHAR(42) NOT NULL,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_orders (
      order_hash    VARCHAR(66) PRIMARY KEY,
      swapper       VARCHAR(42) NOT NULL,
      input_token   VARCHAR(42) NOT NULL,
      input_amount  VARCHAR(78) NOT NULL,
      output_token  VARCHAR(42) NOT NULL,
      min_output    VARCHAR(78) NOT NULL,
      deadline      INTEGER NOT NULL,
      nonce         VARCHAR(78) NOT NULL,
      num_slots     SMALLINT NOT NULL,
      merkle_root   VARCHAR(66) NOT NULL,
      cosigner_sig  TEXT NOT NULL,
      swapper_sig   TEXT,
      t2_expiry     INTEGER NOT NULL,
      reactor_addr  VARCHAR(42) NOT NULL,
      chain_a_id    INTEGER NOT NULL,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_slots (
      order_hash      VARCHAR(66) NOT NULL,
      slot_index      SMALLINT NOT NULL,
      hashlock        VARCHAR(66) NOT NULL,
      leaf            VARCHAR(66) NOT NULL,
      proof           TEXT NOT NULL,         -- JSON-serialised string[]
      status          VARCHAR(20) NOT NULL DEFAULT 'available',
      assigned_filler VARCHAR(42),
      escrow_addr     VARCHAR(42),           -- deployed EscrowDst clone address
      PRIMARY KEY (order_hash, slot_index)
    )
  `)
  // Migration: rename lock_id → escrow_addr for existing installs
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cc_slots' AND column_name = 'lock_id'
      ) THEN
        ALTER TABLE cc_slots RENAME COLUMN lock_id TO escrow_addr;
      END IF;
    END
    $$
  `)
  // Migration: add swapper_sig for existing installs
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cc_orders' AND column_name = 'swapper_sig'
      ) THEN
        ALTER TABLE cc_orders ADD COLUMN swapper_sig TEXT;
      END IF;
    END
    $$
  `)

  // Migration: add dst_chain_id (chain registry refactor) and backfill existing rows
  await db.query(`ALTER TABLE cc_orders ADD COLUMN IF NOT EXISTS dst_chain_id INTEGER`)
  const stale = await db.query('SELECT order_hash, chain_a_id FROM cc_orders WHERE dst_chain_id IS NULL')
  for (const row of stale.rows) {
    try {
      const dst = otherChain(row.chain_a_id).id
      await db.query('UPDATE cc_orders SET dst_chain_id = $1 WHERE order_hash = $2', [dst, row.order_hash])
    } catch { /* registry has >2 chains or chain_a_id unknown — leave NULL */ }
  }
  const remaining = await db.query('SELECT COUNT(*) FROM cc_orders WHERE dst_chain_id IS NULL')
  if (remaining.rows[0].count === '0') {
    await db.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cc_orders' AND column_name='dst_chain_id' AND is_nullable='YES')
        THEN ALTER TABLE cc_orders ALTER COLUMN dst_chain_id SET NOT NULL; END IF;
      END $$
    `)
  }
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

// ─── Crypto helpers (mirrors key_distributor/src/crypto/) ─────────────────────

// SlotLib.getNumSlots()'s thresholds are denominated in 18-decimal "ether"
// units. Normalize inputAmount to that scale first so a token with fewer
// decimals (e.g. 6-decimal USDC) doesn't always bottom out at the minimum
// bucket — 1,000,000 USDC now buckets the same as 1,000,000 WETH would.
function normalizeTo18(amount: bigint, decimals: number): bigint {
  if (decimals === 18) return amount
  if (decimals < 18)   return amount * 10n ** BigInt(18 - decimals)
  return amount / 10n ** BigInt(decimals - 18)
}

function getNumSlots(inputAmount: string, decimals: number): number {
  const amt = normalizeTo18(BigInt(inputAmount), decimals)
  if (amt <  500_000_000_000_000_000n)   return 4
  if (amt < 2_000_000_000_000_000_000n)  return 8
  if (amt < 10_000_000_000_000_000_000n) return 16
  if (amt < 50_000_000_000_000_000_000n) return 32
  return 64
}

function deriveMasterSecret(rootSecret: string, p: {
  swapper: string; inputToken: string; inputAmount: string
  outputToken: string; minOutput: string; deadline: number; nonce: string
}): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32','address','address','uint256','address','uint256','uint256','uint256'],
      [rootSecret, p.swapper, p.inputToken, p.inputAmount, p.outputToken, p.minOutput, p.deadline, p.nonce]
    )
  )
}

export function deriveSecret(rootSecret: string, orderParams: {
  swapper: string; inputToken: string; inputAmount: string
  outputToken: string; minOutput: string; deadline: number; nonce: string
}, slotIndex: number): string {
  const master = deriveMasterSecret(rootSecret, orderParams)
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['bytes32','uint8'], [master, slotIndex])
  )
}

function deriveHashlock(secret: string): string {
  return ethers.utils.keccak256(secret)
}

function computeLeaf(hashlock: string, slotIndex: number): string {
  const inner = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['bytes32','uint8'], [hashlock, slotIndex])
  )
  return ethers.utils.keccak256(inner)
}

function hashPair(a: string, b: string): string {
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
  return ethers.utils.keccak256(ethers.utils.concat([x, y]))
}

function buildTree(leaves: string[]): { root: string; layers: string[][] } {
  const layers: string[][] = [[...leaves]]
  let current = [...leaves]
  while (current.length > 1) {
    const next: string[] = []
    for (let i = 0; i < current.length; i += 2) next.push(hashPair(current[i], current[i+1]))
    layers.push(next)
    current = next
  }
  return { root: current[0], layers }
}

function getProof(layers: string[][], idx: number): string[] {
  const proof: string[] = []
  let i = idx
  for (let level = 0; level < layers.length - 1; level++) {
    proof.push(layers[level][i % 2 === 0 ? i + 1 : i - 1])
    i = Math.floor(i / 2)
  }
  return proof
}

// ─── Cosigner key (single, server-wide) ─────────────────────────────────────────
//
// Trufy 3.1: the cosigner is the SERVER's attestation key — one key for every
// order, whose address must equal the factory's immutable `cosigner` (deployed
// as COSIGNER_ADDRESS). It is used to (a) EIP-712-sign orders and (b) relay
// EscrowDst.claim(). It is emphatically NOT per-user: the previous code derived
// it from each session's `rootSecret`, so every swapper signed with a different
// key while the factory only accepts one — every real order reverted on the
// cosigner check. `rootSecret` is now used ONLY to derive that session's HTLC
// secrets (see deriveSecret); it is never a signing key.
export function getCosignerWallet(provider?: ethers.providers.Provider): ethers.Wallet {
  const pk = process.env.COSIGNER_PRIVATE_KEY
  if (!pk) throw new Error('COSIGNER_PRIVATE_KEY not set — the server cosigner key must match the factory\'s immutable cosigner (COSIGNER_ADDRESS)')
  return provider ? new ethers.Wallet(pk, provider) : new ethers.Wallet(pk)
}

export function getCosignerAddress(): string {
  return getCosignerWallet().address
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface SessionInfo {
  swapper:      string
  cosignerAddr: string
  isNew:        boolean
}

export async function getOrCreateSession(swapper: string): Promise<SessionInfo> {
  // The cosigner is server-wide, the same for every swapper (see getCosignerWallet).
  const cosignerAddr = getCosignerAddress()

  const existing = await db.query('SELECT 1 FROM cc_sessions WHERE swapper = $1', [swapper])
  if (existing.rows.length > 0) {
    return { swapper, cosignerAddr, isNew: false }
  }

  // Per-user root secret — used ONLY to derive this session's HTLC secrets,
  // never as a signing key (Trufy 3.1).
  const rootSecret = ethers.utils.hexlify(ethers.utils.randomBytes(32))

  await db.query(
    'INSERT INTO cc_sessions (swapper, root_secret, cosigner_addr) VALUES ($1, $2, $3)',
    [swapper, rootSecret, cosignerAddr]
  )
  return { swapper, cosignerAddr, isNew: true }
}

async function getRootSecret(swapper: string): Promise<string | null> {
  const r = await db.query('SELECT root_secret FROM cc_sessions WHERE swapper = $1', [swapper])
  return r.rows[0]?.root_secret ?? null
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export interface CreateOrderParams {
  swapper:      string
  inputToken:   string
  inputAmount:  string
  outputToken:  string
  minOutput:    string
  deadline:     number
  nonce:        string
  chainAId:     number
  dstChainId:   number
  t2Buffer:     number   // blocks before T1 that Chain B locks expire
}

export interface OrderResult {
  orderHash:   string
  merkleRoot:  string
  numSlots:    number
  cosignerSig: string
}

const ORDER_TYPE_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(
  'CrossChainOrder(' +
  'address swapper,address inputToken,uint256 inputAmount,' +
  'address outputToken,uint256 minOutput,' +
  'uint256 deadline,uint256 nonce,bytes32 merkleRoot,uint8 numSlots)'
))

function computeDomainSeparator(chainId: number, reactorAddr: string): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32','bytes32','uint256','address'],
      [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)')),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes('NeutronX CrossChain')),
        chainId,
        reactorAddr,
      ]
    )
  )
}

export async function createCrossChainOrder(p: CreateOrderParams): Promise<OrderResult> {
  const ids = chainIds()
  if (!ids.includes(p.chainAId))   throw new Error(`Unknown source chain ${p.chainAId}`)
  if (!ids.includes(p.dstChainId)) throw new Error(`Unknown destination chain ${p.dstChainId}`)
  if (p.chainAId === p.dstChainId) throw new Error('Source and destination chains must differ')

  // Trufy 3.1: the contracts do not enforce T2 < T1 on-chain, so the sanctioned
  // destination expiry (t2_expiry = deadline - t2Buffer) is the only thing
  // keeping the destination leg from outliving the source leg. A negative or
  // oversized buffer would push t2_expiry >= deadline (T1) and revive the
  // atomicity break, so reject anything that isn't a positive, bounded buffer
  // that leaves t2_expiry strictly inside (0, deadline).
  if (!Number.isInteger(p.t2Buffer) || p.t2Buffer <= 0) {
    throw new Error('t2Buffer must be a positive integer (blocks before T1)')
  }
  if (p.t2Buffer >= p.deadline) {
    throw new Error('t2Buffer too large: t2_expiry must be strictly between 0 and deadline')
  }
  const reactorAddr = getChain(p.chainAId).escrowSrcFactory

  const rootSecret = await getRootSecret(p.swapper)
  if (!rootSecret) throw new Error('Session not found — call POST /cc/session first')

  const inputDecimals = (await listTokens(p.chainAId))
    .find(t => t.address.toLowerCase() === p.inputToken.toLowerCase())?.decimals ?? 18
  const numSlots = getNumSlots(p.inputAmount, inputDecimals)
  const master   = deriveMasterSecret(rootSecret, p)

  // Build slot data
  const leaves: string[] = []
  const slotData: { hashlock: string; leaf: string }[] = []

  for (let i = 0; i < numSlots; i++) {
    const secret   = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32','uint8'], [master, i]))
    const hashlock = deriveHashlock(secret)
    const leaf     = computeLeaf(hashlock, i)
    leaves.push(leaf)
    slotData.push({ hashlock, leaf })
  }

  const { root: merkleRoot, layers } = buildTree(leaves)

  // EIP-712 sign as cosigner — single server key (NOT derived from rootSecret).
  const cosignerWallet = getCosignerWallet()

  const structHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32','address','address','uint256','address','uint256','uint256','uint256','bytes32','uint8'],
      [ORDER_TYPE_HASH, p.swapper, p.inputToken, p.inputAmount,
       p.outputToken, p.minOutput, p.deadline, p.nonce, merkleRoot, numSlots]
    )
  )
  const digest = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['string','bytes32','bytes32'],
      ['\x19\x01', computeDomainSeparator(p.chainAId, reactorAddr), structHash]
    )
  )
  const cosignerSig = ethers.utils.joinSignature(cosignerWallet._signingKey().signDigest(digest))

  const t2Expiry = p.deadline - p.t2Buffer

  // Persist order
  await db.query(`
    INSERT INTO cc_orders
      (order_hash, swapper, input_token, input_amount, output_token, min_output,
       deadline, nonce, num_slots, merkle_root, cosigner_sig, t2_expiry, reactor_addr, chain_a_id, dst_chain_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (order_hash) DO NOTHING
  `, [structHash, p.swapper, p.inputToken, p.inputAmount, p.outputToken, p.minOutput,
      p.deadline, p.nonce, numSlots, merkleRoot, cosignerSig, t2Expiry, reactorAddr, p.chainAId, p.dstChainId])

  // Persist slots
  for (let i = 0; i < numSlots; i++) {
    const proof = getProof(layers, i)
    await db.query(`
      INSERT INTO cc_slots (order_hash, slot_index, hashlock, leaf, proof)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (order_hash, slot_index) DO NOTHING
    `, [structHash, i, slotData[i].hashlock, slotData[i].leaf, JSON.stringify(proof)])
  }

  return { orderHash: structHash, merkleRoot, numSlots, cosignerSig }
}

// Swapper's wallet signs orderHash (EIP-712, _signTypedData) once the order is
// created. EscrowSrcFactory.fillSlot() requires this alongside cosignerSig.
export async function setSwapperSig(orderHash: string, swapperSig: string): Promise<void> {
  const o = await db.query(
    'SELECT swapper, reactor_addr, chain_a_id FROM cc_orders WHERE order_hash = $1', [orderHash]
  )
  if (!o.rows.length) throw new Error('Order not found')
  const { swapper, reactor_addr, chain_a_id } = o.rows[0]

  const digest = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['string','bytes32','bytes32'],
      ['\x19\x01', computeDomainSeparator(chain_a_id, reactor_addr), orderHash]
    )
  )
  const recovered = ethers.utils.recoverAddress(digest, swapperSig)
  if (recovered.toLowerCase() !== swapper.toLowerCase()) {
    throw new Error('swapperSig does not match order.swapper')
  }

  await db.query('UPDATE cc_orders SET swapper_sig = $1 WHERE order_hash = $2', [swapperSig, orderHash])
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export async function getSessionWithOrders(swapper: string) {
  const session = await db.query(
    'SELECT cosigner_addr FROM cc_sessions WHERE swapper = $1', [swapper]
  )
  if (!session.rows.length) return null

  const orders = await db.query(
    'SELECT * FROM cc_orders WHERE swapper = $1 ORDER BY created_at DESC', [swapper]
  )
  const result = []
  for (const o of orders.rows) {
    const slots = await db.query(
      'SELECT slot_index, hashlock, status, assigned_filler, escrow_addr FROM cc_slots WHERE order_hash = $1 ORDER BY slot_index',
      [o.order_hash]
    )
    result.push({
      orderHash:   o.order_hash,
      inputToken:  o.input_token,
      inputAmount: o.input_amount,
      outputToken: o.output_token,
      minOutput:   o.min_output,
      deadline:    o.deadline,
      numSlots:    o.num_slots,
      merkleRoot:  o.merkle_root,
      cosignerSig: o.cosigner_sig,
      t2Expiry:    o.t2_expiry,
      slots: slots.rows.map(s => ({
        index:          s.slot_index,
        hashlock:       s.hashlock,
        status:         s.status,
        assignedFiller: s.assigned_filler,
        escrowAddr:     s.escrow_addr,
      }))
    })
  }

  return { cosignerAddr: session.rows[0].cosigner_addr, orders: result }
}

export async function getCrossChainOrder(orderHash: string) {
  const o = await db.query('SELECT * FROM cc_orders WHERE order_hash = $1', [orderHash])
  if (!o.rows.length) return null
  const slots = await db.query(
    'SELECT slot_index, hashlock, proof, status, assigned_filler, escrow_addr FROM cc_slots WHERE order_hash = $1 ORDER BY slot_index',
    [orderHash]
  )
  const row = o.rows[0]
  return {
    orderHash:   row.order_hash,
    swapper:     row.swapper,
    inputToken:  row.input_token,
    inputAmount: row.input_amount,
    outputToken: row.output_token,
    minOutput:   row.min_output,
    deadline:    row.deadline,
    nonce:       row.nonce,
    numSlots:    row.num_slots,
    merkleRoot:  row.merkle_root,
    cosignerSig: row.cosigner_sig,
    swapperSig:  row.swapper_sig,
    t2Expiry:    row.t2_expiry,
    chainAId:    row.chain_a_id,
    dstChainId:  row.dst_chain_id,
    reactorAddr: row.reactor_addr,
    slots: slots.rows.map(s => ({
      index:          s.slot_index,
      hashlock:       s.hashlock,
      proof:          JSON.parse(s.proof) as string[],
      status:         s.status,
      assignedFiller: s.assigned_filler,
      escrowAddr:     s.escrow_addr,
    }))
  }
}

// Find which order+slot a given hashlock belongs to (used by the dst-chain watcher)
export async function findSlotByHashlock(hashlock: string) {
  const r = await db.query(`
    SELECT s.order_hash, s.slot_index, o.swapper, o.input_token, o.input_amount,
           o.output_token, o.min_output, o.deadline, o.nonce, o.t2_expiry, o.chain_a_id, o.dst_chain_id
    FROM cc_slots s
    JOIN cc_orders o ON o.order_hash = s.order_hash
    WHERE s.hashlock = $1 AND s.status = 'available'
  `, [hashlock])
  return r.rows[0] ?? null
}

export async function updateSlotStatus(
  orderHash: string, slotIndex: number,
  status: string, escrowAddr?: string
): Promise<void> {
  await db.query(
    'UPDATE cc_slots SET status=$1, escrow_addr=$2 WHERE order_hash=$3 AND slot_index=$4',
    [status, escrowAddr ?? null, orderHash, slotIndex]
  )
}

// Filler calls this right after registerFiller() so the dev UI can show
// which wallet owns each claimed slot (avoids "not registered filler" confusion).
export async function updateSlotFiller(orderHash: string, slotIndex: number, filler: string): Promise<void> {
  await db.query(
    'UPDATE cc_slots SET assigned_filler=$1 WHERE order_hash=$2 AND slot_index=$3',
    [filler.toLowerCase(), orderHash, slotIndex]
  )
}

// Filler calls this after successfully calling claimSlot() on Chain A.
// Transitions 'claimed' → 'done' so the dev UI stops showing "Claim WETH".
// Trufy 3.10: only a 'claimed' slot may move to 'done'. The endpoint is public,
// so without this guard anyone could mark a still-'available' slot 'done' and
// hide it from the destination watcher (which only matches 'available' rows),
// suppressing settlement. The WHERE clause makes that a no-op.
export async function markSlotDone(orderHash: string, slotIndex: number): Promise<void> {
  await db.query(
    "UPDATE cc_slots SET status='done' WHERE order_hash=$1 AND slot_index=$2 AND status='claimed'",
    [orderHash, slotIndex]
  )
}

// All slots ever assigned to `address` (any chain, any status) — for the
// Fillers page's "past fills" table.
export async function getFillerFills(address: string) {
  const r = await db.query(`
    SELECT s.order_hash, s.slot_index, s.status, s.escrow_addr,
           o.chain_a_id, o.dst_chain_id, o.output_token, o.min_output, o.num_slots, o.created_at
    FROM cc_slots s
    JOIN cc_orders o ON o.order_hash = s.order_hash
    WHERE LOWER(s.assigned_filler) = LOWER($1)
    ORDER BY o.created_at DESC
  `, [address])
  return r.rows.map(row => ({
    orderHash:   row.order_hash,
    slotIndex:   row.slot_index,
    status:      row.status,
    escrowAddr:  row.escrow_addr,
    chainAId:    row.chain_a_id,
    dstChainId:  row.dst_chain_id,
    outputToken: row.output_token,
    amount:      (BigInt(row.min_output) / BigInt(row.num_slots)).toString(),
    createdAt:   row.created_at,
  }))
}

// List all CC orders that still have at least one available slot (for filler dev UI)
export async function listOpenCCOrders() {
  const r = await db.query(`
    SELECT o.order_hash, o.swapper, o.input_token, o.input_amount,
           o.output_token, o.min_output, o.deadline, o.num_slots, o.t2_expiry,
           o.chain_a_id, o.dst_chain_id
    FROM cc_orders o
    ORDER BY o.created_at DESC
    LIMIT 20
  `)
  const result = []
  for (const row of r.rows) {
    const slots = await db.query(
      'SELECT slot_index, status, assigned_filler FROM cc_slots WHERE order_hash=$1 ORDER BY slot_index',
      [row.order_hash]
    )
    result.push({
      orderHash:   row.order_hash,
      swapper:     row.swapper,
      inputToken:  row.input_token,
      inputAmount: row.input_amount,
      outputToken: row.output_token,
      minOutput:   row.min_output,
      deadline:    row.deadline,
      numSlots:    row.num_slots,
      t2Expiry:    row.t2_expiry,
      chainAId:    row.chain_a_id,
      dstChainId:  row.dst_chain_id,
      slots: slots.rows.map(s => ({
        index:          s.slot_index,
        status:         s.status,
        assignedFiller: s.assigned_filler ?? null,
      })),
    })
  }
  return result
}
