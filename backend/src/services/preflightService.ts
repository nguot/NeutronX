import { ethers } from 'ethers'
import { getChain } from '../config/chains'
import { getCrossChainOrder } from './crosschainService'
import { fillerRegistry } from './fillerRegistry'
import { listTokens } from './tokenService'
import { ESCROW_SRC_FACTORY_ABI, ESCROW_SRC_ABI, ERC20_ABI, SAFETY_DEPOSIT } from '../chain/abis'

export interface PreflightResult {
  orderHash:  string
  slotIndex:  number
  slotStatus: string
  slotAmount: string
  filler:     string
  srcChainId: number
  dstChainId: number
  srcBlock:   number
  dstBlock:   number
  // Dry-run of EscrowSrcFactory.fillSlot() via callStatic — the actual call a
  // filler would send for step 1 of ccFill(), executed against live chain
  // state without sending a transaction. A revert here surfaces *any* reason
  // the real fill would fail (bad signature, expired order, Merkle proof
  // mismatch, insufficient swapper balance/allowance, …) without us having to
  // reimplement the contract's checks.
  srcFill: { ok: boolean; reason?: string }
  // ERC-20 balance the filler needs on the destination chain to fund the
  // EscrowDst clone (step 3 of ccFill). Not covered by srcFill's dry-run since
  // it's a different chain.
  dstBalance: { token: string; have: string; need: string; ok: boolean }
  // Native-token balances for gas + the src-chain safety deposit. "src.need"
  // is a floor (SAFETY_DEPOSIT) — actual gas cost on top of that isn't modeled.
  nativeBalance: {
    src: { have: string; need: string; ok: boolean }
    dst: { have: string; ok: boolean }
  }
  // t2Expiry is the src-chain block by which the dst-chain escrow must be
  // deployed (T1 - t2Buffer, see ccFill.ts step 4). If srcBlock is already
  // past it, deploying the dst escrow would be rejected as expired.
  timing: { t2Expiry: number; ok: boolean }
  fillable: boolean
}

function revertReason(e: any): string {
  return e?.reason ?? e?.error?.reason ?? e?.error?.message ?? e?.message ?? 'fillSlot would revert (unknown reason)'
}

