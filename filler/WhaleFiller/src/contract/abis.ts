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
  'function fillAuction() view returns (address)',
]

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]

export const CC_REACTOR_ABI = [
  'function registerFiller(bytes32 orderHash, uint8 slotIndex) external',
  'function claimSlot(bytes32 orderHash, uint8 slotIndex, bytes32 secret, bytes32[] calldata merkleProof) external',
  'function slotFiller(bytes32 orderHash, uint8 slotIndex) view returns (address)',
  'function isSlotClaimed(bytes32 orderHash, uint8 slotIndex) view returns (bool)',
]

export const ESCROW_FACTORY_ABI = [
  'function computeAddress(bytes32 hashlock, address filler) view returns (address)',
  'function deploy(bytes32 hashlock, address recipient, address token, uint256 amount, uint256 expiry) returns (address)',
]

export const ESCROW_DST_ABI = [
  'event Claimed(address indexed claimer, bytes32 secret)',
]

// Uniswap V3 pool — only slot0 is needed to read the current price.
export const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
]
