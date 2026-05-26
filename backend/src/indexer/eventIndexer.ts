import { ethers } from 'ethers'
import { db } from '../db/client'
import * as dotenv from 'dotenv'
dotenv.config()

const REACTOR_ABI = [
  'event PartialFillExecuted(bytes32 indexed orderHash, address indexed filler, uint256 fillAmount, uint256 outputAmount)'
]

const FALLBACK_ABI = [
  'event FallbackExecuted(bytes32 indexed orderHash, uint256 amountIn, uint256 amountOut)'
]

export async function startIndexer() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL)

  const reactor = new ethers.Contract(
    process.env.PARTIAL_FILL_REACTOR!,
    REACTOR_ABI,
    provider
  )

  const fallbackExecutor = new ethers.Contract(
    process.env.FALLBACK_EXECUTOR!,
    FALLBACK_ABI,
    provider
  )

  console.log('Indexer started')

  // lắng nghe fill event
  reactor.on('PartialFillExecuted', async (orderHash, filler, fillAmount, outputAmount, event) => {
    console.log(`Fill detected: ${orderHash}`)
    console.log(`tx: ${event.transactionHash} logIndex: ${event.logIndex} block: ${event.blockNumber}`)

    try {
      console.log('inserting fill...')
      await db.query(`
        INSERT INTO fills (id, order_hash, filler, fill_amount, output_amount, tx_hash, block_number)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO NOTHING
      `, [
        event.transactionHash + '_' + event.logIndex,
        orderHash,
        filler,
        fillAmount.toString(),
        outputAmount.toString(),
        event.transactionHash,
        event.blockNumber
      ])
      console.log('fill inserted')

      // Determine if fully filled by summing all fills against input_amount
      const { rows } = await db.query(`
        SELECT o.input_amount,
               COALESCE(SUM(f.fill_amount::numeric), 0) AS total_filled
        FROM orders o
        LEFT JOIN fills f ON f.order_hash = o.hash
        WHERE o.hash = $1
        GROUP BY o.input_amount
      `, [orderHash])

      const newStatus = rows.length > 0 && BigInt(rows[0].total_filled) >= BigInt(rows[0].input_amount)
        ? 'filled'
        : 'active'

      console.log('updating order status to', newStatus)
      await db.query(
        'UPDATE orders SET status = $1 WHERE hash = $2',
        [newStatus, orderHash]
      )
      console.log('order updated to', newStatus)

    } catch (e) {
      console.error('Indexer error:', e)
    }
  })

  // lắng nghe fallback event
  fallbackExecutor.on('FallbackExecuted', async (orderHash, amountIn, amountOut, event) => {
    console.log(`Fallback detected: ${orderHash}`)
    try {
      await db.query(
        'UPDATE orders SET status = $1 WHERE hash = $2',
        ['filled', orderHash]
      )
    } catch (e) {
      console.error('Fallback indexer error:', e)
    }
  })

  // reconnect nếu mất kết nối
  provider.on('error', (e) => {
    console.error('Provider error:', e)
    setTimeout(startIndexer, 5000)
  })
}