// Read-only preflight for "would ccFill's step 1 (fillSlot on the src chain)
// succeed right now for `filler`, and does the filler have what step 3 (fund
// the dst escrow) needs?" Nothing is sent on-chain — callStatic + getBalance
// are all eth_call/eth_getBalance reads.
export async function preflightFillSlot(
  orderHash: string,
  slotIndex: number,
  filler: string,
): Promise<PreflightResult | null> {
  const order = await getCrossChainOrder(orderHash)
  if (!order) return null
  const slot = order.slots[slotIndex]
  if (!slot) throw new Error(`Slot ${slotIndex} not found in order`)

  const srcChain = getChain(order.chainAId)
  const dstChain = getChain(order.dstChainId)
  const srcProvider = new ethers.providers.JsonRpcProvider(srcChain.rpc)
  const dstProvider = new ethers.providers.JsonRpcProvider(dstChain.rpc)

  const srcFactory = new ethers.Contract(srcChain.escrowSrcFactory, ESCROW_SRC_FACTORY_ABI, srcProvider)
  const tokenDst   = new ethers.Contract(order.outputToken, ERC20_ABI, dstProvider)

  const slotAmount = BigInt(order.minOutput) / BigInt(order.numSlots)

  const [srcBlock, dstBlock, alreadyFilled] = await Promise.all([
    srcProvider.getBlockNumber(),
    dstProvider.getBlockNumber(),
    srcFactory.isSlotFilled(orderHash, slotIndex) as Promise<boolean>,
  ])

  // ── Step 1 dry-run: EscrowSrcFactory.fillSlot() ─────────────────────────
  let srcFill: PreflightResult['srcFill']
  if (alreadyFilled) {
    const escrowAddr: string = await srcFactory.computeAddress(orderHash, slotIndex)
    const existingFiller: string = await new ethers.Contract(escrowAddr, ESCROW_SRC_ABI, srcProvider).filler()
    srcFill = existingFiller.toLowerCase() === filler.toLowerCase()
      ? { ok: true, reason: 'Already filled by this filler — step 1 is done.' }
      : { ok: false, reason: `Slot already filled by a different filler (${existingFiller}).` }
  } else if (!order.swapperSig) {
    srcFill = { ok: false, reason: 'Swapper has not signed the order yet (no swapperSig).' }
  } else {
    const info = {
      swapper: order.swapper, inputToken: order.inputToken, inputAmount: order.inputAmount,
      outputToken: order.outputToken, minOutput: order.minOutput, deadline: order.deadline,
      nonce: order.nonce, merkleRoot: order.merkleRoot, numSlots: order.numSlots,
    }
    try {
      await srcFactory.callStatic.fillSlot(
        info, order.swapperSig, order.cosignerSig, slotIndex, slot.hashlock, slot.proof,
        { value: SAFETY_DEPOSIT, from: filler },
      )
      srcFill = { ok: true }
    } catch (e: any) {
      srcFill = { ok: false, reason: revertReason(e) }
    }
  }

  // ── Step 3 prerequisite: filler's output-token balance on the dst chain ──
  const dstHave: ethers.BigNumber = await tokenDst.balanceOf(filler)
  const dstBalance: PreflightResult['dstBalance'] = {
    token: order.outputToken,
    have:  dstHave.toString(),
    need:  slotAmount.toString(),
    ok:    dstHave.toBigInt() >= slotAmount,
  }

  // ── Native balances for gas + the src-chain safety deposit ──────────────
  const [srcNative, dstNative] = await Promise.all([
    srcProvider.getBalance(filler),
    dstProvider.getBalance(filler),
  ])
  const nativeBalance: PreflightResult['nativeBalance'] = {
    src: { have: srcNative.toString(), need: SAFETY_DEPOSIT.toString(), ok: srcNative.gte(SAFETY_DEPOSIT) },
    dst: { have: dstNative.toString(), ok: dstNative.gt(0) },
  }

  // ── Timing: is there still time to deploy the dst escrow before t2Expiry ─
  const timing: PreflightResult['timing'] = { t2Expiry: order.t2Expiry, ok: srcBlock < order.t2Expiry }

  return {
    orderHash, slotIndex, slotStatus: slot.status, slotAmount: slotAmount.toString(), filler,
    srcChainId: order.chainAId, dstChainId: order.dstChainId, srcBlock, dstBlock,
    srcFill, dstBalance, nativeBalance, timing,
    fillable: srcFill.ok && dstBalance.ok && nativeBalance.src.ok && nativeBalance.dst.ok && timing.ok,
  }
}

export interface FillerBalance {
  name:         string
  address:      string
  balance:      string
  balanceHuman: string
}

// Ranks registered fillers (Admin → Fillers tab) that operate on this order's
// destination chain by their current balance of the slot's output token —
// the Simulate page's "Cross-chain order" tab uses this to suggest which
// filler is most likely to be able to fund the EscrowDst clone (step 3).
// Read-only (balanceOf is an eth_call), same zero-cost reasoning as preflightFillSlot.
export async function rankFillersByOutputBalance(
  orderHash: string,
  slotIndex: number,
): Promise<FillerBalance[] | null> {
  const order = await getCrossChainOrder(orderHash)
  if (!order) return null
  if (!order.slots[slotIndex]) throw new Error(`Slot ${slotIndex} not found in order`)

  const dstChain   = getChain(order.dstChainId)
  const dstProvider = new ethers.providers.JsonRpcProvider(dstChain.rpc)
  const tokenDst   = new ethers.Contract(order.outputToken, ERC20_ABI, dstProvider)

  const tokens   = await listTokens(order.dstChainId)
  const decimals = tokens.find(t => t.address.toLowerCase() === order.outputToken.toLowerCase())?.decimals ?? 18

  const candidates = (await fillerRegistry.list()).filter(f => f.address && f.chains.includes(order.dstChainId))

  const balances: FillerBalance[] = await Promise.all(candidates.map(async f => {
    const bal: ethers.BigNumber = await tokenDst.balanceOf(f.address)
    return { name: f.name, address: f.address, balance: bal.toString(), balanceHuman: ethers.utils.formatUnits(bal, decimals) }
  }))

  return balances.sort((a, b) => {
    const diff = BigInt(b.balance) - BigInt(a.balance)
    return diff > 0n ? 1 : diff < 0n ? -1 : 0
  })
}
