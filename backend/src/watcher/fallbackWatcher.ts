import { ethers } from 'ethers'
import { db } from '../db/client'
import { availableAggregators, getAggregator, resolveAggregatorChainId, AggregatorQuote, QuoteParams } from '../services/aggregators'
import * as dotenv from 'dotenv'
dotenv.config()

const FALLBACK_WINDOW = 10 // blocks — phải khớp với contract

const FALLBACK_ABI = [
  'function executeFallback(tuple(tuple(address swapper, address inputToken, uint256 inputAmount, address outputToken, uint256 minOutputAmount, uint256 deadline, uint256 nonce, uint16 minFillBps, uint128 startPrice, uint32 decayPerBlock, uint24 feeTier) info, bytes sig) order, address router, bytes routeCalldata, uint256 minAmountOut)',
  'event FallbackExecuted(bytes32 indexed orderHash, uint256 amountIn, uint256 amountOut)'
]

const REACTOR_ABI = [
  'function remainingInput(bytes32 orderHash, uint256 orderAmount) view returns (uint256)'
]

// Trufy 3.8: must match PartialFillReactor.ORDER_TYPE_HASH (and orderService)
// EXACTLY — the canonical 11-field type that includes the price curve. The old
// 8-field hash produced a different orderHash, so remainingInput() was queried
// against the wrong accounting slot and partially-filled orders were quoted at
// full size.
const ORDER_TYPE_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes(
    'PartialFillOrder(' +
    'address swapper,address inputToken,uint256 inputAmount,' +
    'address outputToken,uint256 minOutputAmount,' +
    'uint256 deadline,uint256 nonce,uint16 minFillBps,' +
    'uint128 startPrice,uint32 decayPerBlock,uint24 feeTier' +
    ')'
  )
)

function computeOrderHash(order: any): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32','address','address','uint256','address','uint256','uint256','uint256','uint16','uint128','uint32','uint24'],
      [ORDER_TYPE_HASH, order.swapper, order.input_token, order.input_amount,
       order.output_token, order.min_output, order.deadline, order.nonce, order.min_fill_bps,
       order.start_price, order.decay_per_block, order.fee_tier]
    )
  )
}

// token metadata cần cho các aggregator adapter
const TOKEN_META: Record<string, { decimals: number; symbol: string }> = {
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': { decimals: 18, symbol: 'WETH' },
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': { decimals: 6,  symbol: 'USDC' },
  '0xdAC17F958D2ee523a2206206994597C13D831ec7': { decimals: 6,  symbol: 'USDT' },
  '0x6B175474E89094C44Da98b954EedeAC495271d0F': { decimals: 18, symbol: 'DAI'  },
  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': { decimals: 8,  symbol: 'WBTC' },
  '0x514910771AF9Ca656af840dff83E8264EcF986CA': { decimals: 18, symbol: 'LINK' },
}

/**
 * Queries every aggregator available on `chainId` (or just `preferredKey`,
 * if the swapper pinned one) for `params`, and returns the quote with the
 * highest `minAmountOut`. This is the only place that needs to change if
 * "best of N aggregators" logic ever gets more sophisticated — adding a new
 * aggregator itself requires no change here at all.
 */
async function getBestQuote(
  chainId: number,
  preferredKey: string | null | undefined,
  params: QuoteParams
): Promise<{ aggregator: string; quote: AggregatorQuote }> {
  let candidates = availableAggregators(chainId)

  if (preferredKey) {
    const pinned = getAggregator(preferredKey)
    if (pinned && pinned.isAvailable(chainId)) candidates = [pinned]
    else console.warn(`preferred_aggregator '${preferredKey}' unavailable on chain ${chainId}, trying all`)
  }

  if (candidates.length === 0) throw new Error(`No aggregator available for chain ${chainId}`)

  const results = await Promise.all(candidates.map(async (a) => {
    try {
      const quote = await a.getQuote(params)
      return quote ? { aggregator: a.key, quote } : null
    } catch (e) {
      console.warn(`Aggregator '${a.key}' quote failed:`, e)
      return null
    }
  }))

  const best = results
    .filter((r): r is { aggregator: string; quote: AggregatorQuote } => r !== null)
    .sort((a, b) => (b.quote.minAmountOut > a.quote.minAmountOut ? 1 : a.quote.minAmountOut > b.quote.minAmountOut ? -1 : 0))[0]

  if (!best) throw new Error('No route found from any aggregator')
  return best
}

