import { ethers } from 'ethers'
import { http as axios } from '../httpClient'
import {
  BACKEND_URL, ESCROW_SRC_FACTORY, CHAIN_B_RPC, CHAIN_B_FACTORY,
  CHAIN_B_ESCROW_SRC_FACTORY, CHAIN_A_DST_FACTORY,
} from '../config'
import { ESCROW_SRC_FACTORY_ABI, ESCROW_SRC_ABI, ESCROW_FACTORY_ABI, ERC20_ABI } from '../contract/abis'
import { wallet } from '../contract/contracts'
import { saveSecret, loadSecret } from './secretStore'

// ─────────────────────────────────────────────────────────────────────────────
// Model 2 (filler-holds-key, continuous fill) — see
// CROSSCHAIN_INTENT_REDESIGN_HUONG_PHAT_TRIEN.md at the repo root.
//
// Reversed from Model 1 in three ways:
//   1. The FILLER generates its own secret/hashlock (not the backend) — the
//      backend never sees it until it's revealed on-chain.
//   2. The filler funds the DESTINATION escrow FIRST, before the swapper ever
//      authorizes pulling the source input — the deterministic defense
//      against "hủi hút TokenA rồi không fund dest" (see EscrowSrcFactory's
//      file header, "TWO SWAPPER SIGNATURES").
//   3. Timelocks (t1/t2) are unix timestamps, not block numbers — no more
//      rebaseBlockNumber (two independently-mined chains needed that only
//      because block counts aren't comparable across chains; timestamps are).
// ─────────────────────────────────────────────────────────────────────────────

const CHAIN_A_ID = 31337
const CHAIN_B_ID = 31338

// Filler's own margin before its chosen T1 gets close to the order's
// deadlineBase ceiling, and how far T2 sits after T1 — must exceed the
// destination chain's finality lag (doc §3: buffer = finality of chain B).
const T1_BUFFER_SECONDS = 300
const T2_BUFFER_SECONDS = 120

const STATUS_POLL_INTERVAL_MS = 3_000
const STATUS_WAIT_TIMEOUT_MS  = 300_000

// Minimum wall-clock margin required before T1 to still (a) create EscrowSrc
// or (b) reveal the secret — T1 may have been revised by the swapper after
// this filler quoted it (see backend crosschainService.setFillSwapperSig), so
// the value in `fill` fetched right before each step is what's checked, not
// the filler's own original T1_BUFFER_SECONDS guess. `--force` bypasses this.
const DEFAULT_MIN_MARGIN_SECONDS = 60

export interface CrossChainFillOptions {
  minMarginSeconds?: number
  force?: boolean
}

// Throws (aborting the step that hasn't happened yet) if `targetSec` is
// closer than `minMarginSeconds` away — unless `force` is set. Creating
// EscrowSrc this close to T1 risks the reveal tx not confirming in time,
// which forfeits the bond (grief-lock, doc §4 attack #4) for no gain; not
// revealing after EscrowSrc already exists risks the same, so `--force` lets
// an operator explicitly accept that risk instead of the bot deciding alone.
function assertTimeMargin(label: string, targetSec: number, opts?: CrossChainFillOptions) {
  const minMargin = opts?.minMarginSeconds ?? DEFAULT_MIN_MARGIN_SECONDS
  const remaining = targetSec - Math.floor(Date.now() / 1000)
  if (remaining >= minMargin) return
  if (opts?.force) {
    console.log(`[crossChainFill]     ⚠ ${label}: only ${remaining}s left before T1 (< ${minMargin}s margin) — proceeding anyway (--force)`)
    return
  }
  throw new Error(
    `${label}: only ${remaining}s left before T1 (< ${minMargin}s required margin) — aborting to avoid a tx that ` +
    `might not confirm in time. Re-run with --force to proceed anyway, or --min-margin-sec to change the threshold.`
  )
}

interface ChainLegs {
  srcProvider:    ethers.providers.Provider
  srcWallet:      ethers.Wallet
  srcFactoryAddr: string
  dstProvider:    ethers.providers.Provider
  dstWallet:      ethers.Wallet
  dstFactoryAddr: string
}

