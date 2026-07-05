import { ethers } from 'ethers'
import { provider, wallet } from '../contract/contracts'
import { SUPPORTED_TOKENS, CHAIN_B_RPC } from '../config'

// Dev-only inventory seeder.
// Run once at startup (auto) or manually: `npm run seed`.
// Gives the filler wallet "infinite-ish" money on a mainnet Anvil fork so it can
// fill any order regardless of size: a big ETH balance (gas + stake collateral),
// WETH wrapped from ETH, and major ERC-20s pulled from a Binance hot wallet.
// Seeds both Chain A and (if configured) Chain B so the filler can serve
// orders in either direction without relying on setup_cc.sh's fixed amounts.

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

// Deep-balance addresses on a mainnet fork, tried in order until one has
// enough for the FULL target (fundFromWhale needs ONE whale to cover it all,
// not a sum across several). Binance 14 covers USDT/UNI comfortably; the rest
// are stablecoin/LINK-specific fallbacks — needed because Binance 14's own
// USDC/DAI/LINK balances (exchange hot wallet, moves around) now sit BELOW
// what CoWFiller+WhaleFiller need if both seed from the same fork:
//   - Curve 3pool: deep DAI + USDC + USDT reserve (protocol reserve, not a
//     wallet that drains — refilled by swap activity)
//   - Aave V3 aUSDC reserve: extra-deep USDC backup
//   - deep LINK pool: LINK backup (Binance 14 alone is short of the 1M target)
// Re-verify with `cast call <token> "balanceOf(address)(uint256)" <whale>
// --rpc-url <RPC>` if seeding starts failing again — WBTC is deliberately
// NOT chased with a bigger whale (see the WBTC target comment below).
const WHALES = [
  '0x28C6c06298d514Db089934071355E5743bf21d60', // Binance 14
  '0xF977814e90dA44bFA03b6295A0616a897441aceC', // Binance 8 (fallback)
  '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', // Curve 3pool (DAI/USDC/USDT fallback)
  '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c', // Aave V3 aUSDC reserve (USDC fallback)
  '0xa6Cc3C2531FdaA6Ae1A3CA84c2855806728693e8', // Deep LINK pool (LINK fallback)
]

// Human-readable seed targets per symbol (converted to raw via token decimals).
const TARGETS: Record<string, string> = {
  WETH: '5000',
  // SEED_USDC_TARGET lets a test cap the filler's output inventory (and thus its
  // per-fill capacity) below an order size — e.g. to force cooperative partial
  // fills. Defaults to the "infinite-ish" 20M for normal dev/demo use.
  USDC: process.env.SEED_USDC_TARGET || '20000000',
  USDT: '20000000',
  DAI:  '1000000',
  // WBTC is genuinely scarce on-chain (~150k total supply) — no single current
  // whale comfortably clears more than a few hundred WBTC, unlike the
  // stablecoins. 100 stays comfortably under Binance 14's own balance, so no
  // extra whale is needed for this one; don't raise it without re-checking.
  WBTC: '100',
  LINK: '1000000',
  UNI:  '1000000',
}
const ETH_BALANCE = '100000' // ether — for gas + staking collateral

const WETH_ABI  = ['function deposit() payable', 'function balanceOf(address) view returns (uint256)']
const ERC20_ABI = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']

async function fundEth(provider: ethers.providers.JsonRpcProvider, wallet: ethers.Wallet, label: string): Promise<void> {
  await provider.send('anvil_setBalance', [
    wallet.address,
    ethers.utils.hexValue(ethers.utils.parseEther(ETH_BALANCE)),
  ])
  console.log(`[seed:${label}] ETH balance → ${ETH_BALANCE} ETH`)
}

async function wrapWeth(provider: ethers.providers.JsonRpcProvider, wallet: ethers.Wallet, target: bigint, label: string): Promise<void> {
  const weth = new ethers.Contract(WETH, WETH_ABI, wallet)
  const bal  = (await weth.balanceOf(wallet.address)).toBigInt()
  if (bal >= target) { console.log(`[seed:${label}] WETH already funded`); return }
  const tx = await weth.deposit({ value: target - bal })
  await tx.wait()
  console.log(`[seed:${label}] WETH → ${ethers.utils.formatEther(target)}`)
}

async function fundFromWhale(
  provider: ethers.providers.JsonRpcProvider, wallet: ethers.Wallet,
  token: string, target: bigint, symbol: string, decimals: number, label: string
): Promise<void> {
  const erc = new ethers.Contract(token, ERC20_ABI, provider)
  const bal = (await erc.balanceOf(wallet.address)).toBigInt()
  if (bal >= target) { console.log(`[seed:${label}] ${symbol} already funded`); return }
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
      console.log(`[seed:${label}] ${symbol} → ${ethers.utils.formatUnits(target, decimals)} (from ${whale.slice(0, 8)}…)`)
      return
    } catch {
      await provider.send('anvil_stopImpersonatingAccount', [whale]).catch(() => {})
    }
  }
  console.warn(`[seed:${label}] ⚠ could not fund ${symbol} from any whale — continuing`)
}

async function seedChain(provider: ethers.providers.JsonRpcProvider, wallet: ethers.Wallet, label: string): Promise<void> {
  console.log(`[seed:${label}] funding ${wallet.address} …`)
  await fundEth(provider, wallet, label)
  for (const [addr, meta] of Object.entries(SUPPORTED_TOKENS)) {
    const human = TARGETS[meta.symbol]
    if (!human) continue
    const target = ethers.utils.parseUnits(human, meta.decimals).toBigInt()
    if (meta.symbol === 'WETH') await wrapWeth(provider, wallet, target, label)
    else                        await fundFromWhale(provider, wallet, addr, target, meta.symbol, meta.decimals, label)
  }
  console.log(`[seed:${label}] done.`)
}

export async function seedInventory(): Promise<void> {
  await seedChain(provider, wallet, 'Chain A')
  if (CHAIN_B_RPC) {
    const providerB = new ethers.providers.JsonRpcProvider(CHAIN_B_RPC)
    const walletB   = wallet.connect(providerB)
    await seedChain(providerB, walletB, 'Chain B')
  }
}

// Allow running standalone: `npm run seed`
if (require.main === module) {
  seedInventory()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[seed] failed:', e); process.exit(1) })
}
