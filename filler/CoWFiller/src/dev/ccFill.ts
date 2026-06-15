import { ethers } from 'ethers'
import axios from 'axios'
import {
  BACKEND_URL, ESCROW_SRC_FACTORY, CHAIN_B_RPC, CHAIN_B_FACTORY,
  CHAIN_B_ESCROW_SRC_FACTORY, CHAIN_A_DST_FACTORY,
} from '../config'
import { ESCROW_SRC_FACTORY_ABI, ESCROW_SRC_ABI, ESCROW_FACTORY_ABI, ESCROW_DST_ABI, ERC20_ABI } from '../contract/abis'
import { wallet } from '../contract/contracts'

// DEV ONLY — Anvil Account 0 (swapper) default private key, public knowledge for
// every local Anvil instance. The real flow would have the swapper's wallet
// (e.g. MetaMask) produce this signature; this dev script signs on their behalf
// so ccFill can be exercised end-to-end without a browser.
const DEV_SWAPPER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const SAFETY_DEPOSIT = ethers.utils.parseEther('0.01')

// Anvil forks both chains at this block. Querying below it forwards to Alchemy,
// which rejects ranges > 10 blocks on the free tier.
const FORK_BLOCK = 20_500_000

// `wallet` (from contracts.ts) is connected to Chain A (RPC_URL); CHAIN_B_RPC
// connects to Chain B with the same private key/address.
const CHAIN_A_ID = 31337
const CHAIN_B_ID = 31338

// ── Claim-wait timing (step 5 of ccFill) ──────────────────────────────────────
// After the dst escrow is deployed, the backend's dst-chain watcher polls
// every 12s, re-derives S_i, and calls claim() — which emits the Claimed
// event we're waiting for here.

// Generous overall timeout: the watcher may queue behind other claims, so
// this can take well over a minute.
const CLAIM_TIMEOUT_MS = 300_000

// How often to re-check for the Claimed event while waiting.
const CLAIM_POLL_INTERVAL_MS = 2_000

// How many recent blocks to scan per check for the Claimed event. The escrow
// was deployed only moments ago, so a small trailing window is enough.
const CLAIM_SCAN_WINDOW_BLOCKS = 30

// ── Recovery scan (ccClaimSlot) ────────────────────────────────────────────
// ccClaimSlot is a manual recovery action that can run long after the escrow
// was deployed (e.g. retried in a later session), so it needs a much wider
// lookback than the live poll above.
const RECOVERY_SCAN_WINDOW_BLOCKS = 2000

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
// A→B and B→A are both handled by the same fill logic below, parameterized
// on these resolved legs.
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
  throw new Error(`Unsupported chainAId ${chainAId} — this dev filler only supports Chain A (${CHAIN_A_ID}) / Chain B (${CHAIN_B_ID})`)
}

// Fetch an order + its slot from the backend and resolve which chain plays
// "src"/"dst" for it. Shared setup for ccFill and ccClaimSlot.
async function fetchOrderAndSlot(orderHash: string, slotIndex: number): Promise<{ order: any, slot: any, legs: ChainLegs }> {
  const { data: order } = await axios.get(`${BACKEND_URL}/cc/orders/${orderHash}`)
  const slot = (order.slots as any[])[slotIndex]
  if (!slot) throw new Error(`Slot ${slotIndex} not found in order`)
  const legs = resolveLegs(order.chainAId)
  return { order, slot, legs }
}

