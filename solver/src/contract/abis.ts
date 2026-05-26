// Minimal ABI fragments — only the functions this filler actually calls.

export const FILL_AUCTION_ABI = [
  'function register(bytes32 orderHash, uint256 fillAmount, uint256 orderTotal, uint256 deadline) external payable',
  'function stakeTable(uint256, uint256) view returns (uint32)',
  'function hasValidRegistration(bytes32, address, uint256) view returns (bool)',
  'function pendingReturns(address) view returns (uint256)',
  'function withdraw() external',
]

export const REACTOR_ABI = [
  'function executePartialChunk(tuple(tuple(address swapper, address inputToken, uint256 inputAmount, address outputToken, uint256 minOutputAmount, uint256 deadline, uint256 nonce, uint16 minFillBps, uint128 startPrice, uint32 decayPerBlock, uint24 feeTier) info, bytes sig) order, uint256 fillAmount) external',
  'function remainingInput(bytes32, uint256) view returns (uint256)',
]

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]
