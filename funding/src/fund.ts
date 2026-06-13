import * as dotenv from 'dotenv'
dotenv.config()

import { ethers } from 'ethers'
import { getDevAccounts } from './accounts'
import { TOKENS, WETH, WHALES } from './tokens'

// Funds every standard Anvil dev account (0-9) with ETH + every token in TOKENS.
// Run once after starting a fresh Anvil fork: `npm run fund`.

const RPC_URL     = process.env.RPC_URL || process.env.ALCHEMY_RPC_URL || 'http://127.0.0.1:8545'
const ETH_BALANCE = '10000' // ether — plenty for gas across all test accounts

const provider = new ethers.providers.JsonRpcProvider(RPC_URL)

const WETH_ABI  = ['function deposit() payable', 'function balanceOf(address) view returns (uint256)']
const ERC20_ABI = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']

async function fundEth(address: string): Promise<void> {
  await provider.send('anvil_setBalance', [
    address,
    ethers.utils.hexValue(ethers.utils.parseEther(ETH_BALANCE)),
  ])
}

// Each dev account holds its own private key, so it can wrap its own ETH into
// WETH directly — no whale impersonation needed.
async function wrapWeth(wallet: ethers.Wallet, target: bigint): Promise<void> {
  const weth = new ethers.Contract(WETH, WETH_ABI, wallet)
  const bal  = (await weth.balanceOf(wallet.address)).toBigInt()
  if (bal >= target) return
  const tx = await weth.deposit({ value: target - bal })
  await tx.wait()
}

async function fundFromWhale(token: string, recipient: string, target: bigint, symbol: string, decimals: number): Promise<void> {
  const erc = new ethers.Contract(token, ERC20_ABI, provider)
  const bal = (await erc.balanceOf(recipient)).toBigInt()
  if (bal >= target) return
  const need = target - bal

  for (const whale of WHALES) {
    try {
      await provider.send('anvil_setBalance', [whale, ethers.utils.hexValue(ethers.utils.parseEther('1'))])
      await provider.send('anvil_impersonateAccount', [whale])
      const whaleBal = (await erc.balanceOf(whale)).toBigInt()
      if (whaleBal < need) {
        await provider.send('anvil_stopImpersonatingAccount', [whale])
        continue
      }
      const signer = provider.getSigner(whale)
      const tx = await new ethers.Contract(token, ERC20_ABI, signer).transfer(recipient, need)
      await tx.wait()
      await provider.send('anvil_stopImpersonatingAccount', [whale])
      console.log(`  [${symbol}] +${ethers.utils.formatUnits(need, decimals)} (from ${whale.slice(0, 8)}…)`)
      return
    } catch {
      await provider.send('anvil_stopImpersonatingAccount', [whale]).catch(() => {})
    }
  }
  console.warn(`  [${symbol}] could not fund from any whale — skipping`)
}

async function fundAccount(address: string, privateKey: string): Promise<void> {
  await fundEth(address)
  console.log(`  [ETH]  → ${ETH_BALANCE}`)

  const wallet = new ethers.Wallet(privateKey, provider)

  for (const [symbol, meta] of Object.entries(TOKENS)) {
    const target = ethers.utils.parseUnits(meta.target, meta.decimals).toBigInt()
    if (symbol === 'WETH') {
      await wrapWeth(wallet, target)
      console.log(`  [WETH] → ${meta.target}`)
    } else {
      await fundFromWhale(meta.address, address, target, symbol, meta.decimals)
    }
  }
}

async function main(): Promise<void> {
  const accounts = getDevAccounts()
  console.log(`[Fund] funding ${accounts.length} dev accounts via ${RPC_URL}`)

  for (const acc of accounts) {
    console.log(`\n[Fund] account #${acc.index} ${acc.address}`)
    await fundAccount(acc.address, acc.privateKey)
  }

  console.log('\n[Fund] done.')
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('[Fund] failed:', e); process.exit(1) })
