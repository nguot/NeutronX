import { useState, useCallback, useEffect } from 'react'
import { ethers } from 'ethers'

export interface WalletState {
  provider:    ethers.providers.Web3Provider | null
  signer:      ethers.Signer | null
  account:     string
  blockNumber: number
  chainId:     number
  connected:   boolean
}

const INITIAL: WalletState = { provider: null, signer: null, account: '', blockNumber: 0, chainId: 0, connected: false }

// Map of supported local Anvil chains -> RPC URL, used for wallet_addEthereumChain fallback.
const CHAIN_RPCS: Record<number, { name: string; rpc: string }> = {
  31337: { name: 'Anvil Local',  rpc: 'http://127.0.0.1:8545' },
  31338: { name: 'Anvil Chain B', rpc: 'http://127.0.0.1:8546' },
}

// Build wallet state from whatever account MetaMask currently exposes
// (assumes the site is already authorized — does not prompt).
async function buildState(): Promise<WalletState | null> {
  if (!window.ethereum) return null

  const hexChainId  = await window.ethereum.request({ method: 'eth_chainId' })
  const chainId     = parseInt(hexChainId, 16)

  const web3Provider = new ethers.providers.Web3Provider(window.ethereum)
  // Override getNetwork to the wallet's current chain (avoids ethers' "underlying
  // network changed" errors on Anvil, and keeps tx.chainId in sync with MetaMask
  // so writes — e.g. Permit2 approvals on Chain B — aren't rejected by MetaMask).
  ;(web3Provider as any).getNetwork = async () => ({ name: 'anvil', chainId })

  const signer      = web3Provider.getSigner()
  const account     = await signer.getAddress()
  const blockNumber = await web3Provider.getBlockNumber()

  return { provider: web3Provider, signer, account, blockNumber, chainId, connected: true }
}

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState>(INITIAL)
  const [error,  setError]  = useState('')

  // Switch (or add) MetaMask's active network to one of the local Anvil chains.
  const switchChain = useCallback(async (targetChainId: number) => {
    if (!window.ethereum) throw new Error('MetaMask not found')
    const target = CHAIN_RPCS[targetChainId]
    if (!target) throw new Error(`Unknown chain ${targetChainId}`)
    const hexChainId = `0x${targetChainId.toString(16)}`
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] })
    } catch (e: any) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{ chainId: hexChainId, chainName: target.name, rpcUrls: [target.rpc],
                     nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 } }],
        })
      } else throw e
    }
  }, [])

  const connect = useCallback(async () => {
    setError('')
    try {
      if (!window.ethereum) throw new Error('MetaMask not found')

      await switchChain(31337)
      await window.ethereum.request({ method: 'eth_requestAccounts' })

      const state = await buildState()
      if (state) setWallet(state)
    } catch (e: any) {
      setError(e.message)
    }
  }, [switchChain])

  // Switch MetaMask's network and refresh wallet state — used by pages that need
  // the wallet on a specific chain (e.g. the cross-chain swap's source chain).
  // Rethrows on failure so callers (e.g. a "Switch network" button) can show why.
  const switchNetwork = useCallback(async (targetChainId: number) => {
    setError('')
    try {
      await switchChain(targetChainId)
      // MetaMask can keep reporting the previous eth_chainId for a brief moment
      // after wallet_switchEthereumChain/wallet_addEthereumChain resolves — poll briefly.
      let state: WalletState | null = null
      for (let i = 0; i < 10; i++) {
        state = await buildState()
        if (state?.chainId === targetChainId) break
        await new Promise(r => setTimeout(r, 200))
      }
      if (state) setWallet(state)
      if (!state || state.chainId !== targetChainId) {
        throw new Error(`MetaMask is still on chain ${state?.chainId ?? 'unknown'} — switch to chain ${targetChainId} manually and try again.`)
      }
    } catch (e: any) {
      setError(e.message)
      throw e
    }
  }, [switchChain])

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

  return { wallet, error, connect, switchNetwork }
}

// Extend window type for MetaMask
declare global {
  interface Window { ethereum?: any }
}