export interface AggregatorCheckResult {
  key:           string
  name:          string
  ok:            boolean
  minAmountOut?: string
  router?:       string
  error?:        string
}

export interface FallbackCheckResult {
  orderHash:           string
  chainId:             number
  remainingInput:      string
  preferredAggregator: string | null
  // Total minOutputAmount the swapper signed for the WHOLE order (12 DAI → 14.85
  // USDC in the example that motivated this) — never pro-rated.
  minOutputTotal:      string
  // Sum of fills.output_amount already paid out for this order (partial fills +
  // any prior fallback leg) — PartialFillReactor's on-chain _paidOutput[orderHash].
  paidSoFar:            string
  // FallbackExecutor.sol:111's per-leg floor: minOutputTotal * remainingInput /
  // inputAmount. Only ONE of the two gates the real tx enforces.
  proRataFloor:         string
  // PartialFillReactor.recordFallbackOutput's gate (PartialFillReactor.sol:240):
  // paidSoFar + amountOut must reach minOutputTotal. What's actually still owed.
  remainingOutputOwed:  string
  // max(proRataFloor, remainingOutputOwed) — the real bar a quote's minAmountOut
  // must clear for executeFallback to succeed on-chain (both requires must pass).
  // A quote's minAmountOut must be >= this or the real executeFallback() call
  // reverts ("below signed min output" or "min output total"). Lets the UI show
  // ✓/✗ against the actual combined gate, not just "a route exists".
  requiredMinOutput:   string
  results:             AggregatorCheckResult[]
}

/**
 * Dry-runs the same quoting step the watcher does for `hash` — against every
 * aggregator available on its chain — without executing anything on-chain.
 * Lets the Orders UI show whether (and why) a fallback would currently
 * succeed for this order.
 */
