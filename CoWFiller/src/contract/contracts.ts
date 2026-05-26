import { ethers } from 'ethers'
import { RPC_URL, PRIVATE_KEY, FILL_AUCTION, REACTOR } from '../config'
import { FILL_AUCTION_ABI, REACTOR_ABI, ERC20_ABI } from './abis'

export const provider    = new ethers.providers.JsonRpcProvider(RPC_URL)
export const wallet      = new ethers.Wallet(PRIVATE_KEY, provider)
export const fillAuction = new ethers.Contract(FILL_AUCTION, FILL_AUCTION_ABI, wallet)
export const reactor     = new ethers.Contract(REACTOR,      REACTOR_ABI,      wallet)

export const erc20 = (address: string) =>
  new ethers.Contract(address, ERC20_ABI, wallet)
