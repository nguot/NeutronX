import type {
  CreateOrderRequest,
  CreateOrderResponse,
  GetOrdersResponse,
  OrderDetail,
  CancelOrderResponse
} from '../types/order'

import { db } from '../db/client'
import { ethers } from 'ethers'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { parse as parseEnv } from 'dotenv'
import { getAggregator } from './aggregators'

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']

// Mirrors frontend/src/pages/DutchAuction.tsx's AUCTION_BLOCKS — used to derive
// startBlock for orders created before that field was tracked (start_block IS NULL).
const AUCTION_BLOCKS_FALLBACK = 200

function getProvider(): ethers.providers.JsonRpcProvider {
  return new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL || process.env.RPC_URL || 'http://127.0.0.1:8545')
}

const ORDER_TYPE_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes(
    // C-1: price curve (startPrice/decayPerBlock/feeTier) is now part of the
    // signed hash — must match PartialFillReactor.ORDER_TYPE_HASH exactly.
    'PartialFillOrder(' +
    'address swapper,address inputToken,uint256 inputAmount,' +
    'address outputToken,uint256 minOutputAmount,' +
    'uint256 deadline,uint256 nonce,uint16 minFillBps,' +
    'uint128 startPrice,uint32 decayPerBlock,uint24 feeTier' +
    ')'
  )
)

// Trufy 3.4: the 8-field PartialFillOrder the SWAPPER's wallet signs in the
// frontend (DutchAuction.tsx). We verify this signature recovers to
// order.swapper before cosigning, so the backend never cosigns an order for a
// victim address the caller doesn't control. (The price-curve fields are
// cosigner-set and bounded on-chain by the swapper-signed minOutput floor.)
const SWAPPER_ORDER_TYPE_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes(
    'PartialFillOrder(' +
    'address swapper,address inputToken,uint256 inputAmount,' +
    'address outputToken,uint256 minOutputAmount,' +
    'uint256 deadline,uint256 nonce,uint16 minFillBps' +
    ')'
  )
)

function swapperDigest(order: CreateOrderRequest['order']): string {
  const structHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint16'],
      [
        SWAPPER_ORDER_TYPE_HASH,
        order.swapper, order.inputToken, order.inputAmount,
        order.outputToken, order.minOutputAmount, order.deadline,
        order.nonce, order.minFillBps,
      ]
    )
  )
  return ethers.utils.keccak256(
    ethers.utils.solidityPack(['string', 'bytes32', 'bytes32'], ['\x19\x01', getDomainSeparator(), structHash])
  )
}

// Re-read .env on every call so setup.sh can redeploy contracts without restarting the backend.
// The contract bakes address(this) into its DOMAIN_SEPARATOR at deploy time — we must match it.
function getReactorAddress(): string {
  try {
    const parsed = parseEnv(readFileSync(resolve(process.cwd(), '.env')))
    return parsed['PARTIAL_FILL_REACTOR'] || process.env.PARTIAL_FILL_REACTOR || ''
  } catch {
    return process.env.PARTIAL_FILL_REACTOR || ''
  }
}

function getDomainSeparator(): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address'],
      [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)')),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes('NeutronX')),
        parseInt(process.env.CHAIN_ID || '1'),
        getReactorAddress()
      ]
    )
  )
}

async function signOrder(order: CreateOrderRequest['order']): Promise<string> {
  const structHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint16', 'uint128', 'uint32', 'uint24'],
      [
        ORDER_TYPE_HASH,
        order.swapper,
        order.inputToken,
        order.inputAmount,
        order.outputToken,
        order.minOutputAmount,
        order.deadline,
        order.nonce,
        order.minFillBps,
        order.startPrice,
        order.decayPerBlock,
        order.feeTier
      ]
    )
  )

  const digest = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['string', 'bytes32', 'bytes32'],
      ['\x19\x01', getDomainSeparator(), structHash]
    )
  )

  const signingKey = new ethers.utils.SigningKey(process.env.PRIVATE_KEY!)
  const sig = signingKey.signDigest(digest)
  return ethers.utils.joinSignature(sig)
}