export async function checkFallbackRoute(hash: string): Promise<FallbackCheckResult> {
  const { rows } = await db.query('SELECT * FROM orders WHERE hash = $1', [hash])
  if (!rows.length) throw new Error('Order not found')
  const order = rows[0]

  const tokenIn  = TOKEN_META[order.input_token]
  const tokenOut = TOKEN_META[order.output_token]
  if (!tokenIn || !tokenOut) {
    throw new Error(`Unknown token metadata for ${order.input_token} / ${order.output_token}`)
  }

  const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL)
  const { chainId: networkChainId } = await provider.getNetwork()
  const chainId = resolveAggregatorChainId(networkChainId)

  const reactor = new ethers.Contract(process.env.PARTIAL_FILL_REACTOR!, REACTOR_ABI, provider)
  const orderHash = computeOrderHash(order)
  const rem = (await reactor.remainingInput(orderHash, order.input_amount) as ethers.BigNumber).toBigInt()

  const minOutputTotal = BigInt(order.min_output)
  const inputAmount    = BigInt(order.input_amount)

  // Gate 1 — FallbackExecutor.sol:111's per-leg floor (this fallback leg alone,
  // pro-rated to however much input is left).
  const proRataFloor = (minOutputTotal * rem) / inputAmount

  // Gate 2 — PartialFillReactor.recordFallbackOutput's cumulative floor
  // (PartialFillReactor.sol:236-241): total ever paid (prior partial fills +
  // this leg) must reach minOutputTotal. Mirrors on-chain _paidOutput[orderHash].
  const { rows: paidRows } = await db.query(
    `SELECT COALESCE(SUM(output_amount::numeric), 0) AS paid FROM fills WHERE order_hash = $1`,
    [orderHash]
  )
  const paidSoFar           = BigInt(paidRows[0].paid)
  const remainingOutputOwed = paidSoFar >= minOutputTotal ? 0n : minOutputTotal - paidSoFar

  // The real tx enforces BOTH requires — a quote must clear whichever is stricter.
  const requiredMinOutput = proRataFloor > remainingOutputOwed ? proRataFloor : remainingOutputOwed

  // Nothing left to route — querying aggregators with amountIn=0 just produces
  // confusing per-adapter errors (most reject a zero amount outright).
  if (rem === 0n) {
    return {
      orderHash, chainId,
      remainingInput: '0',
      preferredAggregator: order.preferred_aggregator ?? null,
      minOutputTotal: minOutputTotal.toString(),
      paidSoFar: paidSoFar.toString(),
      proRataFloor: '0',
      remainingOutputOwed: remainingOutputOwed.toString(),
      requiredMinOutput: '0',
      results: [],
    }
  }

  const params: QuoteParams = {
    chainId,
    rpcUrl:    process.env.ALCHEMY_RPC_URL!,
    tokenIn:   { address: order.input_token,  ...tokenIn  },
    tokenOut:  { address: order.output_token, ...tokenOut },
    amountIn:  rem,
    recipient: order.swapper,
    sender:    process.env.FALLBACK_EXECUTOR!,
  }

  const results = await Promise.all(availableAggregators(chainId).map(async (a): Promise<AggregatorCheckResult> => {
    try {
      const quote = await a.getQuote(params)
      if (!quote) return { key: a.key, name: a.name, ok: false, error: 'No route found' }
      return { key: a.key, name: a.name, ok: true, minAmountOut: quote.minAmountOut.toString(), router: quote.router }
    } catch (e: any) {
      return { key: a.key, name: a.name, ok: false, error: e.message ?? String(e) }
    }
  }))

  return {
    orderHash,
    chainId,
    remainingInput: rem.toString(),
    preferredAggregator: order.preferred_aggregator ?? null,
    minOutputTotal:      minOutputTotal.toString(),
    paidSoFar:            paidSoFar.toString(),
    proRataFloor:         proRataFloor.toString(),
    remainingOutputOwed:  remainingOutputOwed.toString(),
    requiredMinOutput: requiredMinOutput.toString(),
    results,
  }
}

