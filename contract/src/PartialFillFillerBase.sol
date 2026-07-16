// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
//  PartialFillFillerBase  —  reusable base for filler contracts that use
//  PartialFillReactor.executePartialChunkWithCallback
// ─────────────────────────────────────────────────────────────────────────────
//
//  A filler that wants to source outputAmount on-chain (swap, borrow, ...)
//  instead of pre-holding it deploys a small contract inheriting this one,
//  instead of hand-rolling IPartialFillCallback themselves. This base owns the
//  two security-critical pieces every such contract needs, so individual
//  fillers don't each have to get them right:
//
//  1. CALLER AUTHENTICATION — partialFillCallback only ever trusts a call
//     whose msg.sender is the exact `reactor` address wired at construction
//     (immutable, never re-pointable). msg.sender cannot be spoofed on the
//     EVM, so this is the entire defense against a malicious contract
//     impersonating the reactor to trick this contract into running arbitrary
//     calls with its own token approvals/balance.
//
//  2. TARGET ALLOWLIST — `callbackData` decodes into a list of (target,
//     calldata, approve) steps that the OWNER'S off-chain signer composed.
//     If that off-chain signer is ever compromised, the allowlist (set only
//     by `owner`, ahead of time, never at runtime) still confines which
//     contracts this filler's funds can flow through — swap router, lending
//     pool, or anything else the owner has vetted, but nothing else. The
//     action itself is NOT restricted (borrow/lend/swap/whatever the target
//     does), only the destination contract is.
//
//  Everything state-changing other than partialFillCallback is `onlyOwner` —
//  a malicious `target` that re-enters this contract mid-step sees
//  msg.sender == target, never == owner, so it cannot reach doFill/doRegister/
//  withdraw* regardless of reentrancy. partialFillCallback itself still carries
//  its own nonReentrant as defense-in-depth (belt-and-braces, given the caller-
//  authentication check above is already the load-bearing guard).

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 }          from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 }       from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { PartialFillReactor }    from "./PartialFillReactor.sol";
import { IPartialFillCallback }  from "./interfaces/IPartialFillCallback.sol";

abstract contract PartialFillFillerBase is IPartialFillCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// One leg of the on-chain action list a filler bundles into callbackData.
    /// `approveToken == address(0)` skips the approve for that step (not every
    /// step needs one — e.g. a repay call that already holds allowance).
    struct Step {
        address target;
        bytes   callData;
        address approveToken;
        uint256 approveAmount;
    }

    PartialFillReactor public immutable reactor;
    address            public immutable owner;

    mapping(address => bool) public allowedTargets;

    event TargetAllowed(address indexed target, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _reactor) {
        require(_reactor != address(0), "zero reactor");
        reactor = PartialFillReactor(_reactor);
        owner   = msg.sender;
    }

    receive() external payable {}

    // ── owner controls ──────────────────────────────────────────────────────

    /// Vets which contracts this filler's callback is ever allowed to call
    /// into. Set ahead of time by the owner — never derived from runtime
    /// callbackData — so a compromised off-chain signer can still only route
    /// funds through contracts already vetted here.
    function setTargetAllowed(address target, bool allowed) external onlyOwner {
        require(target != address(0), "zero target");
        allowedTargets[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    /// Registers this CONTRACT (not the caller) as the filler for `fillAmount`
    /// of `order` — msg.sender the reactor sees is address(this), matching the
    /// identity that will later call doFill.
    function doRegister(PartialFillReactor.SignedOrder calldata order, uint256 fillAmount)
        external payable onlyOwner
    {
        reactor.register{value: msg.value}(order, fillAmount);
    }

    /// Executes `fillAmount` of `order` via the callback path, running `steps`
    /// (each checked against allowedTargets) inside partialFillCallback to
    /// source the output token before the reactor pulls it back.
    function doFill(
        PartialFillReactor.SignedOrder calldata order,
        uint256 fillAmount,
        Step[] calldata steps
    ) external onlyOwner {
        reactor.executePartialChunkWithCallback(order, fillAmount, abi.encode(steps));
    }

    function withdrawToken(address token, uint256 amount, address to) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    function withdrawEth(uint256 amount, address payable to) external onlyOwner {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "eth transfer failed");
    }

    // ── reactor entrypoint ──────────────────────────────────────────────────

    function partialFillCallback(
        bytes32 orderHash,
        uint256 fillAmount,
        address inputToken,
        address outputToken,
        uint256 outputAmount,
        bytes calldata data
    ) external override nonReentrant {
        require(msg.sender == address(reactor), "not reactor");

        Step[] memory steps = abi.decode(data, (Step[]));
        for (uint256 i = 0; i < steps.length; i++) {
            Step memory step = steps[i];
            require(allowedTargets[step.target], "target not allowed");
            if (step.approveToken != address(0)) {
                IERC20(step.approveToken).forceApprove(step.target, step.approveAmount);
            }
            (bool ok, bytes memory ret) = step.target.call(step.callData);
            if (!ok) {
                assembly { revert(add(ret, 0x20), mload(ret)) }
            }
        }

        _afterSteps(orderHash, fillAmount, inputToken, outputToken, outputAmount);

        // Whatever outputToken this contract now holds must be approved for
        // the reactor's subsequent pull, or the whole fill reverts.
        IERC20(outputToken).forceApprove(address(reactor), outputAmount);
    }

    /// Hook for subclasses: runs after all allowlisted steps, before this
    /// contract approves the reactor for outputAmount. Override to bundle any
    /// extra on-chain action that doesn't fit the generic Step list (e.g.
    /// repaying a flash loan, updating an internal ledger).
    function _afterSteps(
        bytes32 orderHash,
        uint256 fillAmount,
        address inputToken,
        address outputToken,
        uint256 outputAmount
    ) internal virtual {}
}
