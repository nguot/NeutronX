import { ethers } from 'ethers'
import axios from 'axios'
import { BACKEND_URL, DEV_MODE, INVENTORY } from '../config'
import { devEnsureOutputToken } from '../dev/devFund'
import { wallet, fillAuction, reactor, erc20 } from '../contract/contracts'
import { decide } from '../strategy/strategy'
import type { OrderInfo } from '../types'

// Replicates PartialFillReactor._hashOrder
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

function toSignedOrder(order: OrderInfo) {
  return {
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
}

// Stake bucket helpers (mirrors DynamicStakeLib)
function getOrderSizeBucket(total: bigint): number {
  if (total < 10_000n * 10n**6n) return 0; if (total < 100_000n * 10n**6n) return 1; if (total < 1_000_000n * 10n**6n) return 2; return 3
}
function getTimeMultiplier(deadline: number, currentBlock: number): number {
  const left = deadline - currentBlock
  if (left > 50) return 10_000; if (left > 20) return 15_000; if (left > 5) return 30_000; return 50_000
}
async function computeRequiredStake(order: OrderInfo, fill: bigint): Promise<bigint> {
  // D-1: exact ETH collateral from the auction (TWAP + decimals handled on-chain).
  return (await fillAuction.previewCollateral(
    order.inputToken, order.feeTier, fill, order.deadline
  )).toBigInt()
}

async function ensureApproval(tokenAddress: string, amount: bigint): Promise<void> {
  const token    = erc20(tokenAddress)
  const allowed: ethers.BigNumber = await token.allowance(wallet.address, reactor.address)
  if (allowed.toBigInt() < amount) {
    const tx = await token.approve(reactor.address, ethers.constants.MaxUint256)
    await tx.wait()
    console.log(`[Executor] approved ${tokenAddress}`)
  }
}

interface Registration { fillAmount: bigint; registeredAt: number }

export class Executor {
  private watching   = new Map<string, OrderInfo>()
  private registered = new Map<string, Registration>()

  watch(order: OrderInfo): void {
    if (this.watching.has(order.hash)) return
    this.watching.set(order.hash, order)
    console.log(`[Executor] +watch  ${order.hash.slice(0,10)}…  watching=${this.watching.size}`)
  }

  async onBlock(currentBlock: number): Promise<void> {
    const active = [...this.watching.values()].filter(o => o.deadline - currentBlock <= INVENTORY.REGISTER_AT_BLOCKS_LEFT * 3)
    const idle   = this.watching.size - active.length
    if (active.length > 0 || this.registered.size > 0)
      console.log(`[Executor] block #${currentBlock}  active=${active.length}  registered=${this.registered.size}  idle=${idle}`)

    for (const [hash, order] of this.watching) {
      if (currentBlock > order.deadline) {
        console.log(`[Executor] expired  ${hash.slice(0,10)}… — dropping`)
        this.watching.delete(hash)
        this.registered.delete(hash)
        continue
      }
      const blocksLeft = order.deadline - currentBlock
      if (blocksLeft > INVENTORY.REGISTER_AT_BLOCKS_LEFT * 3) continue  // too early, skip silently
      await this.tryFill(order, currentBlock).catch(e =>
        console.error(`[Executor] error on ${hash.slice(0,10)}…: ${(e as any)?.reason ?? (e as any)?.message ?? e}`)
      )
    }
  }

  private async tryFill(cachedOrder: OrderInfo, currentBlock: number): Promise<void> {
    const tag = `[Executor] ${cachedOrder.hash.slice(0,10)}…`

    // Re-fetch fresh order so fills list (decay cursor) is current
    let order = cachedOrder
    try {
      const { data } = await axios.get<OrderInfo>(`${BACKEND_URL}/orders/${cachedOrder.hash}`)
      order = data
      this.watching.set(order.hash, order)
    } catch {
      console.warn(`${tag} backend unreachable — using cached order`)
    }

    const hash       = order.hash
    const orderHash  = computeOrderHash(order)
    const signedOrder = toSignedOrder(order)

    // Check on-chain remaining — drop if already fully filled
    const remainingBN: ethers.BigNumber = await reactor.remainingInput(orderHash, order.inputAmount)
    const onChainRemaining = remainingBN.toBigInt()
    const remainingPct = (Number(onChainRemaining) / Number(order.inputAmount) * 100).toFixed(1)
    console.log(`${tag} on-chain remaining=${remainingPct}%  blocksLeft=${order.deadline - currentBlock}`)

    if (onChainRemaining === 0n) {
      await this.reclaimStake(order, orderHash, 'fully filled by others')
      this.watching.delete(hash); this.registered.delete(hash); return
    }

    if (this.registered.has(hash) && await reactor.isCancelled(orderHash)) {
      await this.reclaimStake(order, orderHash, 'cancelled')
      this.watching.delete(hash); this.registered.delete(hash); return
    }

    const blocksLeft = order.deadline - currentBlock

    // ── REGISTER PHASE ────────────────────────────────────────────────────
    if (!this.registered.has(hash) && blocksLeft <= INVENTORY.REGISTER_AT_BLOCKS_LEFT) {
      console.log(`${tag} REGISTER PHASE  blocksLeft=${blocksLeft}`)
      const decision = await decide(order, currentBlock)
      if (!decision.shouldFill) {
        console.log(`${tag} skip register — ${decision.reason}`)
        return
      }

      const fillAmount = decision.fillAmount < onChainRemaining
        ? decision.fillAmount : onChainRemaining

      const stake = await computeRequiredStake(order, fillAmount)

      // Optimistic lock — prevents duplicate tx when multiple blocks fire before first tx mines
      this.registered.set(hash, { fillAmount, registeredAt: currentBlock })

      console.log(`${tag} registering  fill=${fillAmount}  stake=${ethers.utils.formatEther(stake)} ETH  tx pending…`)
      try {
        const tx = await reactor.register(signedOrder, fillAmount, { value: stake })
        await tx.wait()
        console.log(`${tag} ✔ registered  tx=${tx.hash}  stakeETH=${ethers.utils.formatEther(stake)}`)
      } catch (e: any) {
        const reason: string = e?.error?.reason ?? e?.reason ?? e?.message ?? ''
        if (reason.includes('already registered')) {
          console.log(`${tag} already registered on-chain — recovering in-memory state`)
        } else {
          this.registered.delete(hash)
          throw e
        }
      }
      return
    }

    // ── EXECUTE PHASE ─────────────────────────────────────────────────────
    if (this.registered.has(hash)) {
      const { fillAmount: registeredFill, registeredAt } = this.registered.get(hash)!
      const fillAmount = registeredFill < onChainRemaining ? registeredFill : onChainRemaining
      console.log(`${tag} EXECUTE PHASE  registeredAt=block#${registeredAt}  fillAmount=${fillAmount}`)

      const decision = await decide(order, currentBlock)
      if (!decision.shouldFill) {
        console.log(`${tag} holding — ${decision.reason}`)
        return
      }

      // Expected output: fillAmount * currentPrice / 1e18 (reactor will demand this from filler)
      const expectedOutput = (fillAmount * decision.currentPrice) / 10n**18n
      if (DEV_MODE) await devEnsureOutputToken(order.outputToken, expectedOutput)
      await ensureApproval(order.outputToken, expectedOutput)

      console.log(`${tag} calling executePartialChunk  fillAmount=${fillAmount}  tx pending…`)
      const tx = await reactor.executePartialChunk(signedOrder, fillAmount)
      await tx.wait()
      console.log(`${tag} ✔ FILLED  tx=${tx.hash}`)
      console.log(`${tag}   reason: ${decision.reason}`)

      this.watching.delete(hash)
      this.registered.delete(hash)
      console.log(`${tag} done  watching=${this.watching.size}  registered=${this.registered.size}`)
    }
  }

  /// We registered (staked) for this order but did not win the fill — the order
  /// was satisfied by another filler or cancelled. Under the new contract the
  /// stake stays locked until releaseRegistration moves it to pendingReturns;
  /// the periodic withdraw() then returns it. Without this, lost-race stake
  /// would be stuck forever.
  private async reclaimStake(order: OrderInfo, orderHash: string, why: string): Promise<void> {
    const tag = `[Executor] ${order.hash.slice(0,10)}…`
    if (!this.registered.has(order.hash)) { console.log(`${tag} ${why} — dropping`); return }
    try {
      const tx = await fillAuction.releaseRegistration(orderHash, wallet.address)
      await tx.wait()
      console.log(`${tag} ${why} — released stake, reclaim via withdraw()`)
    } catch {
      console.log(`${tag} ${why} — drop (stake already resolved)`)
    }
  }
}