export async function startFallbackWatcher() {
  const provider   = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL)
  const wallet     = new ethers.Wallet(process.env.PRIVATE_KEY!, provider)
  const attempting = new Set<string>() // optimistic lock — prevents duplicate attempts

  const fallbackExecutor = new ethers.Contract(
    process.env.FALLBACK_EXECUTOR!,
    FALLBACK_ABI,
    wallet
  )

  const reactor = new ethers.Contract(
    process.env.PARTIAL_FILL_REACTOR!,
    REACTOR_ABI,
    provider
  )

  const { chainId: networkChainId } = await provider.getNetwork()
  const chainId = resolveAggregatorChainId(networkChainId)
  console.log(`Fallback watcher started (chainId=${chainId}, aggregators=[${availableAggregators(chainId).map(a => a.key).join(', ')}])`)

  setInterval(async () => {
    try {
      // 1. lấy block hiện tại
      const currentBlock = await provider.getBlockNumber()

      // 2. query DB: order nào active + gần deadline + chưa fallback
      const { rows } = await db.query(`
        SELECT * FROM orders
        WHERE status IN ('pending', 'active')
          AND deadline - $1 <= $2
          AND deadline >= $1
          AND fallback_initiated = false
      `, [currentBlock, FALLBACK_WINDOW])

      for (const order of rows) {
        if (attempting.has(order.hash)) continue
        attempting.add(order.hash)
        console.log(`Fallback trigger: ${order.hash}`)

        try {
          // 3. lấy token metadata
          const tokenIn  = TOKEN_META[order.input_token]
          const tokenOut = TOKEN_META[order.output_token]
          if (!tokenIn || !tokenOut) {
            console.warn(`Unknown token: ${order.input_token} / ${order.output_token}`)
            continue
          }

          // 4. query on-chain remaining (may be partial after some fills)
          const orderHash = computeOrderHash(order)
          const remBN: ethers.BigNumber = await reactor.remainingInput(orderHash, order.input_amount)
          const rem = remBN.toBigInt()
          if (rem === 0n) {
            console.log(`Fallback skip ${order.hash}: already fully filled on-chain`)
            continue
          }

          // 5. quote across aggregators (or just the swapper's preferred one)
          // for the remaining amount, not the full inputAmount
          const { aggregator, quote } = await getBestQuote(chainId, order.preferred_aggregator, {
            chainId,
            rpcUrl:    process.env.ALCHEMY_RPC_URL!,
            tokenIn:   { address: order.input_token,  ...tokenIn  },
            tokenOut:  { address: order.output_token, ...tokenOut },
            amountIn:  rem,
            recipient: order.swapper,
            sender:    process.env.FALLBACK_EXECUTOR!,
          })
          console.log(`Fallback route ${order.hash} via ${aggregator}: minOut=${quote.minAmountOut}`)

          // 6. build SignedOrder để truyền vào contract
          const signedOrder = {
            info: {
              swapper:         order.swapper,
              inputToken:      order.input_token,
              inputAmount:     order.input_amount,
              outputToken:     order.output_token,
              minOutputAmount: order.min_output,
              deadline:        order.deadline,
              nonce:           order.nonce,
              minFillBps:      order.min_fill_bps,
              startPrice:      order.start_price,
              decayPerBlock:   order.decay_per_block,
              feeTier:         order.fee_tier
            },
            sig: order.signature
          }

          // 7. gọi FallbackExecutor on-chain
          const tx = await fallbackExecutor.executeFallback(
            signedOrder,
            quote.router,
            quote.calldata,
            quote.minAmountOut
          )
          const receipt = await tx.wait()
          console.log(`Fallback executed: ${tx.hash}`)

          // Pull the real on-chain amountOut off the FallbackExecuted log rather
          // than trusting the pre-trade quote — the actual fill can differ
          // slightly from the quoted floor depending on execution.
          const fallbackLog = receipt.logs
            .map((l: ethers.providers.Log) => { try { return fallbackExecutor.interface.parseLog(l) } catch { return null } })
            .find((p: ethers.utils.LogDescription | null): p is ethers.utils.LogDescription => p?.name === 'FallbackExecuted')
          const actualAmountOut = fallbackLog ? (fallbackLog.args.amountOut as ethers.BigNumber).toString() : quote.minAmountOut.toString()
          const logIndex = receipt.logs.find((l: ethers.providers.Log) => l.address.toLowerCase() === fallbackExecutor.address.toLowerCase())?.logIndex ?? 0

          // 8. update DB
          await db.query(
            'UPDATE orders SET status = $1, fallback_initiated = true WHERE hash = $2',
            ['filled', order.hash]
          )
          await db.query(`
            INSERT INTO fills (id, order_hash, filler, fill_amount, output_amount, tx_hash, block_number, source, aggregator)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'fallback', $8)
            ON CONFLICT (id) DO NOTHING
          `, [
            tx.hash + '_' + logIndex,
            order.hash,
            process.env.FALLBACK_EXECUTOR,
            rem.toString(),
            actualAmountOut,
            tx.hash,
            receipt.blockNumber,
            aggregator,
          ])

        } catch (e) {
          console.error(`Fallback failed for ${order.hash}:`, e)
          attempting.delete(order.hash) // allow retry on genuine failure
        }
      }

    } catch (e) {
      console.error('Watcher error:', e)
    }
  }, 12000) // chạy mỗi 12 giây ~ 1 block
}