// An order's chainAId tells us which chain plays the "src" (EscrowSrcFactory)
// role for THIS order — the other chain plays "dst" (EscrowDstFactory).
function resolveLegs(chainAId: number): ChainLegs {
  const providerA = wallet.provider!
  const providerB = new ethers.providers.JsonRpcProvider(CHAIN_B_RPC)
  const walletB   = wallet.connect(providerB)

  if (chainAId === CHAIN_A_ID) {
    return {
      srcProvider: providerA, srcWallet: wallet,  srcFactoryAddr: ESCROW_SRC_FACTORY,
      dstProvider: providerB, dstWallet: walletB, dstFactoryAddr: CHAIN_B_FACTORY,
    }
  }
  if (chainAId === CHAIN_B_ID) {
    return {
      srcProvider: providerB, srcWallet: walletB, srcFactoryAddr: CHAIN_B_ESCROW_SRC_FACTORY,
      dstProvider: providerA, dstWallet: wallet,  dstFactoryAddr: CHAIN_A_DST_FACTORY,
    }
  }
  throw new Error(`Unsupported chainAId ${chainAId} — this filler only supports Chain A (${CHAIN_A_ID}) / Chain B (${CHAIN_B_ID})`)
}

// ── Entry point 1: start a brand-new fill ─────────────────────────────────────
// `pctOfRemaining` mirrors the single-chain `fill <hash> <pct>` UX — the
// filler asks for a percentage of what's still fillable, not a raw amount.
export async function crossChainFill(orderHash: string, pctOfRemaining: number, opts?: CrossChainFillOptions): Promise<string> {
  if (!CHAIN_B_RPC) {
    throw new Error(
      'CHAIN_B_RPC not set in .env\n' +
      'Run: bash tests/crosschain/setup_cc.sh   (then restart this filler)'
    )
  }

  const { data: order } = await axios.get(`${BACKEND_URL}/cc/orders/${orderHash}`)
  if (!order.swapperSig) {
    throw new Error(`Order ${orderHash.slice(0, 10)}… has no swapperSig yet — the swapper hasn't signed the intent`)
  }

  const legs = resolveLegs(order.chainAId)
  const srcFactory = new ethers.Contract(legs.srcFactoryAddr, ESCROW_SRC_FACTORY_ABI, legs.srcProvider)
  const remaining: ethers.BigNumber = await srcFactory.remainingInput(orderHash, order.inputAmount)
  if (remaining.isZero()) throw new Error(`Order ${orderHash.slice(0, 10)}… has nothing left to fill`)

  const fillAmount = (remaining.toBigInt() * BigInt(Math.round(pctOfRemaining * 100))) / 10_000n
  if (fillAmount <= 0n) throw new Error(`${pctOfRemaining}% of remaining (${remaining}) rounds to zero`)

  // ── Filler generates its OWN secret — the backend never sees it ──────────
  const secret   = ethers.utils.hexlify(ethers.utils.randomBytes(32))
  const hashlock = ethers.utils.keccak256(secret)

  const nowSec = Math.floor(Date.now() / 1000)
  const t1 = Math.min(order.deadlineBase, nowSec + T1_BUFFER_SECONDS)
  const t2 = t1 + T2_BUFFER_SECONDS
  if (t1 <= nowSec) throw new Error(`Order ${orderHash.slice(0, 10)}… deadlineBase is too close/passed — no valid T1 available`)

  // ── Quote the backend BEFORE funding anything ────────────────────────────
  console.log(`[crossChainFill] 1/6 quoting fill  amount=${fillAmount}  hashlock=${hashlock.slice(0,10)}…  t1=${t1} t2=${t2}`)
  const { data: created } = await axios.post(`${BACKEND_URL}/cc/orders/${orderHash}/fills`, {
    filler: wallet.address, hashlock, fillAmount: fillAmount.toString(), t1, t2,
  })
  const fillId: number = created.fillId

  // Survive a crash between here and withdraw() — this is the ONLY place the
  // secret exists (backend never holds it); crossChainResume reads it back.
  saveSecret(fillId, secret)

  return driveToCompletion(orderHash, fillId, hashlock, secret, order, legs, fillAmount, t2, opts)
}

