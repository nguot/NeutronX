import { ethers } from 'ethers'
import { getChain } from '../config/chains'
import { getFillById, getCrossChainOrder } from './crosschainService'
import { fillerRegistry } from './fillerRegistry'
import { listTokens } from './tokenService'
import { ESCROW_SRC_FACTORY_ABI, ERC20_ABI } from '../chain/abis'

export interface PreflightResult {
  fillId:     number
  fillStatus: string
  fillAmount: string
  filler:     string
  srcChainId: number
  dstChainId: number
  srcBlock:   number
  dstBlock:   number
  // Dry-run of EscrowSrcFactory.fillSlot() via callStatic — only meaningful
  // once BOTH signatures are recorded (fill status 'authorized' or later).
  // A revert here surfaces the real reason a fillSlot tx would fail, without
  // reimplementing the contract's checks.
  srcFill: { ok: boolean; reason?: string }
  // ERC-20 balance the filler needs on the destination chain to fund the
  // EscrowDst clone (must happen BEFORE fillSlot in Model 2's ordering).
  dstBalance: { token: string; have: string; need: string; ok: boolean }
  fillable: boolean
}

function revertReason(e: any): string {
  return e?.reason ?? e?.error?.reason ?? e?.error?.message ?? e?.message ?? 'fillSlot would revert (unknown reason)'
}

// Read-only preflight for "would fillSlot succeed right now for `filler`?" and
// "does the filler have what funding the dest escrow needs?" Nothing is sent
// on-chain. Only meaningful for an already-'authorized' fill (both the order
// intent and the per-fill FillAuth are signed) — Model 2 requires the
// swapper's live participation before a real fillSlot call is even
// constructible, unlike Model 1's pre-computed Merkle proofs.
export async function previewFill(fillId: number, filler: string): Promise<PreflightResult | null> {
  const fill = await getFillById(fillId)
  if (!fill) return null

  const srcChain = getChain(fill.order.chainAId)
  const dstChain = getChain(fill.order.dstChainId)
  const srcProvider = new ethers.providers.JsonRpcProvider(srcChain.rpc)
  const dstProvider = new ethers.providers.JsonRpcProvider(dstChain.rpc)

  const srcFactory = new ethers.Contract(srcChain.escrowSrcFactory, ESCROW_SRC_FACTORY_ABI, srcProvider)
  const tokenDst   = new ethers.Contract(fill.order.outputToken, ERC20_ABI, dstProvider)

  const [srcBlock, dstBlock] = await Promise.all([
    srcProvider.getBlockNumber(),
    dstProvider.getBlockNumber(),
  ])

  // ── Step 1 dry-run: EscrowSrcFactory.fillSlot() ─────────────────────────
  let srcFill: PreflightResult['srcFill']
  if (!fill.order.swapperSig || !fill.swapperSig) {
    srcFill = { ok: false, reason: `Fill is '${fill.status}' — swapper has not yet signed this fill (no per-fill swapperSig).` }
  } else {
    const info = {
      swapper: fill.order.swapper, inputToken: fill.order.inputToken, inputAmount: fill.order.inputAmount,
      outputToken: fill.order.outputToken, minOutput: fill.order.minOutput,
      deadlineBase: fill.order.deadlineBase, nonce: fill.order.nonce, feeTier: fill.order.feeTier,
    }
    const auth = {
      orderHash: fill.orderHash, hashlock: fill.hashlock,
      fillAmount: fill.fillAmount, t1: fill.t1, t2: fill.t2,
    }
    try {
      const required: ethers.BigNumber = await srcFactory.previewRequiredStake(
        fill.fillAmount, fill.order.inputToken, fill.order.feeTier, fill.t1
      )
      await srcFactory.callStatic.fillSlot(info, fill.order.swapperSig, auth, fill.swapperSig, {
        from: filler, value: required,
      })
      srcFill = { ok: true }
    } catch (e: any) {
      srcFill = { ok: false, reason: revertReason(e) }
    }
  }

  // ── Step: filler's output-token balance on the dst chain ──────────────
  const dstHave: ethers.BigNumber = await tokenDst.balanceOf(filler)
  const need = BigInt(fill.fillAmount)
  const dstBalance: PreflightResult['dstBalance'] = {
    token: fill.order.outputToken,
    have:  dstHave.toString(),
    need:  need.toString(),
    ok:    dstHave.toBigInt() >= need,
  }

  return {
    fillId, fillStatus: fill.status, fillAmount: fill.fillAmount, filler,
    srcChainId: fill.order.chainAId, dstChainId: fill.order.dstChainId, srcBlock, dstBlock,
    srcFill, dstBalance,
    fillable: srcFill.ok && dstBalance.ok,
  }
}

export interface FillerBalance {
  name:         string
  address:      string
  balance:      string
  balanceHuman: string
}

// Ranks registered fillers (Admin → Fillers tab) that operate on this order's
// destination chain by their current balance of the order's output token —
// suggests which filler is most likely to be able to fund a dest escrow.
export async function rankFillersByOutputBalance(orderHash: string): Promise<FillerBalance[] | null> {
  const order = await getCrossChainOrder(orderHash)
  if (!order) return null

  const dstChain    = getChain(order.dstChainId)
  const dstProvider  = new ethers.providers.JsonRpcProvider(dstChain.rpc)
  const tokenDst     = new ethers.Contract(order.outputToken, ERC20_ABI, dstProvider)

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
