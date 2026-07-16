// Model 2 (filler-holds-key, continuous fill) ABIs — mirrors
// contract/src/crosschain/{EscrowSrc,EscrowSrcFactory,EscrowDst,EscrowDstFactory}.sol
// after the intent redesign. No more merkleRoot/numSlots/cosignerSig/slotIndex —
// per-fill hashlock + on-chain `remaining`, swapper-only signatures.

export const ESCROW_SRC_FACTORY_ABI = [
  'function fillSlot((address swapper,address inputToken,uint256 inputAmount,address outputToken,uint256 minOutput,uint256 deadlineBase,uint256 nonce,uint24 feeTier) info, bytes swapperSig, (bytes32 orderHash,bytes32 hashlock,uint256 fillAmount,uint256 t1,uint256 t2) auth, bytes perFillSig) external payable returns (address escrow)',
  'function computeAddress(bytes32 orderHash, bytes32 hashlock) view returns (address)',
  'function isFilled(bytes32 orderHash, bytes32 hashlock) view returns (bool)',
  'function remainingInput(bytes32 orderHash, uint256 orderAmount) view returns (uint256)',
  'function previewRequiredStake(uint256 fillAmount, address inputToken, uint24 feeTier, uint256 t1) view returns (uint256)',
  'function hashOrder((address swapper,address inputToken,uint256 inputAmount,address outputToken,uint256 minOutput,uint256 deadlineBase,uint256 nonce,uint24 feeTier) info) pure returns (bytes32)',
  'function hashFill((bytes32 orderHash,bytes32 hashlock,uint256 fillAmount,uint256 t1,uint256 t2) auth) pure returns (bytes32)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'event Filled(bytes32 indexed orderHash, bytes32 indexed hashlock, address indexed filler, address escrow, uint256 fillAmount, uint256 bondAmount, uint256 t1, uint256 t2)',
]

export const ESCROW_SRC_ABI = [
  'function filler() view returns (address)',
  'function swapper() view returns (address)',
  'function hashlock() view returns (bytes32)',
  'function amount() view returns (uint256)',
  'function expiry() view returns (uint256)',
  'function claimed() view returns (bool)',
  'function cancelled() view returns (bool)',
  'function status() view returns (string)',
  'function withdraw(bytes32 secret) external',
  'function cancel() external',
  'event Withdrawn(address indexed filler, bytes32 secret)',
  'event Cancelled(address indexed swapper, uint256 amount, address indexed canceller, uint256 safetyDeposit)',
]

export const ESCROW_DST_FACTORY_ABI = [
  'function computeAddress(bytes32 hashlock, address filler) view returns (address)',
  'function deploy(bytes32 hashlock, address recipient, address token, uint256 amount, uint256 expiry) returns (address)',
  'event EscrowCreated(address indexed escrow, address indexed filler, bytes32 indexed hashlock, address recipient, address token, uint256 amount, uint256 expiry)',
]

export const ESCROW_DST_ABI = [
  'function filler() view returns (address)',
  'function recipient() view returns (address)',
  'function token() view returns (address)',
  'function amount() view returns (uint256)',
  'function expiry() view returns (uint256)',
  'function claimed() view returns (bool)',
  'function refunded() view returns (bool)',
  'function claim(bytes32 secret) external',
  'function refund() external',
  'event Claimed(address indexed claimer, bytes32 secret)',
  'event Refunded(address indexed filler, uint256 amount)',
]

export const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
]
