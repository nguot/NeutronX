// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PartialFillReactor.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockPermit2.sol";
import "./mocks/MockFillAuction.sol";

contract PartialFillReactorTest is Test {
    PartialFillReactor public reactor;
    MockPermit2 public permit2;
    MockFillAuction public fillAuction;
    MockERC20 public inputToken; // USDC
    MockERC20 public outputToken; // ETH mock

    uint256 cosignerKey = 0xA11CE;
    address public cosigner = vm.addr(cosignerKey);
    address public swapper = makeAddr("swapper");
    address public filler = makeAddr("filler");

    uint256 constant INPUT_AMOUNT = 1000e6; // 1000 USDC
    uint256 constant START_PRICE = 1e15; // 0.001 ETH per USDC scaled 1e18
    uint32 constant DECAY_PER_BLOCK = 0; // không decay cho đơn giản
    uint256 constant DEADLINE = 1000;

    function _signOrder(
        PartialFillReactor.OrderInfo memory info
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                reactor.ORDER_TYPE_HASH(),
                info.swapper,
                info.inputToken,
                info.inputAmount,
                info.outputToken,
                info.minOutputAmount,
                info.deadline,
                info.nonce,
                info.minFillBps,
                info.startPrice,
                info.decayPerBlock,
                info.feeTier
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", reactor.DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cosignerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function setUp() public {
        permit2 = new MockPermit2();
        fillAuction = new MockFillAuction();
        inputToken = new MockERC20("USDC", "USDC");
        outputToken = new MockERC20("WETH", "WETH");

        reactor = new PartialFillReactor(
            address(permit2),
            address(fillAuction),
            cosigner
        );

        // mint token cho các bên
        inputToken.mint(swapper, INPUT_AMOUNT);
        outputToken.mint(filler, 10 ether);

        // approve
        vm.prank(swapper);
        inputToken.approve(address(permit2), type(uint256).max);
        vm.prank(filler);
        outputToken.approve(address(reactor), type(uint256).max);

        vm.roll(100);
    }

    function _makeOrder()
        internal
        view
        returns (PartialFillReactor.SignedOrder memory)
    {
        PartialFillReactor.OrderInfo memory info = PartialFillReactor
            .OrderInfo({
                swapper: swapper,
                inputToken: address(inputToken),
                inputAmount: INPUT_AMOUNT,
                outputToken: address(outputToken),
                minOutputAmount: 0,
                deadline: DEADLINE,
                nonce: 1,
                minFillBps: 0,
                startPrice: uint128(START_PRICE),
                decayPerBlock: DECAY_PER_BLOCK,
                feeTier: 3000
            });
        return
            PartialFillReactor.SignedOrder({info: info, sig: _signOrder(info)});
    }

    // ── executePartialChunk ──

    function test_firstFill_success() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();
        uint256 fillAmount = 400e6;

        uint256 swapperBalBefore = inputToken.balanceOf(swapper);
        uint256 fillerBalBefore = outputToken.balanceOf(filler);

        vm.prank(filler);
        reactor.executePartialChunk(order, fillAmount);

        // filler nhận USDC
        assertEq(inputToken.balanceOf(filler), fillAmount);
        // swapper nhận WETH
        assertGt(outputToken.balanceOf(swapper), 0);
        // swapper mất USDC
        assertEq(inputToken.balanceOf(swapper), swapperBalBefore - fillAmount);
        // filler bỏ ra WETH
        assertLt(outputToken.balanceOf(filler), fillerBalBefore);
    }

    function test_fill_revert_notRegistered() public {
        fillAuction.setValidRegistration(false);
        PartialFillReactor.SignedOrder memory order = _makeOrder();

        vm.prank(filler);
        vm.expectRevert("not registered");
        reactor.executePartialChunk(order, 400e6);
    }

    function test_fill_revert_expired() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();
        vm.roll(DEADLINE + 1);

        vm.prank(filler);
        vm.expectRevert("expired");
        reactor.executePartialChunk(order, 400e6);
    }

    function test_fill_revert_fillExceedsRemaining() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();

        // fill lần 1
        vm.prank(filler);
        reactor.executePartialChunk(order, 600e6);

        // fill lần 2 vượt remaining
        vm.prank(filler);
        vm.expectRevert("fill > remaining");
        reactor.executePartialChunk(order, 600e6);
    }

    function test_multipleFills_remainingDecreases() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();
        bytes32 orderHash = keccak256(
            abi.encode(
                reactor.ORDER_TYPE_HASH(),
                swapper,
                address(inputToken),
                INPUT_AMOUNT,
                address(outputToken),
                uint256(0),
                DEADLINE,
                uint256(1),
                uint16(0),
                uint128(START_PRICE),
                DECAY_PER_BLOCK,
                uint24(3000)
            )
        );

        vm.prank(filler);
        reactor.executePartialChunk(order, 400e6);

        assertEq(reactor.remainingInput(orderHash, INPUT_AMOUNT), 600e6);
    }

    function test_onFillSuccess_called() public {
        PartialFillReactor.SignedOrder memory order = _makeOrder();

        vm.prank(filler);
        reactor.executePartialChunk(order, 400e6);

        assertTrue(fillAuction.onFillSuccessCalled());
    }
}