// ── Entry point 2: resume an in-flight fill after a restart/crash ────────────
// Needs the secret THIS filler generated originally, recovered from the local
// store — never re-derived, never requested from the backend.
export async function crossChainResume(orderHash: string, fillId: number, opts?: CrossChainFillOptions): Promise<string> {
  if (!CHAIN_B_RPC) throw new Error('CHAIN_B_RPC not set in .env')

  const secret = loadSecret(fillId)
  if (!secret) {
    throw new Error(`No locally-stored secret for fill ${fillId} — this filler didn't originate it, or the local store (.cc-secrets.json) was lost`)
  }

  const { data: order } = await axios.get(`${BACKEND_URL}/cc/orders/${orderHash}`)
  const { data: fill }  = await axios.get(`${BACKEND_URL}/cc/fills/${fillId}`)

  if (fill.status === 'claimed') {
    console.log(`[crossChainResume] fill ${fillId} already claimed on the dest chain — nothing left to do`)
    return 'already-claimed'
  }

  const legs = resolveLegs(order.chainAId)
  return driveToCompletion(orderHash, fillId, fill.hashlock, secret, order, legs, BigInt(fill.fillAmount), fill.t2, opts)
}

// ── Shared tail: fund dest (idempotent) → wait dst_funded → wait authorized
//    → fillSlot on source (idempotent) → withdraw (reveals the secret) ───────
async function driveToCompletion(
  orderHash: string,
  fillId: number,
  hashlock: string,
  secret: string,
  order: any,
  legs: ChainLegs,
  fillAmount: bigint,
  t2: number,
  opts?: CrossChainFillOptions,
): Promise<string> {
  const { srcProvider, srcWallet, srcFactoryAddr, dstProvider, dstWallet, dstFactoryAddr } = legs

  await ensureDstEscrowDeployed(dstFactoryAddr, dstWallet, dstProvider, order.outputToken, hashlock, order.swapper, fillAmount, t2)

  console.log(`[crossChainFill] 2/6 waiting for backend to verify dest escrow is genuine…`)
  await waitForFillStatus(fillId, s => s !== 'quoted')

  console.log(`[crossChainFill] 3/6 waiting for swapper to verify + sign…`)
  // The swapper may have revised T1 when they signed (see backend
  // setFillSwapperSig) — `fill.t1` here is that possibly-revised value, fresh
  // from the backend, which is exactly what gets checked and what's put into
  // `auth` below (never the filler's own original quote-time t1).
  const fill = await waitForFillStatus(fillId, s => s !== 'quoted' && s !== 'dst_funded')

  assertTimeMargin('before creating EscrowSrc', fill.t1, opts)
  const escrowAddrSrc = await fillSlotOnSrc(srcFactoryAddr, srcWallet, srcProvider, order, fill, orderHash, hashlock)

  assertTimeMargin('before revealing the secret', fill.t1, opts)
  return withdrawOnSrc(srcWallet, escrowAddrSrc, secret)
}

// ── Fund + deploy EscrowDst FIRST, before the source leg even exists ─────────
async function ensureDstEscrowDeployed(
  dstFactoryAddr: string,
  dstWallet: ethers.Wallet,
  dstProvider: ethers.providers.Provider,
  outputToken: string,
  hashlock: string,
  swapper: string,
  fillAmount: bigint,
  t2: number,
): Promise<string> {
  const dstFactory = new ethers.Contract(dstFactoryAddr, ESCROW_FACTORY_ABI, dstWallet)
  const escrowAddrDst: string = await dstFactory.computeAddress(hashlock, wallet.address)
  console.log(`[crossChainFill]     dest-chain escrow address  ${escrowAddrDst}`)

  const exists = (await dstProvider.getCode(escrowAddrDst)) !== '0x'
  if (exists) {
    console.log(`[crossChainFill]     already deployed — resuming from here`)
    return escrowAddrDst
  }

  const tokenDst = new ethers.Contract(outputToken, ERC20_ABI, dstWallet)
  const bal: ethers.BigNumber = await tokenDst.balanceOf(wallet.address)
  if (bal.toBigInt() < fillAmount) {
    throw new Error(`Insufficient ${outputToken} on the destination chain. Need ${fillAmount}, have ${bal.toBigInt()}.`)
  }

  console.log(`[crossChainFill]     transfer ${fillAmount} → ${escrowAddrDst.slice(0,10)}… (dst chain)`)
  const transferTx = await tokenDst.transfer(escrowAddrDst, fillAmount)
  await transferTx.wait()

  console.log(`[crossChainFill]     factory.deploy  H=${hashlock.slice(0,10)}…  T2=${t2} (dst chain)`)
  const deployTx = await dstFactory.deploy(hashlock, swapper, outputToken, fillAmount, t2)
  await deployTx.wait()

  return escrowAddrDst
}

