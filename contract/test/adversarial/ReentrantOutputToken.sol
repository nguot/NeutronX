// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// A malicious output token: when the reactor pays the swapper during
/// settlement (`transferFrom`), it re-enters the reactor once. Used to prove
/// `executePartialChunk`'s `nonReentrant` guard blocks reentrancy. The nested
/// call's revert is bubbled up so the whole settlement reverts.
contract ReentrantOutputToken is ERC20 {
    address public target;
    bytes   public attackCalldata;
    bool    public armed;

    constructor() ERC20("EVIL", "EVIL") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function arm(address _target, bytes calldata _data) external {
        target = _target;
        attackCalldata = _data;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false; // re-enter only once
            (bool ok, bytes memory ret) = target.call(attackCalldata);
            if (!ok) {
                assembly { revert(add(ret, 0x20), mload(ret)) } // bubble the guard's revert
            }
        }
        return super.transferFrom(from, to, amount);
    }
}
