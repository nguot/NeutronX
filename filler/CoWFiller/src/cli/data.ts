import { ethers } from 'ethers'
import { http as axios } from '../httpClient'
import { BACKEND_URL, CHAIN_B_RPC, SUPPORTED_TOKENS } from '../config'
import { ERC20_ABI } from '../contract/abis'
import { provider, wallet } from '../contract/contracts'
import type { OrderInfo } from '../types'

// ── Backend order book ────────────────────────────────────────────────────────

export async function fetchOrders(status: string, limit = 20): Promise<OrderInfo[]> {
  const { data } = await axios.get(`${BACKEND_URL}/orders`, { params: { status, limit } })
  return data.orders ?? []
}

// Open orders = pending + active, merged.
export async function fetchOpenOrders(): Promise<OrderInfo[]> {
  const [pending, active] = await Promise.all([fetchOrders('pending'), fetchOrders('active')])
  return [...pending, ...active]
}

export async function fetchOrder(hash: string): Promise<OrderInfo> {
  const { data } = await axios.get(`${BACKEND_URL}/orders/${hash}`)
  return data
}

export async function fetchCcOrders(): Promise<any[]> {
  const { data } = await axios.get(`${BACKEND_URL}/cc/orders`)
  return data.orders ?? []
}

export async function fetchCcFill(fillId: number): Promise<any> {
  const { data } = await axios.get(`${BACKEND_URL}/cc/fills/${fillId}`)
  return data
}

// ── On-chain block height / balances ──────────────────────────────────────────

export async function currentBlock(): Promise<number> {
  return provider.getBlockNumber()
}

export interface ChainBalances {
  label:  string
  eth:    string
  tokens: { symbol: string; decimals: number; balance: string }[]
}

async function readChain(label: string, p: ethers.providers.JsonRpcProvider): Promise<ChainBalances> {
  const tokenAddrs = Object.keys(SUPPORTED_TOKENS)
  const [ethBal, ...tokenBals] = await Promise.all([
    p.getBalance(wallet.address),
    ...tokenAddrs.map(addr => new ethers.Contract(addr, ERC20_ABI, p).balanceOf(wallet.address)),
  ])
  return {
    label,
    eth: ethBal.toString(),
    tokens: tokenAddrs.map((addr, i) => ({
      symbol:   SUPPORTED_TOKENS[addr].symbol,
      decimals: SUPPORTED_TOKENS[addr].decimals,
      balance:  tokenBals[i].toString(),
    })),
  }
}

// Wallet balances on Chain A and (if configured) Chain B.
export async function readBalances(): Promise<ChainBalances[]> {
  const chains = [await readChain('Chain A', provider)]
  if (CHAIN_B_RPC) chains.push(await readChain('Chain B', new ethers.providers.JsonRpcProvider(CHAIN_B_RPC)))
  return chains
}
