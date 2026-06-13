import { ethers } from 'ethers'
import { provider, wallet } from '../contract/contracts'
import { SUPPORTED_TOKENS } from '../config'

// Dev-mode inventory seeder.
// Run once at startup (auto, in DEV_MODE) or manually: `npm run fund`.
// Gives the filler wallet "infinite-ish" money on a mainnet Anvil fork so it can
// fill any order regardless of size: a big ETH balance (gas + stake collateral),
// WETH wrapped from ETH, and major ERC-20s pulled from a Binance hot wallet.

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

// Binance hot wallets — deep balances of major tokens on a mainnet fork.
const WHALES = [
  '0x28C6c06298d514Db089934071355E5743bf21d60', // Binance 14
  '0xF977814e90dA44bFA03b6295A0616a897441aceC', // Binance 8 (fallback)
]

// Human-readable seed targets per symbol (converted to raw via token decimals).
const TARGETS: Record<string, string> = {
  WETH: '5000',
  USDC: '20000000',
  USDT: '20000000',
  DAI:  '5000000',
  WBTC: '500',
  LINK: '1000000',
  UNI:  '1000000',
}
const ETH_BALANCE = '100000' // ether — for gas + staking collateral

const WETH_ABI  = ['function deposit() payable', 'function balanceOf(address) view returns (uint256)']
const ERC20_ABI = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']

async function fundEth(): Promise<void> {
  await provider.send('anvil_setBalance', [
    wallet.address,
    ethers.utils.hexValue(ethers.utils.parseEther(ETH_BALANCE)),
  ])
  console.log(`[Seed] ETH balance → ${ETH_BALANCE} ETH`)
}

async function wrapWeth(target: bigint): Promise<void> {
  const weth = new ethers.Contract(WETH, WETH_ABI, wallet)
  const bal  = (await weth.balanceOf(wallet.address)).toBigInt()
  if (bal >= target) { console.log('[Seed] WETH already funded'); return }
  const tx = await weth.deposit({ value: target - bal })
  await tx.wait()
  console.log(`[Seed] WETH → ${ethers.utils.formatEther(target)}`)
}

async function fundFromWhale(token: string, target: bigint, symbol: string, decimals: number): Promise<void> {
  const erc = new ethers.Contract(token, ERC20_ABI, provider)
  const bal = (await erc.balanceOf(wallet.address)).toBigInt()
  if (bal >= target) { console.log(`[Seed] ${symbol} already funded`); return }
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
      const tx = await new ethers.Contract(token, ERC20_ABI, signer).transfer(wallet.address, need)
      await tx.wait()
      await provider.send('anvil_stopImpersonatingAccount', [whale])
      console.log(`[Seed] ${symbol} → ${ethers.utils.formatUnits(target, decimals)} (from ${whale.slice(0, 8)}…)`)
      return
    } catch {
      await provider.send('anvil_stopImpersonatingAccount', [whale]).catch(() => {})
    }
  }
  console.warn(`[Seed] ⚠ could not fund ${symbol} from any whale — continuing`)
}

export async function seedInventory(): Promise<void> {
  console.log(`[Seed] funding ${wallet.address} …`)
  await fundEth()
  for (const [addr, meta] of Object.entries(SUPPORTED_TOKENS)) {
    const human = TARGETS[meta.symbol]
    if (!human) continue
    const target = ethers.utils.parseUnits(human, meta.decimals).toBigInt()
    if (meta.symbol === 'WETH') await wrapWeth(target)
    else                        await fundFromWhale(addr, target, meta.symbol, meta.decimals)
  }
  console.log('[Seed] done.')
}

// Allow running standalone: `npm run fund`
if (require.main === module) {
  seedInventory()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[Seed] failed:', e); process.exit(1) })
}