export async function ccFill(orderHash: string, slotIndex: number): Promise<string> {
  if (!CHAIN_B_RPC) {
    throw new Error(
      'CHAIN_B_RPC not set in .env\n' +
      'Run: bash tests/crosschain/setup_cc.sh   (then restart this filler)'
    )
  }

  // ── Fetch order detail from backend ────────────────────────────────────────
  const { order, slot, legs } = await fetchOrderAndSlot(orderHash, slotIndex)
  if (slot.status !== 'available') throw new Error(`Slot ${slotIndex} is "${slot.status}" — not available`)

  const hashlock:    string   = slot.hashlock
  const proof:       string[] = slot.proof
  const swapper:     string   = order.swapper
  const outputToken: string   = order.outputToken
  const slotAmount:  bigint   = BigInt(order.minOutput) / BigInt(order.numSlots)

  // ── Resolve src/dst chain legs from this order's direction ──────────────────
  const { srcProvider, srcWallet, srcFactoryAddr, dstProvider, dstWallet, dstFactoryAddr } = legs
  if (!srcFactoryAddr || !dstFactoryAddr) {
    throw new Error(
      `Factory addresses not configured for chain ${order.chainAId} → ${order.dstChainId}.\n` +
      'Run: bash tests/crosschain/setup_cc.sh   (then restart this filler)'
    )
  }

  const srcFactory = new ethers.Contract(srcFactoryAddr, ESCROW_SRC_FACTORY_ABI, srcWallet)
  const dstFactory = new ethers.Contract(dstFactoryAddr, ESCROW_FACTORY_ABI,     dstWallet)
  const tokenDst   = new ethers.Contract(outputToken,    ERC20_ABI,             dstWallet)

  // Balance check on the destination chain before committing
  const balDst: ethers.BigNumber = await tokenDst.balanceOf(wallet.address)
  if (balDst.toBigInt() < slotAmount) {
    throw new Error(
      `Insufficient ${outputToken} on destination chain (${order.dstChainId}).\n` +
      `Need ${slotAmount}, have ${balDst.toBigInt()}.\n` +
      'Run setup_cc.sh to re-fund fillers.'
    )
  }

  const info = {
    swapper:     order.swapper,
    inputToken:  order.inputToken,
    inputAmount: order.inputAmount,
    outputToken: order.outputToken,
    minOutput:   order.minOutput,
    deadline:    order.deadline,
    nonce:       order.nonce,
    merkleRoot:  order.merkleRoot,
    numSlots:    order.numSlots,
  }
  const swapperSig = await signOrderHash(orderHash, srcFactory)

  // ── Step 1: fillSlot on the source chain ────────────────────────────────────
  const escrowAddrSrc = await fillSlotOnSrc(
    srcFactory, srcProvider, info, orderHash, slotIndex, hashlock, proof, swapperSig, order.cosignerSig,
  )

  // ── Steps 2-4: ensure the EscrowDst clone is funded + deployed ──────────────
  const escrowAddrDst = await ensureDstEscrowDeployed(
    dstFactory, dstProvider, srcProvider, tokenDst, hashlock, swapper, outputToken, slotAmount, order.t2Expiry,
  )

  // ── Step 5: wait for backend's dst-chain watcher to claim (reveals S_i) ─────
  // Backend sees EscrowCreated, re-derives S_i, calls escrow.claim(S_i).
  // The Claimed event emits S_i in plaintext — we read it from the dst chain.
  console.log(`[ccFill] 5/6 waiting for backend to claim escrow and reveal S_i…`)
  const secret = await waitForClaimed(dstProvider, escrowAddrDst, CLAIM_TIMEOUT_MS)
  console.log(`[ccFill]     S_i revealed  ${secret.slice(0,10)}…`)

  // ── Step 6: withdraw on the source chain ────────────────────────────────────
  const withdrawTx = await withdrawOnSrc(srcWallet, escrowAddrSrc, secret, slotIndex)

  // Mark slot 'done' so the dev UI doesn't re-render it as "⚡ Claim"
  await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})

  return withdrawTx.hash
}

// ── Step 1: fillSlot on the source chain ────────────────────────────────────
// Lazily registers the order on its first call (verifies swapperSig +
// cosignerSig), checks the Merkle proof, deploys an EscrowSrc clone, and
// pulls slotAmount of the swapper's input token into it via Permit2. msg.value
// is this filler's safety deposit, refunded on withdraw(). Returns the
// EscrowSrc clone address for this slot.
async function fillSlotOnSrc(
  srcFactory: ethers.Contract,
  srcProvider: ethers.providers.Provider,
  info: Record<string, unknown>,
  orderHash: string,
  slotIndex: number,
  hashlock: string,
  proof: string[],
  swapperSig: string,
  cosignerSig: string,
): Promise<string> {
  const escrowAddrSrc: string = await srcFactory.computeAddress(orderHash, slotIndex)
  const alreadyFilled: boolean = await srcFactory.isSlotFilled(orderHash, slotIndex)

  if (alreadyFilled) {
    const escrowSrcExisting = new ethers.Contract(escrowAddrSrc, ESCROW_SRC_ABI, srcProvider)
    const existingFiller: string = await escrowSrcExisting.filler()
    if (existingFiller.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(
        `Slot ${slotIndex} is already filled by a different filler (${existingFiller}).\n` +
        'Use the other filler UI to fill this slot.'
      )
    }
    console.log(`[ccFill] 1/6 slot already filled by us — skipping fillSlot`)
  } else {
    console.log(`[ccFill] 1/6 fillSlot  order=${orderHash.slice(0,10)}… slot=${slotIndex}`)
    const fillTx = await srcFactory.fillSlot(info, swapperSig, cosignerSig, slotIndex, hashlock, proof, { value: SAFETY_DEPOSIT })
    await fillTx.wait()
  }

  // Filler address is recorded automatically by the backend's escrowSrcWatcher
  // (SlotFilled event) — no self-report needed.
  return escrowAddrSrc
}

