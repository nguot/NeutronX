// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockFillAuction {
    bool public validRegistration = true;
    bool public onFillSuccessCalled;

    function setValidRegistration(bool val) external {
        validRegistration = val;
    }

    function hasValidRegistration(
        bytes32,
        address,
        uint256
    ) external view returns (bool) {
        return validRegistration;
    }

    function onFillSuccess(bytes32, address, uint256) external {
        onFillSuccessCalled = true;
    }
}