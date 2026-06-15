// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/FillAuction.sol";
import { DynamicStakeLib } from "../../src/libs/DynamicStakeLib.sol";

/// Drives FillAuction through random sequences of register / fill (via
/// onFillSuccess) / slash / withdraw / roll. The handler itself is set as
/// the `reactor`, so `fill()` can call `onFillSuccess` directly — this
/// keeps the invariant test focused purely on FillAuction's own stake
/// bookkeeping, independent of PartialFillReactor/order-hashing.
contract FillAuctionHandler is Test {
    FillAuction public auction;

    address[] public actors;
    bytes32[] public orderHashes;

    /// Sum of stakeAmount for registrations not yet resolved (filled or
    /// slashed). Mirrors what FillAuction itself should be holding on
    /// behalf of still-active registrations.
    uint256 public ghost_activeStake;

    mapping(bytes32 => mapping(address => bool))    public registered;
    mapping(bytes32 => mapping(address => bool))    public resolved;
    mapping(bytes32 => mapping(address => uint256)) public regStake;
    mapping(bytes32 => mapping(address => uint128)) public regFillAmount;
    mapping(bytes32 => mapping(address => uint64))  public regDeadline;

    constructor(FillAuction _auction, address[] memory _actors, bytes32[] memory _orderHashes) {
        auction = _auction;
        actors = _actors;
        orderHashes = _orderHashes;
    }

    function actorsCount() external view returns (uint256) {
        return actors.length;
    }

    /// Mirrors FillAuction.register()'s computeCollateral(): no fill-ratio
    /// dimension, just the registered ceiling x order-size rate x time
    /// multiplier.
    function _stakeFor(uint256 fillAmount, uint256 deadline) internal view returns (uint256) {
        // D-1: auction deployed oracle-disabled, so notional == fillAmount and the
        // size bucket is on the ETH-scale thresholds.
        uint8 sBucket = DynamicStakeLib.getOrderSizeBucketETH(fillAmount);
        uint8 tBucket = DynamicStakeLib.getTimeBucket(deadline);
        uint32 rateBps  = auction.collateralRate(sBucket);
        uint32 timeMult = DynamicStakeLib._getTimeMultiplier(tBucket);
        return (fillAmount * rateBps / 10000) * timeMult / 10000;
    }

    // IReactorView surface used by FillAuction.slash. Orders driven here are
    // never cancelled and are modelled as still-open (remaining > 0), so the
    // registrant genuinely abandoned committed volume and is slashable.
    function isCancelled(bytes32) external pure returns (bool) { return false; }
    function isNonceInvalidatedForOrder(bytes32) external pure returns (bool) { return false; }
    function remainingInput(bytes32, uint256 orderAmount) external pure returns (uint256) { return orderAmount; }

    /// Register `actor` for a random fill of a random order, sized so the
    /// stake matches exactly what FillAuction itself will compute.
    function register(
        uint256 actorSeed,
        uint256 hashSeed,
        uint256 orderTotalSeed,
        uint256 fillAmountSeed,
        uint256 deadlineSeed
    ) external {
        address actor = actors[actorSeed % actors.length];
        bytes32 orderHash = orderHashes[hashSeed % orderHashes.length];
        if (registered[orderHash][actor]) return; // FillAuction forbids re-registering

        uint256 orderTotal = bound(orderTotalSeed, 1e6, 1_000_000e6);
        uint256 fillAmount = bound(fillAmountSeed, 1, orderTotal);
        uint256 deadline   = block.number + bound(deadlineSeed, 1, 1000);

        uint256 stake = _stakeFor(fillAmount, deadline);

        vm.deal(address(this), stake);
        auction.register{value: stake}(actor, orderHash, fillAmount, orderTotal, deadline, address(0), uint24(0));

        registered[orderHash][actor] = true;
        regStake[orderHash][actor] = stake;
        // forge-lint: disable-next-line(unsafe-typecast)
        regFillAmount[orderHash][actor] = uint128(fillAmount);
        // forge-lint: disable-next-line(unsafe-typecast)
        regDeadline[orderHash][actor] = uint64(deadline);
        ghost_activeStake += stake;
    }

    /// Simulate a successful (possibly partial) fill: any amount up to the
    /// registered fillAmount, before the registration's deadline — mirrors
    /// what PartialFillReactor.executePartialChunk + hasValidRegistration
    /// would allow.
    function fill(uint256 actorSeed, uint256 hashSeed, uint256 amountSeed) external {
        address actor = actors[actorSeed % actors.length];
        bytes32 orderHash = orderHashes[hashSeed % orderHashes.length];
        if (!registered[orderHash][actor] || resolved[orderHash][actor]) return;
        if (block.number > regDeadline[orderHash][actor]) return;

        uint256 actualFill = bound(amountSeed, 1, regFillAmount[orderHash][actor]);

        // remainingAtFill = max ⇒ denominator stays the commitment (pre-3.5 behaviour).
        auction.onFillSuccess(orderHash, actor, actualFill, type(uint256).max);

        resolved[orderHash][actor] = true;
        ghost_activeStake -= regStake[orderHash][actor];
    }

    /// Slash `actor`'s registration once it's past deadline + SLASH_WINDOW
    /// and still unresolved. `caller` collects the 10% reward.
    function slash(uint256 actorSeed, uint256 hashSeed, uint256 callerSeed) external {
        address actor = actors[actorSeed % actors.length];
        bytes32 orderHash = orderHashes[hashSeed % orderHashes.length];
        address caller = actors[callerSeed % actors.length];
        if (!registered[orderHash][actor] || resolved[orderHash][actor]) return;
        if (block.number <= uint256(regDeadline[orderHash][actor]) + auction.SLASH_WINDOW()) return;

        vm.prank(caller);
        auction.slash(orderHash, actor);

        resolved[orderHash][actor] = true;
        ghost_activeStake -= regStake[orderHash][actor];
    }

    function withdraw(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];
        if (auction.pendingReturns(actor) == 0) return;
        vm.prank(actor);
        auction.withdraw();
    }

    /// Advance the chain so deadlines / slash windows can be crossed.
    function roll(uint256 blocksSeed) external {
        vm.roll(block.number + bound(blocksSeed, 0, 200));
    }
}
