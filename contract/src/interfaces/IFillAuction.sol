// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFillAuction {
    function hasValidRegistration(bytes32 orderHash, address filler, uint256 fillAmount) external view returns (bool);
    function onFillSuccess(bytes32 orderHash, address filler, uint256 actualFillAmount) external;
}