// ── Steps 2-4: ensure the EscrowDst clone is funded + deployed ──────────────
// Computes the deterministic clone address (CREATE2, so it's known before
// deployment), then transfers output tokens and deploys the clone — unless a
// previous attempt already got this far and timed out waiting for the claim
// (step 5). Re-running the transfer+deploy in that case would double-fund the
// escrow and revert on deploy() (CREATE2 collision on an address that's
// already a contract); detect that and skip straight to waiting for the claim.
async function ensureDstEscrowDeployed(
  dstFactory: ethers.Contract,
  dstProvider: ethers.providers.Provider,
  srcProvider: ethers.providers.Provider,
  tokenDst: ethers.Contract,
  hashlock: string,
  swapper: string,
  outputToken: string,
  slotAmount: bigint,
  t2ExpirySrc: number,
): Promise<string> {
  const escrowAddrDst: string = await dstFactory.computeAddress(hashlock, wallet.address)
  console.log(`[ccFill] 2/6 dst-chain escrow address  ${escrowAddrDst}`)

  const dstEscrowExists = (await dstProvider.getCode(escrowAddrDst)) !== '0x'
  if (dstEscrowExists) {
    console.log(`[ccFill] 3-4/6 escrow already deployed at ${escrowAddrDst.slice(0,10)}… — resuming wait for claim`)
    return escrowAddrDst
  }

  // ── Step 3: transfer output tokens directly to the escrow address ──────────
  // No ERC-20 approve needed — filler transfers directly to the clone address.
  console.log(`[ccFill] 3/6 transfer ${slotAmount} → ${escrowAddrDst.slice(0,10)}… (dst chain)`)
  const transferTx = await tokenDst.transfer(escrowAddrDst, slotAmount)
  await transferTx.wait()

  // ── Step 4: deploy the escrow clone on the dst chain ────────────────────────
  // t2Expiry stored in the backend is (T1 - t2Buffer) in src-chain block terms.
  // Adjust to the dst chain's current block so EscrowDst.initialize() doesn't revert.
  const [blockSrc, blockDst] = await Promise.all([
    srcProvider.getBlockNumber(),
    dstProvider.getBlockNumber(),
  ])
  const t2ExpiryDst = blockDst + (t2ExpirySrc - blockSrc)

  console.log(`[ccFill] 4/6 factory.deploy  H=${hashlock.slice(0,10)}… T2=${t2ExpiryDst} (dst chain)`)
  const deployTx = await dstFactory.deploy(hashlock, swapper, outputToken, slotAmount, t2ExpiryDst)
  await deployTx.wait()
  console.log(`[ccFill]     escrow deployed  tx=${deployTx.hash}`)

  return escrowAddrDst
}

// ── Step 6: withdraw on the source chain ────────────────────────────────────
async function withdrawOnSrc(
  srcWallet: ethers.Wallet,
  escrowAddrSrc: string,
  secret: string,
  slotIndex: number,
): Promise<ethers.providers.TransactionResponse> {
  const escrowSrc = new ethers.Contract(escrowAddrSrc, ESCROW_SRC_ABI, srcWallet)
  console.log(`[ccFill] 6/6 EscrowSrc(${escrowAddrSrc.slice(0,10)}…).withdraw  slot=${slotIndex}  (src chain)`)
  const withdrawTx = await escrowSrc.withdraw(secret)
  await withdrawTx.wait()
  console.log(`[ccFill] ✔ output token + safety deposit withdrawn on src chain  tx=${withdrawTx.hash}`)
  return withdrawTx
}

// Sign keccak256("\x19\x01" || DOMAIN_SEPARATOR || orderHash) with the dev
// swapper key — this is what the contract verifies as `swapperSig`.
async function signOrderHash(orderHash: string, srcFactory: ethers.Contract): Promise<string> {
  const domainSeparator: string = await srcFactory.DOMAIN_SEPARATOR()
  const digest = ethers.utils.keccak256(
    ethers.utils.solidityPack(['string', 'bytes32', 'bytes32'], ['\x19\x01', domainSeparator, orderHash])
  )
  const swapperWallet = new ethers.Wallet(DEV_SWAPPER_PK)
  return ethers.utils.joinSignature(swapperWallet._signingKey().signDigest(digest))
}

