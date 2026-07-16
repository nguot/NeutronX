export const FILL_AUCTION_ABI = [
  'function hasValidRegistration(bytes32, address, uint256) view returns (bool)',
  'function pendingReturns(address) view returns (uint256)',
  'function withdraw(address payable to) external',
  // D-1: exact ETH collateral for a fill (handles the TWAP + token decimals)
  'function previewCollateral(address inputToken, uint24 feeTier, uint256 fillAmount, uint256 deadline) view returns (uint256)',
  'function releaseRegistration(bytes32 orderHash, address filler) external',
]

export const REACTOR_ABI = [
  'function executePartialChunk(tuple(tuple(address swapper, address inputToken, uint256 inputAmount, address outputToken, uint256 minOutputAmount, uint256 deadline, uint256 nonce, uint16 minFillBps, uint128 startPrice, uint32 decayPerBlock, uint24 feeTier) info, bytes sig) order, uint256 fillAmount) external',
  'function register(tuple(tuple(address swapper, address inputToken, uint256 inputAmount, address outputToken, uint256 minOutputAmount, uint256 deadline, uint256 nonce, uint16 minFillBps, uint128 startPrice, uint32 decayPerBlock, uint24 feeTier) info, bytes sig) order, uint256 fillAmount) external payable',
  'function remainingInput(bytes32, uint256) view returns (uint256)',
  'function isCancelled(bytes32) view returns (bool)',
  'function fillAuction() view returns (address)',
]

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]

// Model 2 (filler-holds-key, continuous fill) — mirrors backend/src/chain/abis.ts.
// No more merkleRoot/numSlots/cosignerSig/slotIndex — per-fill hashlock chosen
// by the filler itself, on-chain `remaining`, swapper-only signatures.
export const ESCROW_SRC_FACTORY_ABI = [
  'function fillSlot((address swapper,address inputToken,uint256 inputAmount,address outputToken,uint256 minOutput,uint256 deadlineBase,uint256 nonce,uint24 feeTier) info, bytes swapperSig, (bytes32 orderHash,bytes32 hashlock,uint256 fillAmount,uint256 t1,uint256 t2) auth, bytes perFillSig) external payable returns (address escrow)',
  'function computeAddress(bytes32 orderHash, bytes32 hashlock) view returns (address)',
  'function isFilled(bytes32 orderHash, bytes32 hashlock) view returns (bool)',
  'function remainingInput(bytes32 orderHash, uint256 orderAmount) view returns (uint256)',
  'function previewRequiredStake(uint256 fillAmount, address inputToken, uint24 feeTier, uint256 t1) view returns (uint256)',
  'function hashOrder((address swapper,address inputToken,uint256 inputAmount,address outputToken,uint256 minOutput,uint256 deadlineBase,uint256 nonce,uint24 feeTier) info) pure returns (bytes32)',
  'function hashFill((bytes32 orderHash,bytes32 hashlock,uint256 fillAmount,uint256 t1,uint256 t2) auth) pure returns (bytes32)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
]

export const ESCROW_SRC_ABI = [
  'function filler() view returns (address)',
  'function status() view returns (string)',
  'function withdraw(bytes32 secret) external',
  'function cancel() external',
  'event Withdrawn(address indexed filler, bytes32 secret)',
  'event Cancelled(address indexed swapper, uint256 amount, address indexed canceller, uint256 safetyDeposit)',
]

export const ESCROW_FACTORY_ABI = [
  'function computeAddress(bytes32 hashlock, address filler) view returns (address)',
  'function deploy(bytes32 hashlock, address recipient, address token, uint256 amount, uint256 expiry) returns (address)',
]

export const ESCROW_DST_ABI = [
  'function claimed() view returns (bool)',
  'function refunded() view returns (bool)',
  'function refund() external',
  'event Claimed(address indexed claimer, bytes32 secret)',
]

// Uniswap V3 pool — only slot0 is needed to read the current price.
export const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
]
