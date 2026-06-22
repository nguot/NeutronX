// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./adversarial/AdversarialBase.sol";
import "./mocks/FeeOnTransferToken.sol";

/// Trufy 3.2 — fee-on-transfer output token.
///
/// The reactor used to enforce the swapper's slippage floor on the NOMINAL output
/// amount it told the filler to send. With a fee-on-transfer output token the
/// swapper is credited less than that nominal amount, so the floor could pass on
/// paper while the swapper is shortchanged. The fix measures the swapper's actual
/// balance delta and enforces the floor on what they truly receive.
contract FeeOnTransferTest is AdversarialBase {
    address swapper = makeAddr("swapper");
    address filler  = makeAddr("filler");

    function setUp() public {
        _deployCore();
        // Swap the plain USDC output token for a 2% fee-on-transfer variant.
        usdc = MockERC20(address(new FeeOnTransferToken("feeUSDC", "fUSDC", 200)));
    }

    /// Nominal output clears the floor, but the 2% skim drops the swapper BELOW it
    /// → the fill must revert instead of silently underpaying the swapper.
    function test_feeOnTransferOutput_belowFloor_reverts() public {
        // 1 WETH in, floor 2475 USDC. At price 2500 the nominal output is 2500
        // (>= 2475, old check passes), but 2% fee leaves 2450 (< 2475).
        PartialFillReactor.OrderInfo memory info =
            _orderInfo(swapper, 1e18, 2_475e6, START_PRICE, 0, 1, block.number + 100);
        PartialFillReactor.SignedOrder memory order = _signed(info);

        _fundSwapper(swapper, 1e18);
        _fundFiller(filler, 10_000e6, 100 ether);
        _register(filler, order, 1e18);

        vm.prank(filler);
        vm.expectRevert(bytes("min output"));
        reactor.executePartialChunk(order, 1e18);
    }

    /// With a lower floor the fee-reduced amount still clears it → the fill
    /// succeeds AND the swapper's recorded credit is the ACTUAL received amount
    /// (2450), not the nominal 2500.
    function test_feeOnTransferOutput_aboveFloor_creditsActualReceived() public {
        PartialFillReactor.OrderInfo memory info =
            _orderInfo(swapper, 1e18, 2_400e6, START_PRICE, 0, 2, block.number + 100);
        PartialFillReactor.SignedOrder memory order = _signed(info);

        _fundSwapper(swapper, 1e18);
        _fundFiller(filler, 10_000e6, 100 ether);
        _register(filler, order, 1e18);

        vm.prank(filler);
        reactor.executePartialChunk(order, 1e18);

        // 2500 nominal, 2% skim → swapper actually holds 2450.
        assertEq(usdc.balanceOf(swapper), 2_450e6, "swapper credited actual received");
    }
}