function hashOrder(order: CreateOrderRequest['order'], signature: string): string {
  return ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(JSON.stringify(order) + signature)
  )
}

export async function createOrder(dto: CreateOrderRequest): Promise<CreateOrderResponse> {
  const { order } = dto

  const preferredAggregator = dto.preferredAggregator || null
  if (preferredAggregator && !getAggregator(preferredAggregator)) {
    throw new Error(`Unknown preferredAggregator '${preferredAggregator}'`)
  }

  // Trufy 3.4: authenticate the swapper BEFORE cosigning. The order is signed by
  // the swapper's own wallet in the frontend; require that signature to recover
  // to order.swapper. Otherwise anyone could POST an order for an arbitrary
  // victim that has a standing Permit2 allowance and have the backend cosign it
  // (on-chain only the cosigner sig is checked), forcing an unfavourable swap.
  if (!dto.signature) throw new Error('Missing swapper signature')
  let recovered: string
  try {
    recovered = ethers.utils.recoverAddress(swapperDigest(order), dto.signature)
  } catch {
    throw new Error('Invalid swapper signature')
  }
  if (recovered.toLowerCase() !== order.swapper.toLowerCase()) {
    throw new Error('Order signature does not match swapper')
  }

  // Reject orders the swapper can't fulfill — a valid Permit2 approval with zero
  // token balance produces a "pending" order that no filler can ever fill.
  const erc = new ethers.Contract(order.inputToken, ERC20_ABI, getProvider())
  const balance: ethers.BigNumber = await erc.balanceOf(order.swapper)
  if (balance.lt(order.inputAmount)) {
    const decimals = await erc.decimals().catch(() => 18)
    const symbol   = await erc.symbol().catch(() => order.inputToken)
    throw new Error(
      `Insufficient ${symbol} balance: have ${ethers.utils.formatUnits(balance, decimals)}, ` +
      `need ${ethers.utils.formatUnits(order.inputAmount, decimals)}`
    )
  }

  const cosignerSig = await signOrder(order)
  const structHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint16', 'uint128', 'uint32', 'uint24'],
      [
        ORDER_TYPE_HASH,
        order.swapper,
        order.inputToken,
        order.inputAmount,
        order.outputToken,
        order.minOutputAmount,
        order.deadline,
        order.nonce,
        order.minFillBps,
        order.startPrice,
        order.decayPerBlock,
        order.feeTier
      ]
    )
  )
  const hash = structHash

  const existing = await db.query('SELECT hash FROM orders WHERE hash = $1', [hash])
  if (existing.rows.length > 0) throw new Error('Order already exists')

  await db.query(`
    INSERT INTO orders (
      hash, swapper, input_token, output_token,
      input_amount, min_output, deadline, nonce,
      min_fill_bps, start_price, decay_per_block,
      fee_tier, signature, preferred_aggregator, start_block, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending')
  `, [
    hash,
    order.swapper,
    order.inputToken,
    order.outputToken,
    order.inputAmount,
    order.minOutputAmount,
    order.deadline,
    order.nonce,
    order.minFillBps,
    order.startPrice,
    order.decayPerBlock,
    order.feeTier,
    cosignerSig,
    preferredAggregator,
    order.startBlock ?? null
  ])

  return { orderHash: hash, status: 'pending' }
}

export async function getOrders(swapper?: string, status?: string, page = 1, limit = 20): Promise<GetOrdersResponse> {
  const conditions: string[] = []
  const params: any[] = []
  let idx = 1

  if (swapper) { conditions.push(`swapper = $${idx++}`); params.push(swapper) }
  if (status) { conditions.push(`status = $${idx++}`); params.push(status) }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const offset = (page - 1) * limit

  const rows = await db.query(`
    SELECT
      hash, swapper, input_token, output_token,
      input_amount, min_output, deadline, status, created_at,
      preferred_aggregator,
      (SELECT COUNT(*) FROM fills WHERE order_hash = orders.hash) AS fills
    FROM orders
    ${where}
    ORDER BY created_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `, [...params, limit, offset])

  const total = await db.query(`SELECT COUNT(*) FROM orders ${where}`, params)

  return {
    orders: rows.rows.map(r => ({
      hash: r.hash,
      swapper: r.swapper,
      inputToken: r.input_token,
      outputToken: r.output_token,
      inputAmount: r.input_amount,
      minOutput: r.min_output,
      deadline: parseInt(r.deadline),
      status: r.status,
      fills: parseInt(r.fills),
      createdAt: r.created_at.toISOString(),
      preferredAggregator: r.preferred_aggregator ?? null
    })),
    total: parseInt(total.rows[0].count),
    page
  }
}

