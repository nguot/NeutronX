// Human-readable ABI for the PartialFillReactor surface Orders.tsx needs to let
// a swapper cancel their own order (see contract/src/PartialFillReactor.sol).
export const REACTOR_ABI = [
  'function invalidateNonce(uint256 nonce) external',
  'function nonceInvalidated(address swapper, uint256 nonce) view returns (bool)',
  'event NonceInvalidated(address indexed swapper, uint256 indexed nonce)',
]