// ── fillSlot on the source chain — only constructible once BOTH signatures
//    exist (the order intent + this specific fill's authorization) ──────────
async function fillSlotOnSrc(
  srcFactoryAddr: string,
  srcWallet: ethers.Wallet,
  srcProvider: ethers.providers.Provider,
  order: any,
  fill: any,
  orderHash: string,
  hashlock: string,
): Promise<string> {
  const srcFactory = new ethers.Contract(srcFactoryAddr, ESCROW_SRC_FACTORY_ABI, srcWallet)
  const escrowAddrSrc: string = await srcFactory.computeAddress(orderHash, hashlock)

  const alreadyFilled: boolean = await srcFactory.isFilled(orderHash, hashlock)
  if (alreadyFilled) {
    console.log(`[crossChainFill] 4/6 source already locked — skipping fillSlot`)
    return escrowAddrSrc
  }

  if (!fill.swapperSig) throw new Error(`Fill ${fill.fillId} has no per-fill swapperSig yet`)

  const info = {
    swapper: order.swapper, inputToken: order.inputToken, inputAmount: order.inputAmount,
    outputToken: order.outputToken, minOutput: order.minOutput,
    deadlineBase: order.deadlineBase, nonce: order.nonce, feeTier: order.feeTier,
  }
  const auth = { orderHash, hashlock, fillAmount: fill.fillAmount, t1: fill.t1, t2: fill.t2 }

  const required: ethers.BigNumber = await srcFactory.previewRequiredStake(
    fill.fillAmount, order.inputToken, order.feeTier, fill.t1
  )

  console.log(`[crossChainFill] 4/6 fillSlot  bond=${ethers.utils.formatEther(required)} ETH  (src chain)`)
  const fillTx = await srcFactory.fillSlot(info, order.swapperSig, auth, fill.swapperSig, { value: required })
  await fillTx.wait()

  return escrowAddrSrc
}

// ── Reveal the secret by withdrawing on the source chain ─────────────────────
async function withdrawOnSrc(srcWallet: ethers.Wallet, escrowAddrSrc: string, secret: string): Promise<string> {
  const escrowSrc = new ethers.Contract(escrowAddrSrc, ESCROW_SRC_ABI, srcWallet)
  console.log(`[crossChainFill] 5/6 EscrowSrc(${escrowAddrSrc.slice(0,10)}…).withdraw  (src chain — reveals the secret publicly)`)
  const withdrawTx = await escrowSrc.withdraw(secret)
  await withdrawTx.wait()
  console.log(`[crossChainFill] ✔ 6/6 input token + bond withdrawn  tx=${withdrawTx.hash}`)
  console.log(`[crossChainFill]     secret is now public — a relayer will claim the dest escrow automatically`)
  return withdrawTx.hash
}

// ── Poll the backend for this fill's status to satisfy `predicate` ──────────
async function waitForFillStatus(fillId: number, predicate: (status: string) => boolean): Promise<any> {
  const deadline = Date.now() + STATUS_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const { data: fill } = await axios.get(`${BACKEND_URL}/cc/fills/${fillId}`)
    if (predicate(fill.status)) return fill
    await new Promise(r => setTimeout(r, STATUS_POLL_INTERVAL_MS))
  }
  throw new Error(
    `Timed out waiting for fill ${fillId} to progress past its current status.\n` +
    `Run 'cc resume <hash> ${fillId}' later to pick it back up (the secret is saved locally).`
  )
}