export async function getOrder(hash: string): Promise<OrderDetail | null> {
  const row = await db.query('SELECT * FROM orders WHERE hash = $1', [hash])
  if (!row.rows.length) return null

  const fills = await db.query(
    'SELECT * FROM fills WHERE order_hash = $1 ORDER BY created_at DESC', [hash]
  )

  const o = row.rows[0]
  return {
    hash: o.hash,
    swapper: o.swapper,
    inputToken: o.input_token,
    outputToken: o.output_token,
    inputAmount: o.input_amount,
    minOutput: o.min_output,
    deadline: parseInt(o.deadline),
    nonce: parseInt(o.nonce),
    minFillBps: parseInt(o.min_fill_bps),
    startPrice: o.start_price,
    decayPerBlock: parseInt(o.decay_per_block),
    feeTier: parseInt(o.fee_tier),
    startBlock: o.start_block != null ? parseInt(o.start_block) : parseInt(o.deadline) - AUCTION_BLOCKS_FALLBACK,
    status: o.status,
    signature: o.signature,
    createdAt: o.created_at.toISOString(),
    preferredAggregator: o.preferred_aggregator ?? null,
    fills: fills.rows.map(f => ({
      id: f.id,
      filler: f.filler,
      fillAmount: f.fill_amount,
      outputAmount: f.output_amount,
      txHash: f.tx_hash,
      path: f.path ?? null,
      blockNumber: f.block_number ? parseInt(f.block_number) : null,
      createdAt: f.created_at.toISOString()
    }))
  }
}

// Single-chain Dutch-auction fills by a filler address — powers the
// "Single-chain swap fills" section on the Fillers page, alongside
// crosschainService.getFillerFills() for the cc_slots side.
export async function getFillerSwapFills(filler: string) {
  const r = await db.query(`
    SELECT f.id, f.order_hash, f.fill_amount, f.output_amount,
           f.tx_hash, f.block_number, f.created_at,
           o.input_token, o.output_token, o.input_amount AS order_total
    FROM fills f
    JOIN orders o ON o.hash = f.order_hash
    WHERE LOWER(f.filler) = LOWER($1)
    ORDER BY f.created_at DESC
  `, [filler])
  return r.rows.map(f => ({
    id:           f.id,
    orderHash:    f.order_hash,
    fillAmount:   f.fill_amount,
    outputAmount: f.output_amount,
    txHash:       f.tx_hash,
    blockNumber:  f.block_number ? parseInt(f.block_number) : null,
    createdAt:    f.created_at.toISOString(),
    inputToken:   f.input_token,
    outputToken:  f.output_token,
    orderTotal:   f.order_total,
  }))
}

// Trufy 3.7: `swapper` is optional. When the caller is already authorized (admin
// route), it is omitted and no address match is enforced; if provided, the order
// must belong to that swapper. Either way this only updates backend state.
export async function cancelOrder(hash: string, swapper?: string): Promise<CancelOrderResponse> {
  const row = await db.query('SELECT swapper, status FROM orders WHERE hash = $1', [hash])
  if (!row.rows.length) throw new Error('Order not found')
  if (swapper !== undefined && row.rows[0].swapper !== swapper) throw new Error('Not your order')
  if (row.rows[0].status !== 'pending' && row.rows[0].status !== 'active') {
    throw new Error('Cannot cancel')
  }

  await db.query('UPDATE orders SET status = $1 WHERE hash = $2', ['cancelled', hash])
  return { success: true, orderHash: hash }
}