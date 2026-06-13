import { ethers } from 'ethers'

// Standard Anvil/Hardhat dev mnemonic — same 10 accounts Anvil unlocks by default.
const MNEMONIC = 'test test test test test test test test test test test junk'
const NUM_ACCOUNTS = 10

export interface DevAccount {
  index:      number
  address:    string
  privateKey: string
}

export function getDevAccounts(): DevAccount[] {
  const accounts: DevAccount[] = []
  for (let i = 0; i < NUM_ACCOUNTS; i++) {
    const wallet = ethers.Wallet.fromMnemonic(MNEMONIC, `m/44'/60'/0'/0/${i}`)
    accounts.push({ index: i, address: wallet.address, privateKey: wallet.privateKey })
  }
  return accounts
}
