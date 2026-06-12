// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FallbackExecutor.sol";
import "../src/PartialFillReactor.sol";
import "../src/FillAuction.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
    uint256 deadline; // ← thiếu cái này
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
        fillAuction = new FillAuction(treasury, WETH, address(0), 0); // input is WETH → oracle short-circuits 1:1
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
        PartialFillReactor.OrderInfo memory info = PartialFillReactor
            .OrderInfo({
                swapper: swapper,
                inputToken: WETH,
                inputAmount: INPUT_AMOUNT,
                outputToken: USDC,
                minOutputAmount: 1000e6, // min 1000 USDC
                deadline: block.number + 100,
                nonce: 1,
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

    function test_fallback_swapsSuccessfully() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();

        // roll đến trong FALLBACK_WINDOW
        vm.roll(block.number + 91); // còn 9 blocks đến deadline, < FALLBACK_WINDOW(10)

        //hardcode routeData
        bytes memory routeCalldata = abi.encodeWithSelector(
            bytes4(
                keccak256(
                    "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))"
                )
            ),
            WETH,
            USDC,
            uint24(500),
            swapper,
            block.timestamp + 300, // deadline
            INPUT_AMOUNT,
            uint256(2000e6),
            uint160(0)
        );

        uint256 usdcBefore = IERC20(USDC).balanceOf(swapper);
        uint256 wethBefore = IERC20(WETH).balanceOf(swapper);

        vm.prank(caller);
        fallbackExecutor.executeFallback(order, routeCalldata, 2000e6);

        assertGt(
            IERC20(USDC).balanceOf(swapper),
            usdcBefore,
            "swapper should receive USDC"
        );
        assertLt(
            IERC20(WETH).balanceOf(swapper),
            wethBefore,
            "swapper should spend WETH"
        );
    }

    function test_fallback_revert_tooEarly() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();

        vm.prank(caller);
        vm.expectRevert("too early");
        fallbackExecutor.executeFallback(order, bytes(""), 0);
    }

    function test_fallback_revert_expired() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();
        vm.roll(block.number + 200); // qua deadline

        // C-2: signature validation now runs first, so an expired order is
        // caught by _validateOrder ("expired") before the executor's own check.
        vm.prank(caller);
        vm.expectRevert("expired");
        fallbackExecutor.executeFallback(order, bytes(""), 0);
    }
}
