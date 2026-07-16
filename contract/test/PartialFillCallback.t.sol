// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./adversarial/AdversarialBase.sol";
import "../src/PartialFillFillerBase.sol";
import "./mocks/SampleCallbackFiller.sol";
import "./mocks/MockAggregatorRouter.sol";

/// Exercises the optional callback path (executePartialChunkWithCallback +
/// IPartialFillCallback + PartialFillFillerBase), using SampleCallbackFiller
/// as the concrete contract a filler operator would actually deploy.
contract PartialFillCallbackTest is AdversarialBase {
    address swapper     = makeAddr("swapper");
    address fillerOwner = makeAddr("fillerOwner");
    address attacker    = makeAddr("attacker");

    uint256 constant INPUT    = 4 ether; // 4 WETH order
    uint256 constant DEADLINE = 100_000;

    SampleCallbackFiller filler;
    MockAggregatorRouter router;

    function setUp() public {
        _deployCore();
        _fundSwapper(swapper, INPUT);

        vm.prank(fillerOwner);
        filler = new SampleCallbackFiller(address(reactor));

        router = new MockAggregatorRouter();
    }

    function _order(uint256 nonce) internal view returns (PartialFillReactor.SignedOrder memory) {
        return _signed(_orderInfo(swapper, INPUT, 0, START_PRICE, 0, nonce, DEADLINE));
    }

    /// Registers the CONTRACT (not fillerOwner) as the filler, routed through
    /// doRegister so the reactor sees msg.sender == address(filler) — the same
    /// identity that will later call doFill.
    function _registerFillerContract(PartialFillReactor.SignedOrder memory order, uint256 fillAmount) internal {
        uint256 stake = _stake(order.info, fillAmount);
        vm.deal(fillerOwner, stake);
        vm.prank(fillerOwner);
        filler.doRegister{value: stake}(order, fillAmount);
    }

    function _swapStep(uint256 fillAmount, uint256 outputAmount)
        internal view returns (PartialFillFillerBase.Step[] memory steps)
    {
        steps = new PartialFillFillerBase.Step[](1);
        steps[0] = PartialFillFillerBase.Step({
            target: address(router),
            callData: abi.encodeCall(
                MockAggregatorRouter.swap,
                (address(weth), fillAmount, address(usdc), outputAmount, address(filler))
            ),
            approveToken: address(weth),
            approveAmount: fillAmount
        });
    }

    // ── happy path: filler sources outputAmount by swapping the just-received
    //    input token through an allowlisted router, inside the callback ──

    function test_callbackFiller_swapsThroughAllowlistedRouter_andFills() public {
        PartialFillReactor.SignedOrder memory order = _order(1);
        uint256 outputAmount = 10_000e6; // 4 WETH * 2500e6 / 1e18, decay = 0

        vm.prank(fillerOwner);
        filler.setTargetAllowed(address(router), true);

        _registerFillerContract(order, INPUT);

        vm.prank(fillerOwner);
        filler.doFill(order, INPUT, _swapStep(INPUT, outputAmount));

        assertEq(usdc.balanceOf(swapper), outputAmount);
        assertEq(weth.balanceOf(address(router)), INPUT);
        assertEq(reactor.remainingInput(_hash(order.info), INPUT), 0);
    }

    // ── caller authentication: msg.sender must be the real reactor, not
    //    whoever feels like calling partialFillCallback directly ──

    function test_callbackFiller_rejectsDirectCall_notReactor() public {
        vm.prank(attacker);
        vm.expectRevert("not reactor");
        filler.partialFillCallback(bytes32(0), INPUT, address(weth), address(usdc), 10_000e6, "");
    }

    // ── target allowlist: an un-vetted target is rejected even on a call that
    //    genuinely comes from the reactor ──

    function test_callbackFiller_rejectsDisallowedTarget() public {
        PartialFillReactor.SignedOrder memory order = _order(1);
        // router deliberately NOT allowlisted
        _registerFillerContract(order, INPUT);

        vm.prank(fillerOwner);
        vm.expectRevert("target not allowed");
        filler.doFill(order, INPUT, _swapStep(INPUT, 10_000e6));
    }

    // ── only the owner can drive doRegister/doFill — blocks a malicious
    //    `target` that re-enters THIS contract mid-callback from ever reaching
    //    them (msg.sender would be the target, never the owner) ──

    function test_callbackFiller_doFillIsOwnerOnly() public {
        PartialFillReactor.SignedOrder memory order = _order(1);
        vm.prank(attacker);
        vm.expectRevert("not owner");
        filler.doFill(order, INPUT, _swapStep(INPUT, 10_000e6));
    }

    // ── reactor-side reentrancy: register() is now nonReentrant, so a step
    //    that tries to call back into it mid-fill (e.g. a compromised
    //    off-chain signer targeting the reactor itself) reverts instead of
    //    opening a second registration window during an in-flight callback ──

    function test_callback_cannotReenterRegister() public {
        PartialFillReactor.SignedOrder memory order1 = _order(1);
        PartialFillReactor.SignedOrder memory order2 = _order(2);

        vm.prank(fillerOwner);
        filler.setTargetAllowed(address(reactor), true); // simulates a compromised signer targeting the reactor

        _registerFillerContract(order1, INPUT);

        PartialFillFillerBase.Step[] memory steps = new PartialFillFillerBase.Step[](1);
        steps[0] = PartialFillFillerBase.Step({
            target: address(reactor),
            callData: abi.encodeWithSelector(reactor.register.selector, order2, INPUT),
            approveToken: address(0),
            approveAmount: 0
        });

        vm.prank(fillerOwner);
        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        filler.doFill(order1, INPUT, steps);
    }
}
