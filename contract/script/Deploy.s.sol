// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/FillAuction.sol";
import "../src/PartialFillReactor.sol";
import "../src/FallbackExecutor.sol";

contract Deploy is Script {
    // địa chỉ thật trên mainnet
    address constant PERMIT2        = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant UNISWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    // D-1 collateral oracle: real mainnet WETH + Uniswap V3 factory (present on a fork too).
    address constant WETH           = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant UNIV3_FACTORY  = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    // Short TWAP window: WETH inputs short-circuit (no oracle), and on a frozen
    // fork a short look-back stays within the pool's inherited observations.
    uint32  constant TWAP_WINDOW    = 60;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. Deploy FillAuction
        FillAuction fillAuction = new FillAuction(deployer, WETH, UNIV3_FACTORY, TWAP_WINDOW);
        console.log("FillAuction:        ", address(fillAuction));

        // 2. Deploy PartialFillReactor
        PartialFillReactor reactor = new PartialFillReactor(
            PERMIT2,
            address(fillAuction),
            deployer  // cosigner = deployer tạm thời
        );
        console.log("PartialFillReactor: ", address(reactor));

        // 3. Wire FillAuction → Reactor
        fillAuction.setReactor(address(reactor));
        console.log("setReactor done");

        // 4. Deploy FallbackExecutor
        FallbackExecutor fallbackExecutor  = new FallbackExecutor(
            PERMIT2,
            address(reactor),
            UNISWAP_ROUTER
        );
        console.log("FallbackExecutor:   ", address(fallbackExecutor));

        // 5. Wire Reactor → FallbackExecutor (one-time, guards markFallbackInitiated)
        reactor.setFallbackExecutor(address(fallbackExecutor));
        console.log("setFallbackExecutor done");

        vm.stopBroadcast();
    }
}