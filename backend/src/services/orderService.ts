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

const ORDER_TYPE_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes(
    'PartialFillOrder(' +
    'address swapper,address inputToken,uint256 inputAmount,' +
    'address outputToken,uint256 minOutputAmount,' +
    'uint256 deadline,uint256 nonce,uint16 minFillBps' +
    ')'
  )
)

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
      ['bytes32', 'address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint16'],
      [
        ORDER_TYPE_HASH,
        order.swapper,
        order.inputToken,
        order.inputAmount,
        order.outputToken,
        order.minOutputAmount,
        order.deadline,
        order.nonce,
        order.minFillBps
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

  const cosignerSig = await signOrder(order)
  const structHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint16'],
      [
        ORDER_TYPE_HASH,
        order.swapper,
        order.inputToken,
        order.inputAmount,
        order.outputToken,
        order.minOutputAmount,
        order.deadline,
        order.nonce,
        order.minFillBps
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
      fee_tier, signature, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
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
    cosignerSig
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
      createdAt: r.created_at.toISOString()
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
    status: o.status,
    signature: o.signature,
    createdAt: o.created_at.toISOString(),
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

export async function cancelOrder(hash: string, swapper: string): Promise<CancelOrderResponse> {
  const row = await db.query('SELECT swapper, status FROM orders WHERE hash = $1', [hash])
  if (!row.rows.length) throw new Error('Order not found')
  if (row.rows[0].swapper !== swapper) throw new Error('Not your order')
  if (row.rows[0].status !== 'pending' && row.rows[0].status !== 'active') {
    throw new Error('Cannot cancel')
  }

  await db.query('UPDATE orders SET status = $1 WHERE hash = $2', ['cancelled', hash])
  return { success: true, orderHash: hash }
}