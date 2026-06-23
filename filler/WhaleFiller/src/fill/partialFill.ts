import { ethers } from 'ethers'
import axios from 'axios'
import { BACKEND_URL, FILL_AUCTION, REACTOR } from '../config'
import { FILL_AUCTION_ABI, REACTOR_ABI, ERC20_ABI } from '../contract/abis'
import { wallet } from '../contract/contracts'
import { ensureOutputToken } from '../funding/inventory'
import type { OrderInfo } from '../types'

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

function computeOrderHash(order: OrderInfo): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32','address','address','uint256','address','uint256','uint256','uint256','uint16','uint128','uint32','uint24'],
      [ORDER_TYPE_HASH, order.swapper, order.inputToken, order.inputAmount,
       order.outputToken, order.minOutput, order.deadline, order.nonce, order.minFillBps,
       order.startPrice, order.decayPerBlock, order.feeTier]
    )
  )
}

// Maps PartialFillReactor / FillAuction revert reasons to detailed, actionable
// explanations. Matched by substring (ordered most-specific first) since ethers
// sometimes wraps the raw require() string, e.g. "execution reverted: min output".
function explainRevertReason(rawReason: string, ctx: {
  order: OrderInfo
  fillAmount: bigint
  remaining: bigint
  currentBlock: number
  currentPrice: bigint
  minFill: bigint
}): string {
  const { order, fillAmount, remaining, currentBlock, currentPrice, minFill } = ctx
  const reason = rawReason || ''

  const explanations: [string, string][] = [
    ['min output total',
      `This would be the final chunk, but the order's cumulative output would still fall short of ` +
      `minOutputAmount=${order.minOutput}. This order may be unfillable as configured — the swapper ` +
      `should cancel it and re-create with a less aggressive price curve.`],

    ['min output', (() => {
      const floorPrice = (BigInt(order.minOutput) * 10n ** 18n) / BigInt(order.inputAmount)
      return `The Dutch-auction price has decayed to ${currentPrice} (raw units), but the swapper's minimum ` +
        `acceptable rate is ${floorPrice} (= minOutputAmount * 1e18 / inputAmount). Any fill priced below this ` +
        `floor is rejected. Price only decreases over time (startPrice=${order.startPrice}, ` +
        `decayPerBlock=${order.decayPerBlock}), so once it drops below the floor the remaining ${remaining} can ` +
        `never be filled — this order is effectively dead. The swapper should cancel it and create a new order ` +
        `with startPrice comfortably above minOutputAmount and/or a smaller decayPerBlock.`
    })()],

    ['fill < minimum',
      `Requested fill (${fillAmount}) is below this order's minimum chunk size ` +
      `(${minFill} = ${order.minFillBps / 100}% of total input ${order.inputAmount}).`],

    ['fill > remaining',
      `Requested fill (${fillAmount}) exceeds what's left unfilled (${remaining}).`],

    ['fill > total',
      `Requested fill (${fillAmount}) exceeds the order's total input amount (${order.inputAmount}).`],

    ['not registered',
      `You have not registered (or registered for less than fillAmount=${fillAmount}) for this order. ` +
      `register() must succeed before executePartialChunk().`],

    ['already registered',
      `This filler already registered/filled this order. Each filler can only fill an order once — ` +
      `use the other filler for a second partial fill.`],

    ['fallback initiated',
      `This order already fell back to the cross-chain fallback path and can no longer take partial fills here.`],

    ['nonce invalidated',
      `The swapper invalidated nonce ${order.nonce} for this order (e.g. by cancelling). It can no longer be filled.`],

    ['already cancelled',
      `This order was already cancelled by the swapper.`],

    ['cancelled',
      `The swapper cancelled this order. It can no longer be filled.`],

    ['invalid sig recovery',
      `The order's cosigner signature could not be recovered to any address — the signature data is malformed.`],

    ['invalid sig',
      `The cosigner signature does not match the current PartialFillReactor's domain separator — likely a ` +
      `stale order signed against a previously-deployed reactor (e.g. after a redeploy via setup.sh). ` +
      `Cancel this order and create a new one.`],

    ['deadline passed',
      `Order expired: deadline was block #${order.deadline}, current block is #${currentBlock}. ` +
      `This order can no longer be filled by anyone.`],

    ['expired',
      `Order expired: deadline was block #${order.deadline}, current block is #${currentBlock}. ` +
      `This order can no longer be filled by anyone.`],

    ['insufficient stake',
      `The ETH collateral sent was less than the auction currently requires — price/volatility moved since ` +
      `the stake was previewed. Try again.`],

    ['zero fill',
      `Computed fill amount is zero — internal bug in the filler's sizing logic.`],

    ['fill overflow',   `Internal overflow guard tripped ("${reason}") — fillAmount is unexpectedly large.`],
    ['fill too large',  `Internal overflow guard tripped ("${reason}") — fillAmount is unexpectedly large.`],
    ['total too large', `Internal overflow guard tripped ("${reason}") — order's inputAmount is unexpectedly large.`],
    ['stake too large', `Internal overflow guard tripped ("${reason}") — required stake is unexpectedly large.`],
  ]

  for (const [key, explanation] of explanations) {
    if (reason.includes(key)) return explanation
  }
  return reason || 'unknown revert reason'
}

