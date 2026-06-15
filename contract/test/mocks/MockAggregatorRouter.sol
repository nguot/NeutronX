// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./MockERC20.sol";

/// Minimal stand-in for a DEX aggregator router (Uniswap, 1inch, ...): pulls
/// `amountIn` of `tokenIn` from the caller (FallbackExecutor, which
/// forceApprove's this contract) and mints `amountOut` of `tokenOut` to
/// `recipient`. Lets FallbackExecutor tests exercise the generic allowlisted
/// router + arbitrary calldata path with a deterministic, fork-price
/// independent swap outcome.
contract MockAggregatorRouter {
    function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut, address recipient) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(recipient, amountOut);
    }

    /// Simulates an exact-output-style route: the caller approved `amountInMax`
    /// but this route only needs to pull `amountInActual` (<= amountInMax),
    /// leaving the unconsumed allowance/balance with the caller.
    function swapPartialIn(address tokenIn, uint256 amountInActual, address tokenOut, uint256 amountOut, address recipient) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountInActual);
        MockERC20(tokenOut).mint(recipient, amountOut);
    }
}
