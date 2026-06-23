import { ethers } from 'ethers'
import { provider, wallet } from '../contract/contracts'

// Dev-only inventory top-up. On a mainnet Anvil fork the filler needs output
// tokens on hand to settle a fill; this mints/sources just enough on demand:
// WETH is wrapped from the wallet's ETH, every other ERC-20 is pulled from a
// Binance hot wallet via impersonation. In a real deployment the filler would
// already hold its inventory and this module would not exist.

const WETH       = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const BINANCE_14 = '0x28C6c06298d514Db089934071355E5743bf21d60'

const WETH_ABI  = ['function deposit() payable']
const ERC20_ABI = [
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]

export async function ensureOutputToken(tokenAddress: string, minAmount: bigint): Promise<void> {
  if (tokenAddress.toLowerCase() === WETH.toLowerCase()) {
    const weth = new ethers.Contract(WETH, WETH_ABI, wallet)
    const tx   = await weth.deposit({ value: minAmount })
    await tx.wait()
    console.log(`[inventory] wrapped ${ethers.utils.formatEther(minAmount)} ETH → WETH`)
    return
  }

  const token   = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
  const balance = (await token.balanceOf(wallet.address)).toBigInt()
  if (balance >= minAmount) return

  const needed = minAmount - balance + minAmount / 10n

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
  console.log(`[inventory] sourced ${needed} of ${tokenAddress} from whale`)
}
