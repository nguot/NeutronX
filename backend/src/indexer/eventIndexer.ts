import { ethers } from 'ethers'
import { db } from '../db/client'
import { ensureIndexerStateTable, resolveCheckpoint, setCheckpoint, queryFilterChunked } from '../db/checkpoint'
import * as dotenv from 'dotenv'
dotenv.config()

const REACTOR_ABI = [
  'event PartialFillExecuted(bytes32 indexed orderHash, address indexed filler, uint256 fillAmount, uint256 outputAmount)'
]

const FALLBACK_ABI = [
  'event FallbackExecuted(bytes32 indexed orderHash, uint256 amountIn, uint256 amountOut)'
]

async function handlePartialFill(log: ethers.Event) {
  const { orderHash, filler, fillAmount, outputAmount } = log.args!
  console.log(`Fill detected: ${orderHash}`)
  console.log(`tx: ${log.transactionHash} logIndex: ${log.logIndex} block: ${log.blockNumber}`)

  try {
    console.log('inserting fill...')
    await db.query(`
      INSERT INTO fills (id, order_hash, filler, fill_amount, output_amount, tx_hash, block_number)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
    `, [
      log.transactionHash + '_' + log.logIndex,
      orderHash,
      filler,
      (fillAmount as ethers.BigNumber).toString(),
      (outputAmount as ethers.BigNumber).toString(),
      log.transactionHash,
      log.blockNumber
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
}

async function handleFallbackExecuted(log: ethers.Event) {
  const { orderHash } = log.args!
  console.log(`Fallback detected: ${orderHash}`)
  try {
    await db.query(
      'UPDATE orders SET status = $1 WHERE hash = $2',
      ['filled', orderHash]
    )
  } catch (e) {
    console.error('Fallback indexer error:', e)
  }
}

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

  await ensureIndexerStateTable()

  const currentBlock   = await provider.getBlockNumber()
  let lastFillBlock     = await resolveCheckpoint('reactor_partial_fill', currentBlock, 'Indexer')
  let lastFallbackBlock = await resolveCheckpoint('fallback_executed', currentBlock, 'Indexer')

  console.log('Indexer started')

  // Poll for new blocks and pull only the log range since the last checkpoint.
  // Avoids contract.on(event, ...), whose first poll re-emits events sitting
  // in the current chain tip on every reconnect/restart.
  provider.on('block', async (blockNumber: number) => {
    if (blockNumber > lastFillBlock) {
      try {
        const logs = await queryFilterChunked(reactor, reactor.filters.PartialFillExecuted(), lastFillBlock + 1, blockNumber)
        for (const log of logs) await handlePartialFill(log)
        lastFillBlock = blockNumber
        await setCheckpoint('reactor_partial_fill', lastFillBlock)
      } catch (e) {
        console.error('Indexer poll error (PartialFillExecuted):', e)
      }
    }

    if (blockNumber > lastFallbackBlock) {
      try {
        const logs = await queryFilterChunked(fallbackExecutor, fallbackExecutor.filters.FallbackExecuted(), lastFallbackBlock + 1, blockNumber)
        for (const log of logs) await handleFallbackExecuted(log)
        lastFallbackBlock = blockNumber
        await setCheckpoint('fallback_executed', lastFallbackBlock)
      } catch (e) {
        console.error('Indexer poll error (FallbackExecuted):', e)
      }
    }
  })

  // reconnect nếu mất kết nối
  provider.on('error', (e) => {
    console.error('Provider error:', e)
    setTimeout(startIndexer, 5000)
  })
}
