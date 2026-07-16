import { ethers } from 'ethers'
import { getChain } from '../config/chains'
import { ESCROW_SRC_FACTORY_ABI, ESCROW_DST_FACTORY_ABI, ESCROW_DST_ABI } from '../chain/abis'

// Backend never trusts a filler's self-report of "I deployed a genuine escrow" —
// it re-derives the CREATE2 address from the registered factory and checks the
// on-chain code actually lives there. A filler cannot forge an escrow at that
// exact address without going through the real factory (CREATE2 is
// deterministic on (factory, salt, implementation bytecode) — see each
// factory's own file header). Genuine ⇔ address-match + code present.

export interface GenuineCheck {
  ok: boolean
  reason?: string
}

// Điểm B (and general use): is `escrowAddr` really the EscrowSrc clone
// EscrowSrcFactory would deploy for (orderHash, hashlock) on `chainId`?
export async function assertGenuineSrcClone(
  chainId: number,
  orderHash: string,
  hashlock: string,
  escrowAddr: string,
): Promise<GenuineCheck> {
  const chain = getChain(chainId)
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
  const factory = new ethers.Contract(chain.escrowSrcFactory, ESCROW_SRC_FACTORY_ABI, provider)

  const predicted: string = await factory.computeAddress(orderHash, hashlock)
  if (predicted.toLowerCase() !== escrowAddr.toLowerCase()) {
    return { ok: false, reason: `escrow ${escrowAddr} != CREATE2-predicted ${predicted} for this (orderHash, hashlock)` }
  }
  const code = await provider.getCode(escrowAddr)
  if (code === '0x') return { ok: false, reason: 'no contract code at the predicted escrow address yet' }
  return { ok: true }
}

// Điểm A: is `escrowAddr` really the EscrowDst clone EscrowDstFactory would
// deploy for (hashlock, filler) on `chainId`, AND does it hold the terms the
// backend committed to at quote time (recipient/token/amount/expiry)?
export async function assertGenuineDstClone(
  chainId: number,
  hashlock: string,
  filler: string,
  escrowAddr: string,
  expected: { recipient: string; token: string; minAmount: bigint; expiry: number },
): Promise<GenuineCheck> {
  const chain = getChain(chainId)
  const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
  const factory = new ethers.Contract(chain.escrowDstFactory, ESCROW_DST_FACTORY_ABI, provider)

  const predicted: string = await factory.computeAddress(hashlock, filler)
  if (predicted.toLowerCase() !== escrowAddr.toLowerCase()) {
    return { ok: false, reason: `escrow ${escrowAddr} != CREATE2-predicted ${predicted} for this (hashlock, filler)` }
  }
  const code = await provider.getCode(escrowAddr)
  if (code === '0x') return { ok: false, reason: 'no contract code at the predicted escrow address yet' }

  const escrow = new ethers.Contract(escrowAddr, ESCROW_DST_ABI, provider)
  const [recipient, token, amount, expiry] = await Promise.all([
    escrow.recipient() as Promise<string>,
    escrow.token() as Promise<string>,
    escrow.amount() as Promise<ethers.BigNumber>,
    escrow.expiry() as Promise<ethers.BigNumber>,
  ])

  if (recipient.toLowerCase() !== expected.recipient.toLowerCase()) {
    return { ok: false, reason: `recipient ${recipient} != expected swapper ${expected.recipient}` }
  }
  if (token.toLowerCase() !== expected.token.toLowerCase()) {
    return { ok: false, reason: `token ${token} != expected output token ${expected.token}` }
  }
  if (amount.toBigInt() < expected.minAmount) {
    return { ok: false, reason: `amount ${amount} below required ${expected.minAmount}` }
  }
  if (BigInt(expiry.toString()) !== BigInt(expected.expiry)) {
    return { ok: false, reason: `expiry ${expiry} != committed t2 ${expected.expiry}` }
  }
  return { ok: true }
}
