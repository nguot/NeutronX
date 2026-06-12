// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";

import { PartialFillReactor } from "./PartialFillReactor.sol";

import { IPermit2 } from "./interfaces/IPermit2.sol";

contract FallbackExecutor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FALLBACK_WINDOW = 10; // blocks trước deadline

    // C-1: must match PartialFillReactor.ORDER_TYPE_HASH (price curve included)
    // so the orderHash this contract derives matches the reactor's accounting.
    bytes32 private constant ORDER_TYPE_HASH = keccak256(
        "PartialFillOrder("
        "address swapper,address inputToken,uint256 inputAmount,"
        "address outputToken,uint256 minOutputAmount,"
        "uint256 deadline,uint256 nonce,uint16 minFillBps,"
        "uint128 startPrice,uint32 decayPerBlock,uint24 feeTier"
        ")"
    );

    IPermit2           public immutable permit2;
    PartialFillReactor public immutable reactor;
    address            public immutable uniswapRouter;

    event FallbackExecuted(bytes32 indexed orderHash, uint256 amountIn, uint256 amountOut);

    constructor(address _permit2, address _reactor, address _uniswapRouter) {
        require(_permit2       != address(0), "zero permit2");
        require(_reactor       != address(0), "zero reactor");
        require(_uniswapRouter != address(0), "zero router");
        permit2       = IPermit2(_permit2);
        reactor       = PartialFillReactor(_reactor);
        uniswapRouter = _uniswapRouter;
    }

    /// @param order        order cần fallback
    /// @param routeCalldata  calldata do solver tính sẵn qua Alpha Router
    /// @param minAmountOut   minimum output do solver tính sẵn
    function executeFallback(
        PartialFillReactor.SignedOrder calldata order,
        bytes calldata routeCalldata,
        uint256 minAmountOut
    ) external nonReentrant {
        bytes32 orderHash = _hashOrder(order.info);

        // C-2: authenticate the order (cosigner sig, deadline, nonce) before
        // moving any swapper funds — the fallback path was previously unsigned.
        reactor.verifyOrderSignature(order);

        require(block.number <= order.info.deadline,          "order expired");
        require(order.info.deadline - block.number <= FALLBACK_WINDOW, "too early");

        uint256 rem = reactor.remainingInput(orderHash, order.info.inputAmount);
        require(rem > 0, "already filled");

        // C-2: marks fallback AND drives remaining to 0 atomically, so a registered
        // filler can no longer pull the same `rem` via executePartialChunk.
        reactor.markFallbackInitiated(orderHash);

        permit2.transferFrom(
            order.info.swapper,
            address(this),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint160(rem),
            order.info.inputToken
        );

        IERC20(order.info.inputToken).forceApprove(uniswapRouter, rem);

        uint256 balBefore = IERC20(order.info.outputToken).balanceOf(order.info.swapper);

        (bool ok,) = uniswapRouter.call(routeCalldata);
        require(ok, "swap failed");

        uint256 amountOut = IERC20(order.info.outputToken).balanceOf(order.info.swapper) - balBefore;
        // C-1: enforce the swapper's signed floor (pro-rata for the remaining
        // input), not just the solver-supplied minAmountOut.
        uint256 signedFloor = FullMath.mulDiv(order.info.minOutputAmount, rem, order.info.inputAmount);
        require(amountOut >= minAmountOut, "insufficient output");
        require(amountOut >= signedFloor,  "below signed min output");

        emit FallbackExecuted(orderHash, rem, amountOut);
    }

    function _hashOrder(PartialFillReactor.OrderInfo calldata info)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encode(
            ORDER_TYPE_HASH,
            info.swapper, info.inputToken, info.inputAmount,
            info.outputToken, info.minOutputAmount,
            info.deadline, info.nonce, info.minFillBps,
            info.startPrice, info.decayPerBlock, info.feeTier
        ));
    }
}