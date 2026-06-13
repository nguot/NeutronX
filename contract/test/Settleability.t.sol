// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./adversarial/AdversarialBase.sol";

/// M-1 settleability fuzz/invariant (the test the audit's remediation list asked for).
///
/// With per-fill pricing, an order can ALWAYS be driven to zero remaining no matter
/// the decay schedule or how the fill is partitioned — the final chunk can never
/// underflow / brick the order. (The old `scaleOutput` "decayedTotal − alreadyPaid"
/// reconciliation would Panic(0x11) on the last fill once the price had decayed.)
///
/// minOutputAmount is pinned to 0 to isolate settleability: the old code underflowed
/// even with no floor, so a clean settle here is exactly the M-1 property.
contract SettleabilityFuzzTest is AdversarialBase {
    address swapper = makeAddr("swapper");
    address[6] internal fillers; // one filler per chunk (each may fill only once)

    uint256 constant INPUT = 12 ether;

    function setUp() public {
        _deployCore();
        for (uint256 i = 0; i < 6; i++) {
            fillers[i] = makeAddr(vm.toString(i));
            _fundFiller(fillers[i], 1e30, 1000 ether); // ample output token + ETH for stake
        }
        _fundSwapper(swapper, 1e30);
    }

    function testFuzz_alwaysSettleable(
        uint128 startPrice,
        uint32  decayPerBlock,
        uint256 kSeed,
        uint256 gapSeed
    ) public {
        startPrice    = uint128(bound(startPrice, 1, 1e10));
        decayPerBlock = uint32(bound(decayPerBlock, 0, 4e9)); // can decay the price to 0 mid-fill
        uint256 K     = bound(kSeed, 2, 6);

        uint256 deadline = block.number + 100_000;
        PartialFillReactor.OrderInfo memory info =
            _orderInfo(swapper, INPUT, 0, startPrice, decayPerBlock, 1, deadline);
        bytes32 h = _hash(info);

        uint256 chunk  = INPUT / K;
        uint256 filled = 0;
        for (uint256 i = 0; i < K; i++) {
            uint256 amt = (i == K - 1) ? (INPUT - filled) : chunk;
            filled += amt;

            PartialFillReactor.SignedOrder memory o =
                PartialFillReactor.SignedOrder({info: info, sig: _sign(info)});

            _register(fillers[i], o, amt);

            // advance a pseudo-random gap to drive the decay between chunks
            uint256 gap = uint256(keccak256(abi.encode(gapSeed, i))) % 51;
            vm.roll(block.number + gap);

            // must never Panic(0x11). minOut == 0, so it must always succeed.
            vm.prank(fillers[i]);
            reactor.executePartialChunk(o, amt);
        }

        assertEq(reactor.remainingInput(h, INPUT), 0, "order must always settle to zero remaining");
    }
}
