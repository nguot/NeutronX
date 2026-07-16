// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FillAuction.sol";
import "../src/oracles/UniswapV3NotionalOracle.sol";

/// D-1 fork test: collateral is denominated in ETH for ANY input token via a
/// Uniswap V3 TWAP over the (token, WETH) pool. Runs against a mainnet fork
/// (ALCHEMY_RPC_URL), where the real V3 factory + pools exist.
contract TwapCollateralTest is Test {
    address constant WETH    = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC    = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;

    address treasury = makeAddr("treasury");
    FillAuction auction;

    function setUp() public {
        vm.createSelectFork(vm.envString("ALCHEMY_RPC_URL"));
        UniswapV3NotionalOracle oracle = new UniswapV3NotionalOracle(WETH, FACTORY, 60); // 60s TWAP
        auction = new FillAuction(treasury, oracle, false);
    }

    /// WETH input short-circuits the oracle: notional == fillAmount.
    /// 1 ETH notional -> sBucket 1 (1-10 ETH) -> rate 5000 (50%).
    function test_wethInput_isOneToOne() public {
        uint256 c = auction.previewCollateral(WETH, 500, 1 ether, block.number + 100);
        assertEq(c, uint256(1 ether) * 5000 / 10000);
    }

    /// USDC input is priced through the TWAP. The resulting stake must be
    /// ETH-scale (a fraction of an ETH), NOT the dimensional nonsense of
    /// treating ~3000e6 USDC units as ~3000e6 wei (which would be ~3e-9 ETH).
    function test_usdcInput_pricedViaTwap() public {
        uint256 deadline = block.number + 100;
        uint256 c3000 = auction.previewCollateral(USDC, 500, 3000e6, deadline);
        uint256 c6000 = auction.previewCollateral(USDC, 500, 6000e6, deadline);

        assertGt(c3000, 0, "TWAP-priced collateral must be non-zero");
        assertGt(c6000, c3000, "collateral must grow with fill size");

        // ~3000 USDC is ~1 ETH of value: collateral (a fraction of that) should
        // sit comfortably in [0.01, 5] ETH — proving the value is in ETH, not
        // raw token units.
        assertGt(c3000, 0.01 ether);
        assertLt(c3000, 5 ether);
    }
}
