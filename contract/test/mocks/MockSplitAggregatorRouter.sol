// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./MockERC20.sol";

/// Minimal stand-in for ParaSwap's Augustus/TokenTransferProxy split: the
/// proxy (not the router) holds the ERC20 allowance and does the actual
/// `transferFrom`, while the router is the address FallbackExecutor calls
/// into. Exercises that FallbackExecutor's approveTargetOf[router] is what
/// gets forceApprove'd, not `router` itself.
contract MockTokenTransferProxy {
    function transferFrom(address token, address from, address to, uint256 amount) external {
        IERC20(token).transferFrom(from, to, amount);
    }
}

contract MockSplitAggregatorRouter {
    MockTokenTransferProxy public immutable proxy;

    constructor(MockTokenTransferProxy _proxy) {
        proxy = _proxy;
    }

    function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut, address recipient) external {
        proxy.transferFrom(tokenIn, msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(recipient, amountOut);
    }
}
