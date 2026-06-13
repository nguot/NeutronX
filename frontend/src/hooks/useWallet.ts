import { useState, useCallback, useEffect } from 'react'
import { ethers } from 'ethers'

export interface WalletState {
  provider:    ethers.providers.Web3Provider | null
  signer:      ethers.Signer | null
  account:     string
  blockNumber: number
  connected:   boolean
}

const INITIAL: WalletState = { provider: null, signer: null, account: '', blockNumber: 0, connected: false }

// Build wallet state from whatever account MetaMask currently exposes
// (assumes the site is already authorized — does not prompt).
async function buildState(): Promise<WalletState | null> {
  if (!window.ethereum) return null

  const web3Provider = new ethers.providers.Web3Provider(window.ethereum)
  // Override getNetwork to always return 31337 (avoids MetaMask chain ID quirks on Anvil)
  ;(web3Provider as any).getNetwork = async () => ({ name: 'anvil', chainId: 31337 })

  const signer      = web3Provider.getSigner()
  const account     = await signer.getAddress()
  const blockNumber = await web3Provider.getBlockNumber()

  return { provider: web3Provider, signer, account, blockNumber, connected: true }
}

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState>(INITIAL)
  const [error,  setError]  = useState('')

  const connect = useCallback(async () => {
    setError('')
    try {
      if (!window.ethereum) throw new Error('MetaMask not found')

      // Switch to local Anvil network (chainId 31337 = 0x7a69)
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] })
      } catch (e: any) {
        if (e.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{ chainId: '0x7a69', chainName: 'Anvil Local', rpcUrls: ['http://127.0.0.1:8545'],
                       nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 } }],
          })
        } else throw e
      }

      await window.ethereum.request({ method: 'eth_requestAccounts' })

      const state = await buildState()
      if (state) setWallet(state)
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  // Silently restore an already-authorized connection on page load/reload, and
  // keep wallet state in sync with MetaMask account/network switches —
  // without requiring the user to click "Connect Wallet" again.
  useEffect(() => {
    if (!window.ethereum) return
    let cancelled = false

    ;(async () => {
      try {
        const accounts: string[] = await window.ethereum.request({ method: 'eth_accounts' })
        if (cancelled || accounts.length === 0) return
        const state = await buildState()
        if (!cancelled && state) setWallet(state)
      } catch { /* not yet authorized — user can click Connect Wallet */ }
    })()

    const onAccountsChanged = async (accounts: string[]) => {
      if (accounts.length === 0) { setWallet(INITIAL); return }
      const state = await buildState()
      if (state) setWallet(state)
    }
    const onChainChanged = async () => {
      const state = await buildState()
      if (state) setWallet(state)
    }

    window.ethereum.on?.('accountsChanged', onAccountsChanged)
    window.ethereum.on?.('chainChanged', onChainChanged)

    return () => {
      cancelled = true
      window.ethereum.removeListener?.('accountsChanged', onAccountsChanged)
      window.ethereum.removeListener?.('chainChanged', onChainChanged)
    }
  }, [])

  return { wallet, error, connect }
}

// Extend window type for MetaMask
declare global {
  interface Window { ethereum?: any }
}
