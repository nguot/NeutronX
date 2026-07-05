import { ethers } from 'ethers'
import { db } from '../db/client'
import { ensureIndexerStateTable, resolveCheckpoint, setCheckpoint, queryFilterChunked } from '../db/checkpoint'
import * as dotenv from 'dotenv'
dotenv.config()

// B6: indexes FillAuction's StakeConfig change events into stake_config_history
// so the frontend's "History" tab can render a timeline without re-scanning the
// chain on every page load. Mirrors indexer/eventIndexer.ts's poll-by-checkpoint
// pattern (see that file for why block-range polling is used instead of
// contract.on(event, ...)).
const STAKE_CONFIG_TUPLE =
  'tuple(uint256[] sizeThresholds, uint32[] collateralRate, uint256[] timeThresholds, uint32[] timeMult, uint256[] ratioThresholds, uint32[] refundTable, uint256 minCollateral)'

const FILL_AUCTION_ABI = [
  `function stakeConfig() view returns (${STAKE_CONFIG_TUPLE})`,
  `function setStakeConfig(${STAKE_CONFIG_TUPLE} c) external`,
  'event StakeConfigUpdated()',
  'event PendingConfigQueued(uint256 effectiveAt)',
  'event PendingConfigCancelled()',
  'event ConfigRollback()',
]

// ethers v5 decodes the StakeConfig tuple as an array-like Result — BigNumbers
// need .toString() before JSON.stringify (JSON.stringify(BigNumber) silently
// produces {"type":"BigNumber","hex":"0x.."} which is a nuisance to consume
// from the frontend, so normalize to plain strings/numbers here instead).
function snapshotToJson(cfg: any) {
  return {
    sizeThresholds:  cfg.sizeThresholds.map((v: ethers.BigNumber) => v.toString()),
    collateralRate:  cfg.collateralRate.map((v: number) => v),
    timeThresholds:  cfg.timeThresholds.map((v: ethers.BigNumber) => v.toString()),
    timeMult:        cfg.timeMult.map((v: number) => v),
    ratioThresholds: cfg.ratioThresholds.map((v: ethers.BigNumber) => v.toString()),
    refundTable:     cfg.refundTable.map((v: number) => v),
    minCollateral:   cfg.minCollateral.toString(),
  }
}

async function insertHistoryRow(
  eventType: 'applied' | 'pending_queued' | 'pending_cancelled' | 'rollback',
  log: ethers.Event,
  effectiveAt: number | null,
  configSnapshot: object | null,
) {
  try {
    await db.query(`
      INSERT INTO stake_config_history (id, event_type, block_number, tx_hash, effective_at, config_snapshot)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO NOTHING
    `, [
      log.transactionHash + '_' + log.logIndex,
      eventType,
      log.blockNumber,
      log.transactionHash,
      effectiveAt,
      configSnapshot ? JSON.stringify(configSnapshot) : null,
    ])
  } catch (e) {
    console.error('StakeConfig indexer insert error:', e)
  }
}

export async function initStakeConfigSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS stake_config_history (
      id              TEXT PRIMARY KEY,
      event_type      TEXT NOT NULL,
      block_number    BIGINT NOT NULL,
      tx_hash         TEXT NOT NULL,
      effective_at    BIGINT,
      config_snapshot JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_stake_config_history_block ON stake_config_history(block_number DESC)`)
}

export async function startStakeConfigIndexer() {
  const fillAuctionAddr = process.env.FILL_AUCTION
  if (!fillAuctionAddr) {
    console.warn('StakeConfig indexer: FILL_AUCTION not set — skipping')
    return
  }

  const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL)
  const iface    = new ethers.utils.Interface(FILL_AUCTION_ABI)
  const auction  = new ethers.Contract(fillAuctionAddr, FILL_AUCTION_ABI, provider)

  await ensureIndexerStateTable()
  await initStakeConfigSchema()

  const currentBlock = await provider.getBlockNumber()
  let lastBlock = await resolveCheckpoint('stake_config_events', currentBlock, 'StakeConfig indexer')

  console.log('StakeConfig indexer started')

  provider.on('block', async (blockNumber: number) => {
    if (blockNumber <= lastBlock) return
    try {
      const [updated, queued, cancelled, rolledBack] = await Promise.all([
        queryFilterChunked(auction, auction.filters.StakeConfigUpdated(), lastBlock + 1, blockNumber),
        queryFilterChunked(auction, auction.filters.PendingConfigQueued(), lastBlock + 1, blockNumber),
        queryFilterChunked(auction, auction.filters.PendingConfigCancelled(), lastBlock + 1, blockNumber),
        queryFilterChunked(auction, auction.filters.ConfigRollback(), lastBlock + 1, blockNumber),
      ])

      // StakeConfigUpdated fires for BOTH an immediate tighten and a committed
      // pending — either way the live config right after this block is the
      // right snapshot to store.
      for (const log of updated) {
        const cfg = await auction.stakeConfig({ blockTag: log.blockNumber })
        await insertHistoryRow('applied', log, null, snapshotToJson(cfg))
      }

      // The event itself carries no config data (just effectiveAt) — the
      // queued StakeConfig only exists in the triggering setStakeConfig() tx's
      // calldata, so decode that instead of a (post-queue) contract read.
      for (const log of queued) {
        let snapshot: object | null = null
        try {
          const tx = await provider.getTransaction(log.transactionHash)
          const decoded = iface.decodeFunctionData('setStakeConfig', tx.data)
          snapshot = snapshotToJson(decoded.c)
        } catch (e) {
          console.error('StakeConfig indexer: failed to decode queued config from tx', log.transactionHash, e)
        }
        const effectiveAt = (log.args?.effectiveAt as ethers.BigNumber)?.toNumber() ?? null
        await insertHistoryRow('pending_queued', log, effectiveAt, snapshot)
      }

      for (const log of cancelled) await insertHistoryRow('pending_cancelled', log, null, null)

      for (const log of rolledBack) {
        const cfg = await auction.stakeConfig({ blockTag: log.blockNumber })
        await insertHistoryRow('rollback', log, null, snapshotToJson(cfg))
      }

      lastBlock = blockNumber
      await setCheckpoint('stake_config_events', lastBlock)
    } catch (e) {
      console.error('StakeConfig indexer poll error:', e)
    }
  })

  provider.on('error', (e) => {
    console.error('StakeConfig indexer provider error:', e)
    setTimeout(startStakeConfigIndexer, 5000)
  })
}
