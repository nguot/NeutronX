import { ethers } from 'ethers'
import axios from 'axios'
import { BACKEND_URL, CC_REACTOR, CHAIN_B_RPC, CHAIN_B_FACTORY } from '../config'
import { CC_REACTOR_ABI, ESCROW_FACTORY_ABI, ESCROW_DST_ABI, ERC20_ABI } from '../contract/abis'
import { wallet } from '../contract/contracts'

export async function ccFill(orderHash: string, slotIndex: number): Promise<string> {
  if (!CC_REACTOR || !CHAIN_B_RPC || !CHAIN_B_FACTORY) {
    throw new Error(
      'CC_REACTOR / CHAIN_B_RPC / CHAIN_B_FACTORY not set in .env\n' +
      'Run: bash tests/crosschain/setup_cc.sh   (then restart this filler)'
    )
  }

  // ── Fetch order detail from backend ────────────────────────────────────────
  const { data: order } = await axios.get(`${BACKEND_URL}/cc/orders/${orderHash}`)
  const slot = (order.slots as any[])[slotIndex]
  if (!slot)                        throw new Error(`Slot ${slotIndex} not found in order`)
  if (slot.status !== 'available')  throw new Error(`Slot ${slotIndex} is "${slot.status}" — not available`)

  const hashlock:    string   = slot.hashlock
  const proof:       string[] = slot.proof
  const swapper:     string   = order.swapper
  const outputToken: string   = order.outputToken
  const slotAmount:  bigint   = BigInt(order.minOutput) / BigInt(order.numSlots)

  // ── Chain B provider & signer (same private key, different chain) ──────────
  const providerA = wallet.provider!
  const providerB = new ethers.providers.JsonRpcProvider(CHAIN_B_RPC)
  const walletB   = wallet.connect(providerB)

  const reactorA = new ethers.Contract(CC_REACTOR,       CC_REACTOR_ABI,     wallet)
  const factoryB = new ethers.Contract(CHAIN_B_FACTORY,  ESCROW_FACTORY_ABI, walletB)
  const tokenB   = new ethers.Contract(outputToken,      ERC20_ABI,          walletB)

  // Balance check on Chain B before committing
  const balB: ethers.BigNumber = await tokenB.balanceOf(wallet.address)
  if (balB.toBigInt() < slotAmount) {
    throw new Error(
      `Insufficient ${outputToken} on Chain B.\n` +
      `Need ${slotAmount}, have ${balB.toBigInt()}.\n` +
      'Run setup_cc.sh to re-fund fillers.'
    )
  }

  // ── Step 1: registerFiller on Chain A ──────────────────────────────────────
  // Skip if we already registered (e.g. a previous attempt that timed out mid-way).
  const alreadyRegistered: string = await reactorA.slotFiller(orderHash, slotIndex)
  if (alreadyRegistered === ethers.constants.AddressZero) {
    console.log(`[ccFill] 1/6 registerFiller  order=${orderHash.slice(0,10)}… slot=${slotIndex}`)
    const regTx = await reactorA.registerFiller(orderHash, slotIndex)
    await regTx.wait()
  } else if (alreadyRegistered.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `Slot ${slotIndex} is already registered by a different filler (${alreadyRegistered}).\n` +
      'Use the other filler UI to fill this slot.'
    )
  } else {
    console.log(`[ccFill] 1/6 already registered by us — skipping registerFiller`)
  }
  // Record registration in DB so the other filler's UI shows "🔒 Other filler"
  await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/filler`,
    { filler: wallet.address }).catch(() => {})

  // ── Step 2: compute deterministic escrow clone address on Chain B ──────────
  const escrowAddr: string = await factoryB.computeAddress(hashlock, wallet.address)
  console.log(`[ccFill] 2/6 escrow address  ${escrowAddr}`)

  // ── Step 3: transfer output tokens directly to the escrow address ──────────
  // EscrowDst uses CREATE2 so the address is known before deployment.
  // No ERC-20 approve needed — filler transfers directly to the clone address.
  console.log(`[ccFill] 3/6 transfer ${slotAmount} → ${escrowAddr.slice(0,10)}… (Chain B)`)
  const transferTx = await tokenB.transfer(escrowAddr, slotAmount)
  await transferTx.wait()

  // ── Step 4: deploy the escrow clone on Chain B ─────────────────────────────
  // t2Expiry stored in the backend is (T1 - t2Buffer) in Chain A block terms.
  // Adjust to Chain B's current block so EscrowDst.initialize() doesn't revert.
  const [blockA, blockB] = await Promise.all([
    providerA.getBlockNumber(),
    providerB.getBlockNumber(),
  ])
  const t2ExpiryChainB = blockB + (order.t2Expiry - blockA)

  console.log(`[ccFill] 4/6 factory.deploy  H=${hashlock.slice(0,10)}… T2=${t2ExpiryChainB} (Chain B)`)
  const deployTx = await factoryB.deploy(hashlock, swapper, outputToken, slotAmount, t2ExpiryChainB)
  await deployTx.wait()
  console.log(`[ccFill]     escrow deployed  tx=${deployTx.hash}`)

  // ── Step 5: wait for backend chainBWatcher to claim (reveals S_i) ──────────
  // Backend sees EscrowCreated, re-derives S_i, calls escrow.claim(S_i).
  // The Claimed event emits S_i in plaintext — we read it from Chain B.
  console.log(`[ccFill] 5/6 waiting for backend to claim escrow and reveal S_i…`)
  const secret = await waitForClaimed(providerB, escrowAddr, 120_000)
  console.log(`[ccFill]     S_i revealed  ${secret.slice(0,10)}…`)

  // ── Step 6: claimSlot on Chain A ───────────────────────────────────────────
  console.log(`[ccFill] 6/6 claimSlot  slot=${slotIndex}  (Chain A)`)
  const claimTx = await reactorA.claimSlot(orderHash, slotIndex, secret, proof)
  await claimTx.wait()
  console.log(`[ccFill] ✔ WETH claimed on Chain A  tx=${claimTx.hash}`)

  // Mark slot 'done' so the dev UI doesn't re-render it as "⚡ Claim WETH"
  await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})

  return claimTx.hash
}

// Recovery: backend already claimed (slot status = 'claimed') but filler timed out before
// calling claimSlot on Chain A. Reads S_i from Chain B event logs and claims WETH on Chain A.
export async function ccClaimSlot(orderHash: string, slotIndex: number): Promise<string> {
  if (!CC_REACTOR || !CHAIN_B_RPC) {
    throw new Error('CC_REACTOR / CHAIN_B_RPC not set in .env')
  }

  const { data: order } = await axios.get(`${BACKEND_URL}/cc/orders/${orderHash}`)
  const slot = (order.slots as any[])[slotIndex]
  if (!slot) throw new Error(`Slot ${slotIndex} not found`)
  if (!slot.escrowAddr) {
    throw new Error(`Slot ${slotIndex} has no escrow address — backend hasn't processed it yet`)
  }

  const proof: string[] = slot.proof
  const providerB  = new ethers.providers.JsonRpcProvider(CHAIN_B_RPC)
  const reactorA   = new ethers.Contract(CC_REACTOR, CC_REACTOR_ABI, wallet)
  const escrow     = new ethers.Contract(slot.escrowAddr, ESCROW_DST_ABI, providerB)

  // Step A: confirm Chain B is reachable
  const current = await providerB.getBlockNumber().catch((e: any) => {
    throw new Error(`[step A] Chain B not reachable at ${CHAIN_B_RPC} — is chainb_anvil.sh running?\nDetail: ${e.message ?? e}`)
  })

  // Step B: scan recent blocks for Claimed event.
  // Anvil forks at block 20_500_000. Querying below that causes Anvil to forward
  // the request to Alchemy, which rejects ranges > 10 blocks on the free tier.
  // Clamping to fork+1 ensures the entire range stays in Anvil-local storage.
  const CHAIN_B_FORK_BLOCK = 20_500_000
  const fromBlock = Math.max(CHAIN_B_FORK_BLOCK + 1, current - 2000)
  console.log(`[ccClaimSlot] scanning blocks ${fromBlock}..${current} on Chain B for Claimed event`)
  const logs = await escrow.queryFilter(escrow.filters.Claimed(), fromBlock, current).catch((e: any) => {
    throw new Error(`[step B] queryFilter failed — ${e.message ?? e}`)
  })
  if (logs.length === 0) {
    // No Claimed event on Chain B — two possibilities:
    // (A) Chain B was restarted (stale DB entry, escrow gone) → reset slot to 'available'
    // (B) Backend hasn't processed yet → mine blocks and retry
    //
    // Distinguish by checking Chain A: if the WETH bitmap bit is NOT set, the slot
    // was never paid out, so the DB is stale. Reset it so the user can refill.
    const chainAClaimed: boolean = await reactorA.isSlotClaimed(orderHash, slotIndex).catch(() => false)
    if (chainAClaimed) {
      // Paid out on Chain A but no Chain B evidence — mark done and move on
      await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})
      return 'already-claimed'
    }
    // Not paid out on Chain A → Chain B state is stale; reset so it can be re-filled
    console.log(`[ccClaimSlot] no Chain B event and Chain A not claimed → resetting slot ${slotIndex} to available`)
    await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/reset`).catch(() => {})
    return 'reset-to-available'
  }

  const secret = (logs[0] as ethers.Event).args!.secret as string
  console.log(`[ccClaimSlot] S_${slotIndex}=${secret.slice(0,10)}…  claiming on Chain A…`)

  // Step C: claimSlot on Chain A
  // Case 1 — on-chain bitmap already set (WETH already transferred, DB just stale)
  const alreadyClaimed: boolean = await reactorA.isSlotClaimed(orderHash, slotIndex)
  if (alreadyClaimed) {
    console.log(`[ccClaimSlot] slot ${slotIndex} already claimed on-chain — marking done in DB`)
    await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})
    return 'already-claimed'
  }
  // Case 2 — different filler registered → tell the user which UI to use
  const registeredFiller: string = await reactorA.slotFiller(orderHash, slotIndex)
  if (registeredFiller !== ethers.constants.AddressZero &&
      registeredFiller.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `Slot ${slotIndex} is registered to ${registeredFiller}.\n` +
      'Open the other filler UI to claim this slot.'
    )
  }
  // Case 3 — normal claim
  const claimTx = await reactorA.claimSlot(orderHash, slotIndex, secret, proof).catch((e: any) => {
    throw new Error(`[step C] claimSlot reverted — ${e.reason ?? e.message ?? e}`)
  })
  await claimTx.wait()
  console.log(`[ccClaimSlot] ✔ WETH claimed  tx=${claimTx.hash}`)

  // Mark slot 'done' in backend DB so the dev UI stops showing "⚡ Claim WETH"
  await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})

  return claimTx.hash
}

// Poll Chain B for the EscrowDst.Claimed event on the given clone.
// Returns the revealed secret (bytes32 as hex string).
async function waitForClaimed(
  provider: ethers.providers.JsonRpcProvider,
  escrowAddr: string,
  timeoutMs: number,
): Promise<string> {
  const escrow  = new ethers.Contract(escrowAddr, ESCROW_DST_ABI, provider)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const current = await provider.getBlockNumber()
    const logs = await escrow.queryFilter(
      escrow.filters.Claimed(),
      Math.max(20_500_001, current - 30),
      'latest',
    )
    if (logs.length > 0) {
      return (logs[0] as ethers.Event).args!.secret as string
    }
    await new Promise(r => setTimeout(r, 2_000))
  }

  throw new Error(
    'Timed out waiting for Claimed event on Chain B.\n' +
    'Make sure the backend is running with CHAIN_B_FACTORY set (restart after setup_cc.sh).'
  )
}
