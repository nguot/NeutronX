import { ethers } from 'ethers'

// Subset of EscrowSrcFactory used by the preflight check (read-only +
// callStatic dry-run of fillSlot). Mirrors filler/*/src/contract/abis.ts.
export const ESCROW_SRC_FACTORY_ABI = [
  'function fillSlot((address swapper,address inputToken,uint256 inputAmount,address outputToken,uint256 minOutput,uint256 deadline,uint256 nonce,bytes32 merkleRoot,uint8 numSlots) info, bytes swapperSig, bytes cosignerSig, uint8 slotIndex, bytes32 hashlock, bytes32[] merkleProof) external payable returns (address escrow)',
  'function isSlotFilled(bytes32 orderHash, uint8 slotIndex) view returns (bool)',
  'function computeAddress(bytes32 orderHash, uint8 slotIndex) view returns (address)',
]

export const ESCROW_SRC_ABI = [
  'function filler() view returns (address)',
]

export const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
]

// Filler's ETH safety deposit required by fillSlot() — same constant the dev
// fillers use (filler/*/src/dev/ccFill.ts SAFETY_DEPOSIT), refunded on withdraw().
export const SAFETY_DEPOSIT = ethers.utils.parseEther('0.01')
