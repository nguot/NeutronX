// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPermit2 {
    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external {
        IERC20(token).transferFrom(from, to, uint256(amount));
    }
}