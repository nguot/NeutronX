import { ethers } from 'ethers'
import { provider, wallet } from '../contract/contracts'

// Dev-only inventory top-up. On a mainnet Anvil fork the filler needs output
// tokens on hand to settle a fill; this mints/sources just enough on demand:
// WETH is wrapped from the wallet's ETH, every other ERC-20 is pulled from a
// Binance hot wallet via impersonation. In a real deployment the filler would
// already hold its inventory and this module would not exist.

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

// Deep-balance addresses, tried in order until one has enough. Binance 14
// alone used to be enough, but its USDC balance (a common output token here)
// has since dropped well below what this module can need — the extra two are
// stablecoin-specific protocol reserves that don't drain like an exchange
// wallet does. Re-verify with `cast call <token>
// "balanceOf(address)(uint256)" <whale> --rpc-url <RPC>` if sourcing starts
// failing again.
const WHALES = [
  '0x28C6c06298d514Db089934071355E5743bf21d60', // Binance 14
  '0xF977814e90dA44bFA03b6295A0616a897441aceC', // Binance 8 (fallback)
  '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', // Curve 3pool (DAI/USDC/USDT fallback)
  '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c', // Aave V3 aUSDC reserve (USDC fallback)
]

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

  for (const whale of WHALES) {
    try {
      await provider.send('anvil_setBalance', [whale, ethers.utils.hexValue(ethers.utils.parseEther('1'))])
      await provider.send('anvil_impersonateAccount', [whale])
      const whaleBal = (await new ethers.Contract(tokenAddress, ERC20_ABI, provider).balanceOf(whale)).toBigInt()
      if (whaleBal < needed) {
        await provider.send('anvil_stopImpersonatingAccount', [whale])
        continue
      }
      const whaleSigner  = provider.getSigner(whale)
      const tokenAsWhale = new ethers.Contract(tokenAddress, ERC20_ABI, whaleSigner)
      const tx           = await tokenAsWhale.transfer(wallet.address, needed)
      await tx.wait()
      await provider.send('anvil_stopImpersonatingAccount', [whale])
      console.log(`[inventory] sourced ${needed} of ${tokenAddress} from ${whale.slice(0, 8)}…`)
      return
    } catch {
      await provider.send('anvil_stopImpersonatingAccount', [whale]).catch(() => {})
    }
  }
  console.warn(`[inventory] ⚠ could not source ${tokenAddress} from any whale`)
}
