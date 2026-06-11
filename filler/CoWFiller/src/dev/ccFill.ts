import { ethers } from 'ethers'
import axios from 'axios'
import { BACKEND_URL, ESCROW_SRC_FACTORY, CHAIN_B_RPC, CHAIN_B_FACTORY } from '../config'
import { ESCROW_SRC_FACTORY_ABI, ESCROW_SRC_ABI, ESCROW_FACTORY_ABI, ESCROW_DST_ABI, ERC20_ABI } from '../contract/abis'
import { wallet } from '../contract/contracts'

// DEV ONLY — Anvil Account 0 (swapper) default private key, public knowledge for
// every local Anvil instance. The real flow would have the swapper's wallet
// (e.g. MetaMask) produce this signature; this dev script signs on their behalf
// so ccFill can be exercised end-to-end without a browser.
const DEV_SWAPPER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const SAFETY_DEPOSIT = ethers.utils.parseEther('0.01')

export async function ccFill(orderHash: string, slotIndex: number): Promise<string> {
  if (!ESCROW_SRC_FACTORY || !CHAIN_B_RPC || !CHAIN_B_FACTORY) {
    throw new Error(
      'ESCROW_SRC_FACTORY / CHAIN_B_RPC / CHAIN_B_FACTORY not set in .env\n' +
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

  const factoryA = new ethers.Contract(ESCROW_SRC_FACTORY, ESCROW_SRC_FACTORY_ABI, wallet)
  const factoryB = new ethers.Contract(CHAIN_B_FACTORY,    ESCROW_FACTORY_ABI,     walletB)
  const tokenB   = new ethers.Contract(outputToken,        ERC20_ABI,              walletB)

  // Balance check on Chain B before committing
  const balB: ethers.BigNumber = await tokenB.balanceOf(wallet.address)
  if (balB.toBigInt() < slotAmount) {
    throw new Error(
      `Insufficient ${outputToken} on Chain B.\n` +
      `Need ${slotAmount}, have ${balB.toBigInt()}.\n` +
      'Run setup_cc.sh to re-fund fillers.'
    )
  }

  // ── Step 1: fillSlot on Chain A ─────────────────────────────────────────────
  // Lazily registers the order on its first call (verifies swapperSig +
  // cosignerSig), checks the Merkle proof, deploys an EscrowSrc clone, and
  // pulls slotAmount of the swapper's WETH into it via Permit2. msg.value is
  // this filler's safety deposit, refunded on withdraw().
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
  const swapperSig = await signOrderHash(orderHash, factoryA)

  const escrowAddrA: string = await factoryA.computeAddress(orderHash, slotIndex)
  const alreadyFilled: boolean = await factoryA.isSlotFilled(orderHash, slotIndex)

  if (alreadyFilled) {
    const escrowAExisting = new ethers.Contract(escrowAddrA, ESCROW_SRC_ABI, providerA)
    const existingFiller: string = await escrowAExisting.filler()
    if (existingFiller.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(
        `Slot ${slotIndex} is already filled by a different filler (${existingFiller}).\n` +
        'Use the other filler UI to fill this slot.'
      )
    }
    console.log(`[ccFill] 1/6 slot already filled by us — skipping fillSlot`)
  } else {
    console.log(`[ccFill] 1/6 fillSlot  order=${orderHash.slice(0,10)}… slot=${slotIndex}`)
    const fillTx = await factoryA.fillSlot(info, swapperSig, order.cosignerSig, slotIndex, hashlock, proof, { value: SAFETY_DEPOSIT })
    await fillTx.wait()
  }

  // Record filler in DB so the other filler's UI shows "🔒 Other filler"
  await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/filler`,
    { filler: wallet.address }).catch(() => {})

  // ── Step 2: compute deterministic escrow clone address on Chain B ──────────
  const escrowAddrB: string = await factoryB.computeAddress(hashlock, wallet.address)
  console.log(`[ccFill] 2/6 Chain B escrow address  ${escrowAddrB}`)

  // ── Step 3: transfer output tokens directly to the escrow address ──────────
  // EscrowDst uses CREATE2 so the address is known before deployment.
  // No ERC-20 approve needed — filler transfers directly to the clone address.
  console.log(`[ccFill] 3/6 transfer ${slotAmount} → ${escrowAddrB.slice(0,10)}… (Chain B)`)
  const transferTx = await tokenB.transfer(escrowAddrB, slotAmount)
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
  const secret = await waitForClaimed(providerB, escrowAddrB, 120_000)
  console.log(`[ccFill]     S_i revealed  ${secret.slice(0,10)}…`)

  // ── Step 6: withdraw on Chain A ────────────────────────────────────────────
  const escrowA = new ethers.Contract(escrowAddrA, ESCROW_SRC_ABI, wallet)
  console.log(`[ccFill] 6/6 EscrowSrc(${escrowAddrA.slice(0,10)}…).withdraw  slot=${slotIndex}  (Chain A)`)
  const withdrawTx = await escrowA.withdraw(secret)
  await withdrawTx.wait()
  console.log(`[ccFill] ✔ WETH + safety deposit withdrawn on Chain A  tx=${withdrawTx.hash}`)

  // Mark slot 'done' so the dev UI doesn't re-render it as "⚡ Claim WETH"
  await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})

  return withdrawTx.hash
}

// Sign keccak256("\x19\x01" || DOMAIN_SEPARATOR || orderHash) with the dev
// swapper key — this is what the contract verifies as `swapperSig`.
async function signOrderHash(orderHash: string, factoryA: ethers.Contract): Promise<string> {
  const domainSeparator: string = await factoryA.DOMAIN_SEPARATOR()
  const digest = ethers.utils.keccak256(
    ethers.utils.solidityPack(['string', 'bytes32', 'bytes32'], ['\x19\x01', domainSeparator, orderHash])
  )
  const swapperWallet = new ethers.Wallet(DEV_SWAPPER_PK)
  return ethers.utils.joinSignature(swapperWallet._signingKey().signDigest(digest))
}

// Recovery: filler timed out before calling withdraw() on Chain A after
// the backend already claimed on Chain B (reveals S_i).
export async function ccClaimSlot(orderHash: string, slotIndex: number): Promise<string> {
  if (!ESCROW_SRC_FACTORY || !CHAIN_B_RPC) {
    throw new Error('ESCROW_SRC_FACTORY / CHAIN_B_RPC not set in .env')
  }

  const { data: order } = await axios.get(`${BACKEND_URL}/cc/orders/${orderHash}`)
  const slot = (order.slots as any[])[slotIndex]
  if (!slot) throw new Error(`Slot ${slotIndex} not found`)
  if (!slot.escrowAddr) {
    throw new Error(`Slot ${slotIndex} has no escrow address — backend hasn't processed it yet`)
  }

  const providerB = new ethers.providers.JsonRpcProvider(CHAIN_B_RPC)
  const factoryA  = new ethers.Contract(ESCROW_SRC_FACTORY, ESCROW_SRC_FACTORY_ABI, wallet)
  const escrowB   = new ethers.Contract(slot.escrowAddr, ESCROW_DST_ABI, providerB)

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
  const logs = await escrowB.queryFilter(escrowB.filters.Claimed(), fromBlock, current).catch((e: any) => {
    throw new Error(`[step B] queryFilter failed — ${e.message ?? e}`)
  })

  const escrowAddrA: string = await factoryA.computeAddress(orderHash, slotIndex)
  const escrowA = new ethers.Contract(escrowAddrA, ESCROW_SRC_ABI, wallet)
  const status: string = await escrowA.status()

  if (logs.length === 0) {
    // No Claimed event on Chain B — two possibilities:
    // (A) Chain B was restarted (stale DB entry, escrow gone) → reset slot to 'available'
    // (B) Backend hasn't processed yet → mine blocks and retry
    //
    // Distinguish by checking Chain A: if the EscrowSrc clone hasn't been
    // withdrawn yet, the DB is stale. Reset it so the user can refill.
    if (status === 'withdrawn') {
      await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})
      return 'already-claimed'
    }
    console.log(`[ccClaimSlot] no Chain B event and Chain A not withdrawn → resetting slot ${slotIndex} to available`)
    await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/reset`).catch(() => {})
    return 'reset-to-available'
  }

  const secret = (logs[0] as ethers.Event).args!.secret as string
  console.log(`[ccClaimSlot] S_${slotIndex}=${secret.slice(0,10)}…  withdrawing on Chain A…`)

  // Already withdrawn on-chain (WETH already sent, DB just stale)
  if (status === 'withdrawn') {
    console.log(`[ccClaimSlot] slot ${slotIndex} already withdrawn on-chain — marking done in DB`)
    await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})
    return 'already-claimed'
  }

  const withdrawTx = await escrowA.withdraw(secret).catch((e: any) => {
    throw new Error(`[step C] withdraw reverted — ${e.reason ?? e.message ?? e}`)
  })
  await withdrawTx.wait()
  console.log(`[ccClaimSlot] ✔ WETH withdrawn  tx=${withdrawTx.hash}`)

  // Mark slot 'done' in backend DB so the dev UI stops showing "⚡ Claim WETH"
  await axios.patch(`${BACKEND_URL}/cc/orders/${orderHash}/slots/${slotIndex}/done`).catch(() => {})

  return withdrawTx.hash
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
