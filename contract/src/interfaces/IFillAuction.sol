// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFillAuction {
    function register(
        address filler,
        bytes32 orderHash,
        uint256 fillAmount,
        uint256 orderTotal,
        uint256 deadline,
        address inputToken,
        uint24  feeTier
    ) external payable;
    function hasValidRegistration(bytes32 orderHash, address filler, uint256 fillAmount) external view returns (bool);
    function onFillSuccess(bytes32 orderHash, address filler, uint256 actualFillAmount) external;
}