// Recovery: filler timed out before calling withdraw() on the src chain after
// the backend already claimed on the dst chain (reveals S_i).
export async function ccClaimSlot(orderHash: string, slotIndex: number): Promise<string> {
  if (!CHAIN_B_RPC) {
    throw new Error('CHAIN_B_RPC not set in .env')
  }

  const { order, slot, legs } = await fetchOrderAndSlot(orderHash, slotIndex)
  if (!slot.escrowAddr) {
    throw new Error(`Slot ${slotIndex} has no escrow address — backend hasn't processed it yet`)
  }

  const { srcWallet, srcFactoryAddr, dstProvider } = legs
  if (!srcFactoryAddr) {
    throw new Error(`Factory address not configured for chain ${order.chainAId} — run setup_cc.sh`)
  }

  const srcFactory = new ethers.Contract(srcFactoryAddr, ESCROW_SRC_FACTORY_ABI, srcWallet)
  const escrowDst  = new ethers.Contract(slot.escrowAddr, ESCROW_DST_ABI, dstProvider)

  // Step A: confirm the dst chain is reachable
  const current = await dstProvider.getBlockNumber().catch((e: any) => {
    throw new Error(`[step A] dst chain not reachable — is the corresponding anvil running?\nDetail: ${e.message ?? e}`)
  })

  // Step B: scan recent blocks for Claimed event.
  // Anvil forks at block 20_500_000. Querying below that causes Anvil to forward
  // the request to Alchemy, which rejects ranges > 10 blocks on the free tier.
  // Clamping to fork+1 ensures the entire range stays in Anvil-local storage.
  const fromBlock = Math.max(FORK_BLOCK + 1, current - RECOVERY_SCAN_WINDOW_BLOCKS)
  console.log(`[ccClaimSlot] scanning blocks ${fromBlock}..${current} on dst chain for Claimed event`)
  const logs = await escrowDst.queryFilter(escrowDst.filters.Claimed(), fromBlock, current).catch((e: any) => {
    throw new Error(`[step B] queryFilter failed — ${e.message ?? e}`)
  })

  const escrowAddrSrc: string = await srcFactory.computeAddress(orderHash, slotIndex)
  const escrowSrc = new ethers.Contract(escrowAddrSrc, ESCROW_SRC_ABI, srcWallet)
  const status: string = await escrowSrc.status()

  if (logs.length === 0) {
    // No Claimed event on the dst chain — two possibilities:
    // (A) the dst chain was restarted (stale DB entry, escrow gone) → reset slot to 'available'
    // (B) backend hasn't processed yet → mine blocks and retry
    //
    // Distinguish by checking the src chain: if the EscrowSrc clone hasn't been
    // withdrawn yet, the DB is stale. Reset it so the user can refill.
    if (status === 'withdrawn') {
      await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})
      return 'already-claimed'
    }
    console.log(`[ccClaimSlot] no dst-chain event and src not withdrawn → resetting slot ${slotIndex} to available`)
    await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/reset`).catch(() => {})
    return 'reset-to-available'
  }

  const secret = (logs[0] as ethers.Event).args!.secret as string
  console.log(`[ccClaimSlot] S_${slotIndex}=${secret.slice(0,10)}…  withdrawing on src chain…`)

  // Already withdrawn on-chain (output token already sent, DB just stale)
  if (status === 'withdrawn') {
    console.log(`[ccClaimSlot] slot ${slotIndex} already withdrawn on-chain — marking done in DB`)
    await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})
    return 'already-claimed'
  }

  const withdrawTx = await escrowSrc.withdraw(secret).catch((e: any) => {
    throw new Error(`[step C] withdraw reverted — ${e.reason ?? e.message ?? e}`)
  })
  await withdrawTx.wait()
  console.log(`[ccClaimSlot] ✔ withdrawn  tx=${withdrawTx.hash}`)

  // Mark slot 'done' in backend DB so the dev UI stops showing "⚡ Claim"
  await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})

  return withdrawTx.hash
}

// Poll the dst chain for the EscrowDst.Claimed event on the given clone.
// Returns the revealed secret (bytes32 as hex string).
async function waitForClaimed(
  provider: ethers.providers.Provider,
  escrowAddr: string,
  timeoutMs: number,
): Promise<string> {
  const escrow  = new ethers.Contract(escrowAddr, ESCROW_DST_ABI, provider)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const current = await provider.getBlockNumber()
    const logs = await escrow.queryFilter(
      escrow.filters.Claimed(),
      Math.max(FORK_BLOCK + 1, current - CLAIM_SCAN_WINDOW_BLOCKS),
      'latest',
    )
    if (logs.length > 0) {
      return (logs[0] as ethers.Event).args!.secret as string
    }
    await new Promise(r => setTimeout(r, CLAIM_POLL_INTERVAL_MS))
  }

  throw new Error(
    'Timed out waiting for Claimed event on the destination chain.\n' +
    'Make sure the backend is running with the destination EscrowDstFactory configured (restart after setup_cc.sh).'
  )
}