async function getContracts() {
  if (!REACTOR || !FILL_AUCTION) {
    throw new Error('PARTIAL_FILL_REACTOR / FILL_AUCTION not set in .env — run tests/demo/setup.sh first')
  }
  const code = await wallet.provider!.getCode(REACTOR)
  if (code === '0x') {
    throw new Error(
      `No contract at PartialFillReactor address ${REACTOR}.\n` +
      `Run: bash tests/demo/setup.sh   (then restart this filler)`
    )
  }
  return {
    reactor:     new ethers.Contract(REACTOR,      REACTOR_ABI,      wallet),
    fillAuction: new ethers.Contract(FILL_AUCTION, FILL_AUCTION_ABI, wallet),
  }
}

// Register (if needed) + executePartialChunk for `fillBps` (in 1/100 of a
// percent of the order's *remaining* input) on the given backend order hash.
// Returns the settlement tx hash. Throws with an actionable message on revert.
export async function fill(orderBackendHash: string, fillBps: number): Promise<string> {
  const { reactor, fillAuction } = await getContracts()

  const { data: order } = await axios.get<OrderInfo>(`${BACKEND_URL}/orders/${orderBackendHash}`)
  const currentBlock    = await wallet.provider!.getBlockNumber()
  const orderHash       = computeOrderHash(order)

  // Compute remaining from backend fill data (avoids calling remainingInput on a potentially stale address)
  const totalFilled = (order.fills ?? []).reduce(
    (sum: bigint, f: any) => sum + BigInt(f.fillAmount ?? '0'), 0n
  )
  const remaining = BigInt(order.inputAmount) - totalFilled
  if (remaining <= 0n) throw new Error('order already fully filled')

  const requested  = (remaining * BigInt(fillBps)) / 10_000n
  const minFill    = (BigInt(order.inputAmount) * BigInt(order.minFillBps)) / 10_000n
  // Bump up to the order's min chunk, but never exceed what's left — when the
  // remainder is below minFill, the final chunk completes the order at < minFill.
  let fillAmount   = requested < minFill ? minFill : requested
  if (fillAmount > remaining) fillAmount = remaining

  const firstFillBlock = order.fills.length > 0
    ? (order.fills[order.fills.length - 1].blockNumber ?? currentBlock)
    : currentBlock
  const blocksPassed = BigInt(Math.max(0, currentBlock - firstFillBlock))
  const startPrice   = BigInt(order.startPrice)
  const decay        = blocksPassed * BigInt(order.decayPerBlock)
  const currentPrice = startPrice > decay ? startPrice - decay : 1n

  const outputAmount = (fillAmount * currentPrice) / 10n**18n
  const withBuffer   = outputAmount + outputAmount / 10n

  await ensureOutputToken(order.outputToken, withBuffer)

  const erc20Token = new ethers.Contract(order.outputToken, ERC20_ABI, wallet)
  const allowed = (await erc20Token.allowance(wallet.address, reactor.address)).toBigInt()
  if (allowed < withBuffer) {
    const tx = await erc20Token.approve(reactor.address, ethers.constants.MaxUint256)
    await tx.wait()
    console.log(`[fill] approved ${order.outputToken}`)
  }

  // D-1: ask the auction for the exact ETH collateral (handles TWAP + decimals).
  const stake = (await fillAuction.previewCollateral(
    order.inputToken, order.feeTier, fillAmount, order.deadline
  )).toBigInt()

  const signedOrder = {
    info: {
      swapper:         order.swapper,
      inputToken:      order.inputToken,
      inputAmount:     ethers.BigNumber.from(order.inputAmount),
      outputToken:     order.outputToken,
      minOutputAmount: ethers.BigNumber.from(order.minOutput),
      deadline:        order.deadline,
      nonce:           order.nonce,
      minFillBps:      order.minFillBps,
      startPrice:      ethers.BigNumber.from(order.startPrice),
      decayPerBlock:   order.decayPerBlock,
      feeTier:         order.feeTier,
    },
    sig: order.signature,
  }

  const alreadyValid = await fillAuction.hasValidRegistration(
    orderHash, wallet.address, ethers.BigNumber.from(fillAmount)
  )
  if (!alreadyValid) {
    const regTx = await reactor.register(
      signedOrder,
      ethers.BigNumber.from(fillAmount),
      { value: ethers.BigNumber.from(stake) }
    ).catch((e: any) => {
      const reason: string = e?.error?.reason ?? e?.reason ?? e?.message ?? ''
      throw new Error(`Register would revert: ${explainRevertReason(reason, { order, fillAmount, remaining, currentBlock, currentPrice, minFill })}`)
    })
    await regTx.wait()
    console.log(`[fill] registered  fill=${fillAmount}  stake=${ethers.utils.formatEther(stake)} ETH`)
  } else {
    console.log('[fill] valid registration already exists — skipping register')
  }

  await reactor.callStatic.executePartialChunk(signedOrder, ethers.BigNumber.from(fillAmount))
    .catch((e: any) => {
      const reason: string = e?.reason ?? e?.error?.reason ?? e?.message ?? String(e)
      throw new Error(`Fill would revert: ${explainRevertReason(reason, { order, fillAmount, remaining, currentBlock, currentPrice, minFill })}`)
    })

  const tx = await reactor.executePartialChunk(signedOrder, ethers.BigNumber.from(fillAmount))
  await tx.wait()
  console.log(`[fill] ✔ filled  tx=${tx.hash}`)
  return tx.hash
}
