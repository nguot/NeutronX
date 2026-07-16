import { ethers } from 'ethers'

const ERC_ABI = ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']

// Some tokens (real USDT included) revert on approve(spender, nonzero) while
// the current allowance to that spender is already nonzero — an explicit
// anti-race-condition require() that USDC/DAI don't have. Reset to 0 first
// whenever there's an existing allowance, so this works for every ERC-20.
export async function safeApproveErc20(
  tokenAddress: string,
  spender: string,
  amount: ethers.BigNumberish,
  signer: ethers.Signer,
  owner: string,
) {
  const erc = new ethers.Contract(tokenAddress, ERC_ABI, signer)
  const current = await erc.allowance(owner, spender)
  if (!current.isZero()) {
    await (await erc.approve(spender, 0)).wait()
  }
  await (await erc.approve(spender, amount)).wait()
}
