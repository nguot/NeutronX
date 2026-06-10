import { ethers } from 'ethers'
import axios from 'axios'
import { DEV_MODE, STRATEGY, BACKEND_URL } from '../config'
import { wallet, fillAuction, reactor, erc20 } from '../contract/contracts'
import { decide } from '../strategy/strategy'
import { buildPath } from '../graph/pathBuilder'
import { devEnsureOutputToken } from '../dev/devFund'
import type { OrderInfo } from '../types'

// Replicates PartialFillReactor._hashOrder
// keccak256(abi.encode(ORDER_TYPE_HASH, swapper, inputToken, inputAmount,
//                      outputToken, minOutputAmount, deadline, nonce, minFillBps))
// NOTE: startPrice / decayPerBlock / feeTier are NOT part of the signed hash
const ORDER_TYPE_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes(
    'PartialFillOrder(' +
    'address swapper,address inputToken,uint256 inputAmount,' +
    'address outputToken,uint256 minOutputAmount,' +
    'uint256 deadline,uint256 nonce,uint16 minFillBps' +
    ')'
  )
)

function computeOrderHash(order: OrderInfo): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint16'],
      [
        ORDER_TYPE_HASH,
        order.swapper,
        order.inputToken,
        order.inputAmount,
        order.outputToken,
        order.minOutput,
        order.deadline,
        order.nonce,
        order.minFillBps,
      ]
    )
  )
}

// Replicates DynamicStakeLib bucket helpers
function getFillRatioBucket(fill: bigint, total: bigint): number {
  if (fill >= total) return 4
  const pct = Number((fill * 100n) / total)
  if (pct < 2)  return 0
  if (pct < 10) return 1
  if (pct < 30) return 2
  if (pct < 70) return 3
  return 4
}

function getOrderSizeBucket(total: bigint): number {
  if (total < 10_000n * 10n ** 6n)     return 0
  if (total < 100_000n * 10n ** 6n)    return 1
  if (total < 1_000_000n * 10n ** 6n)  return 2
  return 3
}

function getTimeBucket(deadline: number, currentBlock: number): number {
  if (currentBlock >= deadline) return 3
  const left = deadline - currentBlock
  if (left > 50) return 0
  if (left > 20) return 1
  if (left > 5)  return 2
  return 3
}

function getTimeMultiplier(tBucket: number): number {
  if (tBucket === 0) return 10_000
  if (tBucket === 1) return 15_000
  if (tBucket === 2) return 30_000
  return 50_000
}

async function computeRequiredStake(
  fillAmount:   bigint,
  orderTotal:   bigint,
  deadline:     number,
  currentBlock: number
): Promise<bigint> {
  const sBucket = getOrderSizeBucket(orderTotal)
  const rBucket = getFillRatioBucket(fillAmount, orderTotal)
  const tBucket = getTimeBucket(deadline, currentBlock)

  const multBps: number = await fillAuction.stakeTable(sBucket, rBucket)
  if (multBps === 0) return 0n

  const timeMult = getTimeMultiplier(tBucket)
  return (fillAmount * BigInt(multBps) / 10_000n) * BigInt(timeMult) / 10_000n
}

async function ensureApproval(tokenAddress: string, amount: bigint): Promise<void> {
  const token     = erc20(tokenAddress)
  const allowance: ethers.BigNumber = await token.allowance(wallet.address, reactor.address)
  if (allowance.toBigInt() < amount) {
    const tx = await token.approve(reactor.address, ethers.constants.MaxUint256)
    await tx.wait()
    console.log(`[Executor] approved ${tokenAddress} to reactor`)
  }
}

// Reports the fill path back to the backend so fills.path is populated.
// TODO: backend needs to implement POST /fills/:txHash/path to receive this.
async function reportPath(txHash: string, steps: unknown[]): Promise<void> {
  try {
    await axios.post(`${BACKEND_URL}/fills/${txHash}/path`, { steps })
  } catch {
    console.warn(`[Executor] path report not received by server (endpoint may not exist yet)`)
    console.log(`[Executor] path for ${txHash}:`, JSON.stringify(steps))
  }
}

