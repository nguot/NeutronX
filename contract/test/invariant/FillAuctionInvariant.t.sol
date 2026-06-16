// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/FillAuction.sol";
import "./FillAuctionHandler.sol";

/// Stateful invariant test: no matter what sequence of register / fill /
/// slash / withdraw calls happens (any actors, any amounts, any block
/// timings), FillAuction must always hold exactly enough ETH to cover every
/// active stake plus everyone's withdrawable balance. See
/// FillAuctionInvariant.md for the full explanation.
contract FillAuctionInvariantTest is Test {
    FillAuction public auction;
    FillAuctionHandler public handler;
    address public treasury = makeAddr("treasury");

    function setUp() public {
        auction = new FillAuction(treasury, address(0), address(0), 0, true); // oracle-disabled (1:1) mode

        address[] memory actors = new address[](4);
        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("carol");
        actors[3] = makeAddr("dave");

        bytes32[] memory orderHashes = new bytes32[](3);
        orderHashes[0] = keccak256("order0");
        orderHashes[1] = keccak256("order1");
        orderHashes[2] = keccak256("order2");

        handler = new FillAuctionHandler(auction, actors, orderHashes);
        auction.setReactor(address(handler));

        // Constructor defaults: collateralRate = [2000, 5000, 10000, 30000],
        // refundTable per DynamicStakeLibStake.md.

        targetContract(address(handler));
    }

    /// contract balance == sum of active (unresolved) stakes + sum of
    /// everyone's withdrawable pendingReturns (including the treasury's
    /// share of any slashes).
    function invariant_solvency() public view {
        uint256 totalPending = auction.pendingReturns(treasury);
        uint256 n = handler.actorsCount();
        for (uint256 i = 0; i < n; i++) {
            totalPending += auction.pendingReturns(handler.actors(i));
        }
        assertEq(address(auction).balance, handler.ghost_activeStake() + totalPending);
    }
}
