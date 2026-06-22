// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AdversarialBase.sol";

/// A population of users and fillers — honest and MEV — interacting over several
/// orders, then global invariants checked at the end. This is the headline
/// adversarial scenario: not "happy path works", but "given honest + adversarial
/// agents, here is provably what the adversaries can and cannot extract".
contract MultiOrderScenarioTest is AdversarialBase {
    address s1 = makeAddr("s1");
    address s2 = makeAddr("s2");
    address s3 = makeAddr("s3");
    address h1 = makeAddr("h1"); // honest
    address h2 = makeAddr("h2"); // honest
    address mev = makeAddr("mev");

    uint256 constant INPUT     = 4 ether;
    uint256 constant MIN_OUT   = 9_000e6;
    uint256 constant FULL_OUT  = 10_000e6; // 4 WETH * 2500e6 / 1e18
    uint256 constant DEADLINE  = 100_000;

    function setUp() public {
        _deployCore();
        _fundSwapper(s1, INPUT);
        _fundSwapper(s2, INPUT);
        _fundSwapper(s3, INPUT);
        _fundFiller(h1, 1_000_000e6, 100 ether);
        _fundFiller(h2, 1_000_000e6, 100 ether);
        _fundFiller(mev, 1_000_000e6, 100 ether);
    }

    function _orderFor(address swapper) internal view returns (PartialFillReactor.SignedOrder memory) {
        return _signed(_orderInfo(swapper, INPUT, MIN_OUT, START_PRICE, 0, 1, DEADLINE));
    }

    function test_population_honestAndMev_invariantsHold() public {
        PartialFillReactor.SignedOrder memory o1 = _orderFor(s1);
        PartialFillReactor.SignedOrder memory o2 = _orderFor(s2);
        PartialFillReactor.SignedOrder memory o3 = _orderFor(s3);
        uint256 stake = _stake(o1.info, INPUT); // same for all (same size/deadline)

        // ── order 1: honest h1 fills cleanly ──
        _register(h1, o1, INPUT);
        vm.prank(h1);
        reactor.executePartialChunk(o1, INPUT);

        // ── order 2: h2 registers, MEV front-runs and wins; h2 reclaims ──
        _register(h2, o2, INPUT);
        _register(mev, o2, INPUT);
        vm.prank(mev);
        reactor.executePartialChunk(o2, INPUT);
        vm.prank(h2);
        vm.expectRevert("fill > remaining");
        reactor.executePartialChunk(o2, INPUT);
        auction.releaseRegistration(_hash(o2.info), h2);

        // ── order 3: MEV registers but abandons; h1 fills it; MEV reclaims (order satisfied) ──
        _register(h1, o3, INPUT);
        _register(mev, o3, INPUT);
        vm.prank(h1);
        reactor.executePartialChunk(o3, INPUT);
        auction.releaseRegistration(_hash(o3.info), mev);

        // ════════ GLOBAL INVARIANTS ════════

        // (a) every swapper was filled at/above their floor — nobody was robbed
        assertGe(usdc.balanceOf(s1), MIN_OUT);
        assertGe(usdc.balanceOf(s2), MIN_OUT);
        assertGe(usdc.balanceOf(s3), MIN_OUT);
        assertEq(usdc.balanceOf(s1), FULL_OUT);
        assertEq(usdc.balanceOf(s2), FULL_OUT);
        assertEq(usdc.balanceOf(s3), FULL_OUT);

        // (b) token conservation — all input left the swappers and landed with the
        //     fillers who actually filled; output paid == output received.
        assertEq(weth.balanceOf(s1) + weth.balanceOf(s2) + weth.balanceOf(s3), 0);
        assertEq(weth.balanceOf(h1), 2 * INPUT); // filled o1 + o3
        assertEq(weth.balanceOf(mev), INPUT);    // filled o2
        assertEq(weth.balanceOf(h2), 0);         // lost the race, filled nothing
        assertEq(weth.balanceOf(h1) + weth.balanceOf(h2) + weth.balanceOf(mev), 3 * INPUT);

        uint256 usdcPaid = (1_000_000e6 - usdc.balanceOf(h1))
                         + (1_000_000e6 - usdc.balanceOf(h2))
                         + (1_000_000e6 - usdc.balanceOf(mev));
        assertEq(usdcPaid, 3 * FULL_OUT); // == total received by swappers

        // (c) the honest filler who lost the race lost NOTHING — full stake reclaimed
        assertEq(auction.pendingReturns(h2), stake);

        // (d) full fills return 100% of stake; nothing was forfeited to the treasury
        assertEq(auction.pendingReturns(treasury), 0);

        // (e) FillAuction solvency: with every registration resolved, the contract
        //     holds exactly the sum of everyone's withdrawable balances.
        uint256 totalPending = auction.pendingReturns(h1)
                             + auction.pendingReturns(h2)
                             + auction.pendingReturns(mev)
                             + auction.pendingReturns(treasury);
        assertEq(address(auction).balance, totalPending);

        // and every filler can actually pull their funds out
        vm.prank(h2);
        auction.withdraw(payable(h2));
        assertEq(auction.pendingReturns(h2), 0);
    }
}
