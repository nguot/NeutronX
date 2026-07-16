// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/crosschain/EscrowSrc.sol";
import "../src/crosschain/EscrowSrcFactory.sol";
import "../src/crosschain/EscrowDst.sol";
import "../src/crosschain/EscrowDstFactory.sol";
import "../src/libs/DynamicStakeLib.sol";
import "../src/interfaces/IEthNotionalOracle.sol";

/**
 * Four entry points — each pair deployed to its own chain. A→B swaps use
 * runChainA()+runChainB(); B→A swaps use the mirror-image runChainB_Src()+
 * runChainA_Dst(). Model 2 (filler-holds-key): there is no cosigner anymore —
 * EscrowSrcFactory only checks the swapper's own two signatures (order intent
 * + per-fill authorization). See EscrowSrcFactory's file header.
 *
 *   Chain A (source / WETH):
 *     forge script script/DeployCrossChain.s.sol \
 *       --sig "runChainA()" --rpc-url http://127.0.0.1:8545 --broadcast --private-key 0x...
 *
 *   Chain B (destination / USDC):
 *     forge script script/DeployCrossChain.s.sol \
 *       --sig "runChainB()" --rpc-url http://127.0.0.1:8546 --broadcast --private-key 0x...
 *
 *   Chain B (source / USDC, for B→A swaps):
 *     forge script script/DeployCrossChain.s.sol \
 *       --sig "runChainB_Src()" --rpc-url http://127.0.0.1:8546 --broadcast --private-key 0x...
 *
 *   Chain A (destination / WETH, for B→A swaps):
 *     forge script script/DeployCrossChain.s.sol \
 *       --sig "runChainA_Dst()" --rpc-url http://127.0.0.1:8545 --broadcast --private-key 0x...
 */
contract DeployCrossChain is Script {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Local/anvil-fork deploy: bond oracle disabled (test/mock mode — see
    // IEthNotionalOracle). Wiring each chain's real oracle (a deployed
    // UniswapV3NotionalOracle or equivalent, from the chain registry) is
    // Phase 5 (config cleanup) of the cross-chain redesign, not this script's job.
    function _minimalStakeConfig() internal pure returns (DynamicStakeLib.StakeConfig memory c) {
        c.collateralRate = new uint32[](1);
        c.collateralRate[0] = 2000; // 20% of notional — same order of magnitude as the old flat deposit
        c.timeMult = new uint32[](1);
        c.timeMult[0] = 10000; // 1x
        c.refundTable = new uint32[](1);
        c.refundTable[0] = 10000; // inert here (bond is binary, not a refund schedule) — must still end at 100%
        c.minCollateral = 0.001 ether; // mirrors the old MIN_SAFETY_DEPOSIT floor
    }

    // Chain A — EscrowSrc is the clone template; EscrowSrcFactory verifies
    // the swapper's order + per-fill signatures and deploys one clone per
    // fill, pulling the swapper's WETH via Permit2 redirect.
    // Requires --private-key CLI flag
    function runChainA() external {
        vm.startBroadcast();
        EscrowSrc        impl    = new EscrowSrc();
        EscrowSrcFactory factory = new EscrowSrcFactory(
            address(impl), PERMIT2, IEthNotionalOracle(address(0)), true, _minimalStakeConfig()
        );
        vm.stopBroadcast();

        console.log("EscrowSrc impl:  ", address(impl));
        console.log("EscrowSrcFactory:", address(factory));
    }

    // Chain B — EscrowDst is the clone template; EscrowDstFactory deploys one
    // clone per filler slot fill.  Only the factory address is needed in .env.
    // Requires --private-key CLI flag
    function runChainB() external {
        // Broadcaster from CLI (--private-key); avoids the contract/.env anvil PRIVATE_KEY.
        vm.startBroadcast();
        EscrowDst        impl    = new EscrowDst();
        EscrowDstFactory factory = new EscrowDstFactory(address(impl));
        vm.stopBroadcast();

        console.log("EscrowDst impl:  ", address(impl));
        console.log("EscrowDstFactory:", address(factory));
    }

    // Chain B — mirror of runChainA(), for B→A swaps: the swapper locks USDC
    // here via Permit2, fillers pull it out after revealing the secret on Chain A.
    // Requires --private-key CLI flag
    function runChainB_Src() external {
        vm.startBroadcast();
        EscrowSrc        impl    = new EscrowSrc();
        EscrowSrcFactory factory = new EscrowSrcFactory(
            address(impl), PERMIT2, IEthNotionalOracle(address(0)), true, _minimalStakeConfig()
        );
        vm.stopBroadcast();

        console.log("EscrowSrc impl:  ", address(impl));
        console.log("EscrowSrcFactory:", address(factory));
    }

    // Chain A — mirror of runChainB(), for B→A swaps: fillers deploy isolated
    // WETH escrow clones here, claimed by the backend's chainAWatcher.
    // Requires --private-key CLI flag
    function runChainA_Dst() external {
        // Broadcaster from CLI (--private-key); avoids the contract/.env anvil PRIVATE_KEY.
        vm.startBroadcast();
        EscrowDst        impl    = new EscrowDst();
        EscrowDstFactory factory = new EscrowDstFactory(address(impl));
        vm.stopBroadcast();

        console.log("EscrowDst impl:  ", address(impl));
        console.log("EscrowDstFactory:", address(factory));
    }
}
