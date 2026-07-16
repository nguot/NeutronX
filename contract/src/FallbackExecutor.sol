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
    address            public immutable owner;

    // Adapter-agnostic router allowlist — lets the off-chain solver pick
    // whichever aggregator (Uniswap, 1inch, KyberSwap, ParaSwap, ...) quoted
    // best, without redeploying or re-wiring the reactor.
    //
    // Maps the allowlisted call-target `router` to the address that should
    // hold the ERC20 approval before `router` is called. Most aggregators use
    // a single-address model (approveTargetOf[router] == router itself), but
    // ParaSwap's Augustus/TokenTransferProxy split needs a different spender
    // than the call target — resolved here from owner-set storage instead of
    // a caller-supplied parameter, so a malicious caller can never point the
    // approval at an unvetted address.
    mapping(address => address) public approveTargetOf;

    event FallbackExecuted(bytes32 indexed orderHash, uint256 amountIn, uint256 amountOut);
    event RouterAllowed(address indexed router, address indexed approveTarget, bool allowed);

    constructor(address _permit2, address _reactor, address _initialRouter) {
        require(_permit2      != address(0), "zero permit2");
        require(_reactor      != address(0), "zero reactor");
        require(_initialRouter != address(0), "zero router");
        permit2 = IPermit2(_permit2);
        reactor = PartialFillReactor(_reactor);
        owner   = msg.sender;

        approveTargetOf[_initialRouter] = _initialRouter;
        emit RouterAllowed(_initialRouter, _initialRouter, true);
    }

    /// Owner-managed allowlist of swap router/aggregator contracts that
    /// `executeFallback` is permitted to approve + call into. Adding a new
    /// DEX aggregator is just one call to this function — pass `approveTarget
    /// == router` for single-address aggregators (Uniswap, 1inch, KyberSwap),
    /// or the dedicated spender contract for split models (ParaSwap's
    /// TokenTransferProxy).
    function setRouterAllowed(address router, address approveTarget, bool allowed) external {
        require(msg.sender == owner, "not owner");
        require(router != address(0), "zero router");
        if (allowed) {
            require(approveTarget != address(0), "zero approve target");
            approveTargetOf[router] = approveTarget;
        } else {
            delete approveTargetOf[router];
        }
        emit RouterAllowed(router, approveTarget, allowed);
    }

    /// @param order        order cần fallback
    /// @param router         allowlisted aggregator router to swap through
    /// @param routeCalldata  calldata do solver tính sẵn (qua bất kỳ aggregator nào)
    /// @param minAmountOut   minimum output do solver tính sẵn
    function executeFallback(
        PartialFillReactor.SignedOrder calldata order,
        address router,
        bytes calldata routeCalldata,
        uint256 minAmountOut
    ) external nonReentrant {
        address approveTarget = approveTargetOf[router];
        require(approveTarget != address(0), "router not allowed");

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

        uint256 inBalBefore = IERC20(order.info.inputToken).balanceOf(address(this));

        permit2.transferFrom(
            order.info.swapper,
            address(this),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint160(rem),
            order.info.inputToken
        );

        IERC20(order.info.inputToken).forceApprove(approveTarget, rem);

        uint256 balBefore = IERC20(order.info.outputToken).balanceOf(order.info.swapper);

        (bool ok,) = router.call(routeCalldata);
        require(ok, "swap failed");

        uint256 amountOut = IERC20(order.info.outputToken).balanceOf(order.info.swapper) - balBefore;
        // C-1: enforce the swapper's signed floor (pro-rata for the remaining
        // input), not just the solver-supplied minAmountOut.
        uint256 signedFloor = FullMath.mulDiv(order.info.minOutputAmount, rem, order.info.inputAmount);
        require(amountOut >= minAmountOut, "insufficient output");
        require(amountOut >= signedFloor,  "below signed min output");

        // C-3: enforce the order's absolute minOutputAmount against the
        // cumulative total paid across all partial fills plus this fallback leg.
        reactor.recordFallbackOutput(orderHash, amountOut, order.info.minOutputAmount);

        // C-4: an exact-output style route may spend less than `rem`. The order
        // is already terminal, so any unconsumed input must be refunded to the
        // swapper rather than left stranded in this contract.
        IERC20(order.info.inputToken).forceApprove(approveTarget, 0);
        uint256 leftover = IERC20(order.info.inputToken).balanceOf(address(this)) - inBalBefore;
        if (leftover > 0) {
            IERC20(order.info.inputToken).safeTransfer(order.info.swapper, leftover);
        }

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