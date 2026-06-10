import { ethers } from 'ethers'
import { provider, wallet } from '../contract/contracts'

const WETH        = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
// Binance 14 — holds billions in USDC, USDT, and most major ERC-20s on mainnet fork
const BINANCE_14  = '0x28C6c06298d514Db089934071355E5743bf21d60'

const WETH_ABI  = ['function deposit() payable']
const ERC20_ABI = [
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]

/**
 * Ensures the filler wallet holds at least `minAmount` of `tokenAddress`.
 * - WETH: wraps ETH directly (Anvil accounts start with 10 000 ETH)
 * - Everything else: impersonates Binance 14 whale on the Anvil fork and transfers
 */
export async function devEnsureOutputToken(
  tokenAddress: string,
  minAmount:    bigint,
): Promise<void> {
  if (tokenAddress.toLowerCase() === WETH.toLowerCase()) {
    const weth = new ethers.Contract(WETH, WETH_ABI, wallet)
    const tx   = await weth.deposit({ value: minAmount })
    await tx.wait()
    console.log(`[DevFund] wrapped ${ethers.utils.formatEther(minAmount)} ETH → WETH`)
    return
  }

  const token: ethers.Contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
  const balance: ethers.BigNumber = await token.balanceOf(wallet.address)
  if (balance.toBigInt() >= minAmount) return

  const needed = minAmount - balance.toBigInt() + minAmount / 10n // 10 % buffer

  // Fund whale with a tiny bit of ETH for gas, then impersonate
  await provider.send('anvil_setBalance', [
    BINANCE_14,
    ethers.utils.hexValue(ethers.utils.parseEther('1')),
  ])
  await provider.send('anvil_impersonateAccount', [BINANCE_14])

  const whaleSigner  = provider.getSigner(BINANCE_14)
  const tokenAsWhale = new ethers.Contract(tokenAddress, ERC20_ABI, whaleSigner)
  const tx           = await tokenAsWhale.transfer(wallet.address, needed)
  await tx.wait()

  await provider.send('anvil_stopImpersonatingAccount', [BINANCE_14])
  console.log(`[DevFund] got ${needed} of ${tokenAddress} from whale`)
}
