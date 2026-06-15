import { ethers } from 'ethers'
import { db } from '../db/client'
import { availableAggregators, getAggregator, resolveAggregatorChainId, AggregatorQuote, QuoteParams } from '../services/aggregators'
import * as dotenv from 'dotenv'
dotenv.config()

const FALLBACK_WINDOW = 10 // blocks — phải khớp với contract

const FALLBACK_ABI = [
  'function executeFallback(tuple(tuple(address swapper, address inputToken, uint256 inputAmount, address outputToken, uint256 minOutputAmount, uint256 deadline, uint256 nonce, uint16 minFillBps, uint128 startPrice, uint32 decayPerBlock, uint24 feeTier) info, bytes sig) order, address router, bytes routeCalldata, uint256 minAmountOut)'
]

const REACTOR_ABI = [
  'function remainingInput(bytes32 orderHash, uint256 orderAmount) view returns (uint256)'
]

const ORDER_TYPE_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes(
    'PartialFillOrder(' +
    'address swapper,address inputToken,uint256 inputAmount,' +
    'address outputToken,uint256 minOutputAmount,' +
    'uint256 deadline,uint256 nonce,uint16 minFillBps' +
    ')'
  )
)

function computeOrderHash(order: any): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32','address','address','uint256','address','uint256','uint256','uint256','uint16'],
      [ORDER_TYPE_HASH, order.swapper, order.input_token, order.input_amount,
       order.output_token, order.min_output, order.deadline, order.nonce, order.min_fill_bps]
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
          await tx.wait()
          console.log(`Fallback executed: ${tx.hash}`)

          // 8. update DB
          await db.query(
            'UPDATE orders SET status = $1, fallback_initiated = true WHERE hash = $2',
            ['filled', order.hash]
          )

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
