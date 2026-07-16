import { ethers } from 'ethers'
import { db } from '../db/client'
import { ensureIndexerStateTable, resolveCheckpoint, setCheckpoint, queryFilterChunked } from '../db/checkpoint'
import * as dotenv from 'dotenv'
dotenv.config()

// Indexes FillAuction's stake lifecycle (Registered -> filled/slashed/released)
// into `registrations` so the Fillers page can show a filler's outstanding
// stakes and offer a manual releaseRegistration() reclaim button. Mirrors
// stakeConfigIndexer.ts's checkpointed poll pattern.
const FILL_AUCTION_ABI = [
  'event Registered(address indexed filler, bytes32 indexed orderHash, uint256 fillAmount, uint256 stake)',
  'event Slashed(address indexed filler, bytes32 indexed orderHash, uint256 stake, address caller, uint256 reward)',
  'event StakeReturned(address indexed filler, bytes32 indexed orderHash, uint256 refund)',
  'event StakeForfeited(address indexed filler, bytes32 indexed orderHash, uint256 amount)',
  'event StakeReleased(address indexed filler, bytes32 indexed orderHash, uint256 amount)',
]

async function initRegistrationSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS registrations (
      order_hash       TEXT NOT NULL REFERENCES orders(hash),
      filler           TEXT NOT NULL,
      fill_amount      TEXT NOT NULL,
      stake_amount     TEXT NOT NULL,
      -- active: staked, not yet resolved. filled: won the race, stake settled via
      -- StakeReturned(+StakeForfeited). slashed: abandoned, lost to Slashed().
      -- released: reclaimed in full via releaseRegistration() (order satisfied by
      -- someone else / cancelled / nonce-invalidated).
      status           TEXT NOT NULL DEFAULT 'active',
      refund_amount    TEXT,
      forfeited_amount TEXT,
      slashed_reward   TEXT,
      slashed_by       TEXT,
      registered_block BIGINT NOT NULL,
      resolved_block   BIGINT,
      resolved_tx_hash TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (order_hash, filler)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_registrations_filler ON registrations(filler)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations(status)`)
}

async function handleRegistered(log: ethers.Event) {
  const { filler, orderHash, fillAmount, stake } = log.args!
  try {
    await db.query(`
      INSERT INTO registrations (order_hash, filler, fill_amount, stake_amount, registered_block)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (order_hash, filler) DO NOTHING
    `, [orderHash, filler, (fillAmount as ethers.BigNumber).toString(), (stake as ethers.BigNumber).toString(), log.blockNumber])
  } catch (e) { console.error('Registration indexer error (Registered):', e) }
}

async function handleStakeReturned(log: ethers.Event) {
  const { filler, orderHash, refund } = log.args!
  try {
    await db.query(`
      UPDATE registrations
      SET status = 'filled', refund_amount = $3, resolved_block = $4, resolved_tx_hash = $5
      WHERE order_hash = $1 AND filler = $2
    `, [orderHash, filler, (refund as ethers.BigNumber).toString(), log.blockNumber, log.transactionHash])
  } catch (e) { console.error('Registration indexer error (StakeReturned):', e) }
}

// Co-fires with StakeReturned in the same tx (only when the refund table docks
// part of the stake) — the row already exists and is already 'filled' by then.
async function handleStakeForfeited(log: ethers.Event) {
  const { filler, orderHash, amount } = log.args!
  try {
    await db.query(`
      UPDATE registrations SET forfeited_amount = $3
      WHERE order_hash = $1 AND filler = $2
    `, [orderHash, filler, (amount as ethers.BigNumber).toString()])
  } catch (e) { console.error('Registration indexer error (StakeForfeited):', e) }
}

async function handleSlashed(log: ethers.Event) {
  const { filler, orderHash, caller, reward } = log.args!
  try {
    await db.query(`
      UPDATE registrations
      SET status = 'slashed', slashed_reward = $3, slashed_by = $4, resolved_block = $5, resolved_tx_hash = $6
      WHERE order_hash = $1 AND filler = $2
    `, [orderHash, filler, (reward as ethers.BigNumber).toString(), caller, log.blockNumber, log.transactionHash])
  } catch (e) { console.error('Registration indexer error (Slashed):', e) }
}

async function handleStakeReleased(log: ethers.Event) {
  const { filler, orderHash } = log.args!
  try {
    await db.query(`
      UPDATE registrations SET status = 'released', resolved_block = $3, resolved_tx_hash = $4
      WHERE order_hash = $1 AND filler = $2
    `, [orderHash, filler, log.blockNumber, log.transactionHash])
  } catch (e) { console.error('Registration indexer error (StakeReleased):', e) }
}

export async function startRegistrationIndexer() {
  const fillAuctionAddr = process.env.FILL_AUCTION
  if (!fillAuctionAddr) {
    console.warn('Registration indexer: FILL_AUCTION not set — skipping')
    return
  }

  const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL)
  const auction  = new ethers.Contract(fillAuctionAddr, FILL_AUCTION_ABI, provider)

  await ensureIndexerStateTable()
  await initRegistrationSchema()

  const currentBlock = await provider.getBlockNumber()
  const genesis = await provider.getBlock(0).catch(() => null)
  let lastBlock = await resolveCheckpoint('fillauction_registrations', currentBlock, 'Registration indexer', genesis?.hash)

  console.log('Registration indexer started')

  provider.on('block', async (blockNumber: number) => {
    if (blockNumber <= lastBlock) return
    try {
      const [registered, returned, forfeited, slashed, released] = await Promise.all([
        queryFilterChunked(auction, auction.filters.Registered(),     lastBlock + 1, blockNumber),
        queryFilterChunked(auction, auction.filters.StakeReturned(),  lastBlock + 1, blockNumber),
        queryFilterChunked(auction, auction.filters.StakeForfeited(), lastBlock + 1, blockNumber),
        queryFilterChunked(auction, auction.filters.Slashed(),        lastBlock + 1, blockNumber),
        queryFilterChunked(auction, auction.filters.StakeReleased(),  lastBlock + 1, blockNumber),
      ])

      for (const log of registered) await handleRegistered(log)
      // StakeReturned before StakeForfeited: they can co-fire in the same block,
      // and Forfeited's UPDATE assumes the row Returned just marked 'filled' exists.
      for (const log of returned)   await handleStakeReturned(log)
      for (const log of forfeited)  await handleStakeForfeited(log)
      for (const log of slashed)    await handleSlashed(log)
      for (const log of released)   await handleStakeReleased(log)

      lastBlock = blockNumber
      await setCheckpoint('fillauction_registrations', lastBlock)
    } catch (e) {
      console.error('Registration indexer poll error:', e)
    }
  })

  provider.on('error', (e) => {
    console.error('Registration indexer provider error:', e)
    setTimeout(startRegistrationIndexer, 5000)
  })
}
