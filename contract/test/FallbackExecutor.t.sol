// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FallbackExecutor.sol";
import "../src/PartialFillReactor.sol";
import "../src/FillAuction.sol";
import { IEthNotionalOracle } from "../src/interfaces/IEthNotionalOracle.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockAggregatorRouter.sol";
import "./mocks/MockSplitAggregatorRouter.sol";

interface IPermit2Full {
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external;
}

struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}

contract FallbackExecutorTest is Test {
    // ── Mainnet addresses ──
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant UNISWAP_ROUTER =
        0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH_WHALE = 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045; // Vitalik

    FillAuction public fillAuction;
    PartialFillReactor public reactor;
    FallbackExecutor public fallbackExecutor;

    address public treasury = makeAddr("treasury");
    uint256 cosignerKey = 0xA11CE;
    address public cosigner = vm.addr(cosignerKey);
    address public swapper = makeAddr("swapper");
    address public caller = makeAddr("caller");

    uint256 constant INPUT_AMOUNT = 1 ether; // 1 WETH

    function setUp() public {
        // fork mainnet
        vm.createSelectFork(vm.envString("ALCHEMY_RPC_URL"));

        // deploy contracts
        fillAuction = new FillAuction(treasury, IEthNotionalOracle(address(0)), true); // oracle-disabled (notional == fill)
        reactor = new PartialFillReactor(
            PERMIT2,
            address(fillAuction),
            cosigner
        );
        fallbackExecutor = new FallbackExecutor(
            PERMIT2,
            address(reactor),
            UNISWAP_ROUTER
        );
        fillAuction.setReactor(address(reactor));
        reactor.setFallbackExecutor(address(fallbackExecutor));

        // cấp WETH cho swapper từ whale
        vm.prank(WETH_WHALE);
        IERC20(WETH).transfer(swapper, INPUT_AMOUNT);

        // swapper approve Permit2
        vm.prank(swapper);
        IERC20(WETH).approve(PERMIT2, type(uint256).max);

        // swapper approve qua Permit2
        vm.prank(swapper);
        IPermit2Full(PERMIT2).approve(
            WETH,
            address(fallbackExecutor),
            type(uint160).max,
            type(uint48).max
        );
    }

    function _makeOrder()
        internal
        view
        returns (PartialFillReactor.SignedOrder memory)
    {
        return _makeOrderWithFloor(USDC, 1000e6, 1);
    }

    // Lets the swap-mechanics tests pin the output token + signed floor without
    // depending on real Uniswap calldata or live fork pricing.
    function _makeOrderWithFloor(address outputToken, uint256 minOutputAmount, uint256 nonce)
        internal
        view
        returns (PartialFillReactor.SignedOrder memory)
    {
        PartialFillReactor.OrderInfo memory info = PartialFillReactor
            .OrderInfo({
                swapper: swapper,
                inputToken: WETH,
                inputAmount: INPUT_AMOUNT,
                outputToken: outputToken,
                minOutputAmount: minOutputAmount,
                deadline: block.number + 100,
                nonce: nonce,
                minFillBps: 0,
                startPrice: uint128(2500e18), // 2500 USDC per WETH scaled 1e18
                decayPerBlock: 0,
                feeTier: 500
            });
        return PartialFillReactor.SignedOrder({info: info, sig: _signOrder(info)});
    }

    function _signOrder(PartialFillReactor.OrderInfo memory info) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            reactor.ORDER_TYPE_HASH(),
            info.swapper, info.inputToken, info.inputAmount,
            info.outputToken, info.minOutputAmount,
            info.deadline, info.nonce, info.minFillBps,
            info.startPrice, info.decayPerBlock, info.feeTier
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reactor.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cosignerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // Generic mechanism: an arbitrary allowlisted router (not Uniswap-specific)
    // is approved for `rem`, called with solver-supplied calldata, and the
    // resulting output transfer to the swapper is what's measured — no
    // dependence on live Uniswap pricing on the fork.
    function test_fallback_swapsSuccessfully_viaArbitraryAllowlistedRouter() public {
        MockERC20 mockOut = new MockERC20("MOUT", "MOUT");
        MockAggregatorRouter mockRouter = new MockAggregatorRouter();
        fallbackExecutor.setRouterAllowed(address(mockRouter), address(mockRouter), true);

        uint256 minOutputAmount = 1000e18;
        uint256 quotedAmountOut = 1200e18; // solver's quote, above the signed floor

        PartialFillReactor.SignedOrder memory order =
            _makeOrderWithFloor(address(mockOut), minOutputAmount, 1);

        vm.roll(block.number + 91);

        bytes memory routeCalldata = abi.encodeWithSelector(
            MockAggregatorRouter.swap.selector,
            WETH, INPUT_AMOUNT, address(mockOut), quotedAmountOut, swapper
        );

        uint256 wethBefore = IERC20(WETH).balanceOf(swapper);

        vm.prank(caller);
        fallbackExecutor.executeFallback(order, address(mockRouter), routeCalldata, quotedAmountOut);

        assertEq(mockOut.balanceOf(swapper), quotedAmountOut, "swapper should receive the quoted output");
        assertEq(wethBefore - IERC20(WETH).balanceOf(swapper), INPUT_AMOUNT, "swapper should spend exactly the input");
    }

    // ParaSwap-style two-address model: approveTarget (TokenTransferProxy) is a
    // different contract than router (Augustus, the call target) — exercises
    // that forceApprove/forceApprove(0) target approveTargetOf[router], and
    // that the proxy (not the router) is the one doing the actual pull.
    function test_fallback_swapsSuccessfully_viaSplitApproveTargetRouter() public {
        MockERC20 mockOut = new MockERC20("MOUT", "MOUT");
        MockTokenTransferProxy proxy = new MockTokenTransferProxy();
        MockSplitAggregatorRouter mockRouter = new MockSplitAggregatorRouter(proxy);
        fallbackExecutor.setRouterAllowed(address(mockRouter), address(proxy), true);

        uint256 minOutputAmount = 1000e18;
        uint256 quotedAmountOut = 1200e18;

        PartialFillReactor.SignedOrder memory order =
            _makeOrderWithFloor(address(mockOut), minOutputAmount, 1);

        vm.roll(block.number + 91);

        bytes memory routeCalldata = abi.encodeWithSelector(
            MockSplitAggregatorRouter.swap.selector,
            WETH, INPUT_AMOUNT, address(mockOut), quotedAmountOut, swapper
        );

        vm.prank(caller);
        fallbackExecutor.executeFallback(order, address(mockRouter), routeCalldata, quotedAmountOut);

        assertEq(mockOut.balanceOf(swapper), quotedAmountOut, "swapper should receive the quoted output");
        assertEq(IERC20(WETH).allowance(address(fallbackExecutor), address(proxy)), 0, "approveTarget allowance must be reset to 0 after execution");
        assertEq(IERC20(WETH).allowance(address(fallbackExecutor), address(mockRouter)), 0, "router itself must never receive an allowance in the split model");
    }

    // C-1: the swapper's signed floor (pro-rated minOutputAmount) must be
    // enforced even if a sloppy/malicious solver passes a lower minAmountOut.
    function test_fallback_revert_belowSignedFloor() public {
        MockERC20 mockOut = new MockERC20("MOUT", "MOUT");
        MockAggregatorRouter mockRouter = new MockAggregatorRouter();
        fallbackExecutor.setRouterAllowed(address(mockRouter), address(mockRouter), true);

        uint256 minOutputAmount = 1000e18; // swapper's signed floor (full fill)
        uint256 solverMinOut    = 500e18;  // solver under-promises...
        uint256 actualAmountOut = 600e18;  // ...and the route delivers within that promise, but below the floor

        PartialFillReactor.SignedOrder memory order =
            _makeOrderWithFloor(address(mockOut), minOutputAmount, 1);

        vm.roll(block.number + 91);

        bytes memory routeCalldata = abi.encodeWithSelector(
            MockAggregatorRouter.swap.selector,
            WETH, INPUT_AMOUNT, address(mockOut), actualAmountOut, swapper
        );

        vm.prank(caller);
        vm.expectRevert("below signed min output");
        fallbackExecutor.executeFallback(order, address(mockRouter), routeCalldata, solverMinOut);
    }

    // The solver-supplied minAmountOut is also enforced on its own terms,
    // independent of the swapper's signed floor.
    function test_fallback_revert_insufficientOutput() public {
        MockERC20 mockOut = new MockERC20("MOUT", "MOUT");
        MockAggregatorRouter mockRouter = new MockAggregatorRouter();
        fallbackExecutor.setRouterAllowed(address(mockRouter), address(mockRouter), true);

        uint256 minOutputAmount = 100e18;  // signed floor is low, won't bind
        uint256 solverMinOut    = 1000e18; // solver promises this much...
        uint256 actualAmountOut = 500e18;  // ...but the route delivers less

        PartialFillReactor.SignedOrder memory order =
            _makeOrderWithFloor(address(mockOut), minOutputAmount, 1);

        vm.roll(block.number + 91);

        bytes memory routeCalldata = abi.encodeWithSelector(
            MockAggregatorRouter.swap.selector,
            WETH, INPUT_AMOUNT, address(mockOut), actualAmountOut, swapper
        );

        vm.prank(caller);
        vm.expectRevert("insufficient output");
        fallbackExecutor.executeFallback(order, address(mockRouter), routeCalldata, solverMinOut);
    }

    function test_fallback_revert_tooEarly() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();

        vm.prank(caller);
        vm.expectRevert("too early");
        fallbackExecutor.executeFallback(order, UNISWAP_ROUTER, bytes(""), 0);
    }

    function test_fallback_revert_expired() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();
        vm.roll(block.number + 200); // qua deadline

        // C-2: signature validation now runs first, so an expired order is
        // caught by _validateOrder ("expired") before the executor's own check.
        vm.prank(caller);
        vm.expectRevert("expired");
        fallbackExecutor.executeFallback(order, UNISWAP_ROUTER, bytes(""), 0);
    }

    function test_fallback_revert_routerNotAllowed() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();
        vm.roll(block.number + 91);

        address rogueRouter = makeAddr("rogueRouter");

        vm.prank(caller);
        vm.expectRevert("router not allowed");
        fallbackExecutor.executeFallback(order, rogueRouter, bytes(""), 0);
    }

    // C-4: an exact-output style route may consume less than `rem`. The leftover
    // input must be refunded to the swapper rather than stranded in this contract.
    function test_fallback_refundsUnconsumedInput() public {
        MockERC20 mockOut = new MockERC20("MOUT", "MOUT");
        MockAggregatorRouter mockRouter = new MockAggregatorRouter();
        fallbackExecutor.setRouterAllowed(address(mockRouter), address(mockRouter), true);

        uint256 minOutputAmount = 1000e18;
        uint256 quotedAmountOut = 1200e18;
        uint256 amountInActual  = INPUT_AMOUNT / 2; // route only needs half the approved input

        PartialFillReactor.SignedOrder memory order =
            _makeOrderWithFloor(address(mockOut), minOutputAmount, 1);

        vm.roll(block.number + 91);

        bytes memory routeCalldata = abi.encodeWithSelector(
            MockAggregatorRouter.swapPartialIn.selector,
            WETH, amountInActual, address(mockOut), quotedAmountOut, swapper
        );

        uint256 wethBefore = IERC20(WETH).balanceOf(swapper);

        vm.prank(caller);
        fallbackExecutor.executeFallback(order, address(mockRouter), routeCalldata, quotedAmountOut);

        assertEq(mockOut.balanceOf(swapper), quotedAmountOut, "swapper should receive the quoted output");
        assertEq(wethBefore - IERC20(WETH).balanceOf(swapper), amountInActual, "swapper should only spend what the route consumed");
        assertEq(IERC20(WETH).balanceOf(address(fallbackExecutor)), 0, "no input left stranded in the executor");
    }

    // C-3: a prior partial fill can individually clear its pro-rata floor while,
    // due to floor-division, the order's cumulative paid total still ends up
    // below the swapper's signed minOutputAmount once the fallback leg
    // (which itself clears ITS pro-rata floor) completes the order.
    // recordFallbackOutput's absolute-floor check must catch this.
    function test_fallback_revert_cumulativeBelowAbsoluteFloor() public {
        MockERC20 mockOut = new MockERC20("MOUT", "MOUT");
        MockAggregatorRouter mockRouter = new MockAggregatorRouter();
        fallbackExecutor.setRouterAllowed(address(mockRouter), address(mockRouter), true);

        // Custom order (inputAmount=10, minOutputAmount=19, price=1.9) chosen
        // so the floor IS reachable in a single fill (10*1.9=19 exact, passes
        // _validateOrder's register-time "unreachable min output" check) but
        // an even 5+5 split still leaks value to flooring, mirroring
        // CompletionFloor.t.sol's example but ending via fallback.
        uint256 inputAmount     = 10;
        uint256 minOutputAmount = 19;
        uint128 price           = 1.9e18;

        PartialFillReactor.OrderInfo memory info = PartialFillReactor.OrderInfo({
            swapper: swapper,
            inputToken: WETH,
            inputAmount: inputAmount,
            outputToken: address(mockOut),
            minOutputAmount: minOutputAmount,
            deadline: block.number + 100,
            nonce: 99,
            minFillBps: 0,
            startPrice: price,
            decayPerBlock: 0,
            feeTier: 500
        });
        PartialFillReactor.SignedOrder memory order =
            PartialFillReactor.SignedOrder({info: info, sig: _signOrder(info)});

        bytes32 orderHash = keccak256(abi.encode(
            reactor.ORDER_TYPE_HASH(),
            info.swapper, info.inputToken, info.inputAmount,
            info.outputToken, info.minOutputAmount,
            info.deadline, info.nonce, info.minFillBps,
            info.startPrice, info.decayPerBlock, info.feeTier
        ));

        // The reactor (not just FallbackExecutor) needs to pull via Permit2 for
        // the partial fill below.
        vm.prank(swapper);
        IPermit2Full(PERMIT2).approve(WETH, address(reactor), type(uint160).max, type(uint48).max);

        // fillerA partially fills 5 of 10: outputAmount = 5*1.9 = 9.5 -> floor 9,
        // pro-rata floor = floor(19*5/10) = 9 (9>=9 ok). Leaves a 5-unit remainder.
        address fillerA = makeAddr("fillerA");
        mockOut.mint(fillerA, 1000);
        vm.prank(fillerA);
        mockOut.approve(address(reactor), type(uint256).max);

        // fillAmount=5 (unlike the old fillAmount=2) requires a nonzero stake
        // once rounded, so fund + attach it explicitly.
        uint256 requiredStake = fillAuction.previewCollateral(WETH, info.feeTier, 5, info.deadline);
        vm.deal(fillerA, requiredStake);
        vm.prank(fillerA);
        reactor.register{value: requiredStake}(order, 5);

        vm.prank(fillerA);
        reactor.executePartialChunk(order, 5);
        assertEq(reactor.remainingInput(orderHash, inputAmount), 5, "5 units left");

        // Fallback for the remaining 5: signedFloor = floor(19*5/10) = 9. Mock
        // router delivers exactly 9 -> clears its own pro-rata floor, but
        // cumulative (9 + 9 = 18) < minOutputAmount (19).
        vm.roll(block.number + 91);

        bytes memory routeCalldata = abi.encodeWithSelector(
            MockAggregatorRouter.swap.selector,
            WETH, uint256(5), address(mockOut), uint256(9), swapper
        );

        vm.prank(caller);
        vm.expectRevert("min output total");
        fallbackExecutor.executeFallback(order, address(mockRouter), routeCalldata, 9);
    }

    function test_setRouterAllowed_onlyOwner() public {
        address newRouter = makeAddr("oneInchRouter");
        assertEq(fallbackExecutor.approveTargetOf(newRouter), address(0));

        vm.prank(caller);
        vm.expectRevert("not owner");
        fallbackExecutor.setRouterAllowed(newRouter, newRouter, true);

        // setUp() deployed fallbackExecutor as this test contract, so it is the owner.
        fallbackExecutor.setRouterAllowed(newRouter, newRouter, true);
        assertEq(fallbackExecutor.approveTargetOf(newRouter), newRouter);

        fallbackExecutor.setRouterAllowed(newRouter, newRouter, false);
        assertEq(fallbackExecutor.approveTargetOf(newRouter), address(0));
    }

    // Registering a router with a distinct approveTarget (ParaSwap-style) must
    // record that exact pairing, not silently collapse to the single-address model.
    function test_setRouterAllowed_distinctApproveTarget() public {
        address augustus  = makeAddr("augustus");
        address tokenTransferProxy = makeAddr("tokenTransferProxy");

        fallbackExecutor.setRouterAllowed(augustus, tokenTransferProxy, true);
        assertEq(fallbackExecutor.approveTargetOf(augustus), tokenTransferProxy);
    }
}
