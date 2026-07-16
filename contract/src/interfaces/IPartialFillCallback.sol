// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Implemented by filler CONTRACTS (not EOAs) that want
/// PartialFillReactor.executePartialChunkWithCallback to hand back control
/// mid-fill — after the input leg lands, before the output leg is pulled — so
/// they can source `outputAmount` on-chain (swap, borrow, arbitrary calls)
/// instead of having to pre-hold outputToken.
interface IPartialFillCallback {
    /// Called by the reactor exactly once per fill, right after it has pushed
    /// `fillAmount` of `inputToken` to this contract (msg.sender of the fill)
    /// and right before it pulls `outputAmount` of `outputToken` back. By the
    /// time this call returns, the implementer MUST hold and have approved the
    /// reactor for at least `outputAmount` of `outputToken`, or the whole fill
    /// (and this leg) reverts.
    function partialFillCallback(
        bytes32 orderHash,
        uint256 fillAmount,
        address inputToken,
        address outputToken,
        uint256 outputAmount,
        bytes calldata data
    ) external;
}
