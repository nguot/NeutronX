// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MockERC20.sol";

/// Mock ERC-20 that skims a fixed bps fee from the recipient on every transfer,
/// so the receiver is credited LESS than the nominal amount. Used to exercise the
/// reactor's actual-received (balance-delta) output floor — Trufy 3.2.
///
/// Implementation is OZ-version-agnostic: it performs a normal transfer of the
/// full amount, then burns the fee back out of the recipient. Net effect is
/// identical to a classic fee-on-transfer token from the receiver's side.
contract FeeOnTransferToken is MockERC20 {
    uint256 public immutable feeBps; // fee skimmed from the recipient, in basis points

    constructor(string memory name, string memory symbol, uint256 _feeBps)
        MockERC20(name, symbol)
    {
        require(_feeBps < 10000, "fee too high");
        feeBps = _feeBps;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        uint256 fee = (amount * feeBps) / 10000;
        if (fee > 0) _burn(to, fee);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        public override returns (bool)
    {
        super.transferFrom(from, to, amount);
        uint256 fee = (amount * feeBps) / 10000;
        if (fee > 0) _burn(to, fee);
        return true;
    }
}