// ── Main Executor class ───────────────────────────────────────────────────────

interface Registration {
  fillAmount:   bigint
  registeredAt: number
}

export class Executor {
  private watching   = new Map<string, OrderInfo>()
  private registered = new Map<string, Registration>()

  watch(order: OrderInfo): void {
    if (this.watching.has(order.hash)) return
    this.watching.set(order.hash, order)
    console.log(`[Executor] watching ${order.hash}`)
  }

  async onBlock(currentBlock: number): Promise<void> {
    for (const [hash, order] of this.watching) {
      if (currentBlock > order.deadline) {
        console.log(`[Executor] order ${hash} expired — dropping`)
        this.watching.delete(hash)
        this.registered.delete(hash)
        continue
      }
      await this.tryFill(order, currentBlock).catch(e =>
        console.error(`[Executor] error on ${hash}:`, e)
      )
    }
  }

  private async tryFill(cachedOrder: OrderInfo, currentBlock: number): Promise<void> {
    // #7: Re-fetch fresh order so fills list is current (decay calc depends on first fill block)
    let order = cachedOrder
    try {
      const { data } = await axios.get<OrderInfo>(`${BACKEND_URL}/orders/${cachedOrder.hash}`)
      order = data
      this.watching.set(order.hash, order)
    } catch {
      // fall back to cached copy if API unavailable
    }

    const hash      = order.hash
    const orderHash = computeOrderHash(order)

    // #5: Read on-chain remaining — drop if already fully filled by another filler
    const remainingBN: ethers.BigNumber = await reactor.remainingInput(orderHash, order.inputAmount)
    const onChainRemaining = remainingBN.toBigInt()
    if (onChainRemaining === 0n) {
      console.log(`[Executor] ${hash} fully filled on-chain — dropping`)
      this.watching.delete(hash)
      this.registered.delete(hash)
      return
    }

    const blocksLeft = order.deadline - currentBlock

    // ── REGISTER PHASE ──────────────────────────────────────────────────────
    if (!this.registered.has(hash) && blocksLeft <= STRATEGY.REGISTER_AT_BLOCKS_LEFT) {
      const decision = await decide(order, currentBlock)
      if (!decision.shouldFill) {
        console.log(`[Executor] skip register ${hash}: ${decision.reason}`)
        return
      }

      // cap fill to what's actually remaining on-chain
      const fillAmount = decision.fillAmount < onChainRemaining
        ? decision.fillAmount
        : onChainRemaining

      const stake = await computeRequiredStake(
        fillAmount,
        BigInt(order.inputAmount),
        order.deadline,
        currentBlock
      )

      const tx = await fillAuction.register(
        orderHash,
        fillAmount,
        order.inputAmount,
        order.deadline,
        { value: stake }
      )
      await tx.wait()

      this.registered.set(hash, { fillAmount, registeredAt: currentBlock })
      console.log(`[Executor] registered ${hash} | fillAmount=${fillAmount} stake=${stake}`)
      return
    }

    // ── EXECUTE PHASE ───────────────────────────────────────────────────────
    if (this.registered.has(hash)) {
      const { fillAmount: registeredFill } = this.registered.get(hash)!
      // cap again — partial fills by others may have reduced remaining since registration
      const fillAmount = registeredFill < onChainRemaining
        ? registeredFill
        : onChainRemaining

      const decision = await decide(order, currentBlock)
      if (!decision.shouldFill) {
        console.log(`[Executor] holding ${hash}: ${decision.reason}`)
        return
      }

      const path = await buildPath(order, fillAmount, decision.currentPrice)

      if (DEV_MODE) await devEnsureOutputToken(order.outputToken, path.outputAmount)
      await ensureApproval(order.outputToken, path.outputAmount)

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

      const tx = await reactor.executePartialChunk(signedOrder, fillAmount)
      await tx.wait()

      console.log(`[Executor] filled ${hash} | tx=${tx.hash} | reason=${decision.reason}`)

      await reportPath(tx.hash, path.steps)

      this.watching.delete(hash)
      this.registered.delete(hash)
    }
  }
}
