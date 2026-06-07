// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/crosschain/CrossChainReactor.sol";
import "../src/crosschain/EscrowDst.sol";
import "../src/crosschain/EscrowDstFactory.sol";

/**
 * Two separate entry points — each deployed to its own chain:
 *
 *   Chain A (source / WETH):
 *     PRIVATE_KEY=0x... COSIGNER_ADDRESS=0x... forge script script/DeployCrossChain.s.sol \
 *       --sig "runChainA()" --rpc-url http://127.0.0.1:8545 --broadcast
 *
 *   Chain B (destination / USDC):
 *     PRIVATE_KEY=0x... forge script script/DeployCrossChain.s.sol \
 *       --sig "runChainB()" --rpc-url http://127.0.0.1:8546 --broadcast
 */
contract DeployCrossChain is Script {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Chain A — CrossChainReactor holds swapper's WETH and verifies Merkle proofs.
    // Requires env: PRIVATE_KEY, COSIGNER_ADDRESS
    function runChainA() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address cosigner    = vm.envAddress("COSIGNER_ADDRESS");

        vm.startBroadcast(deployerKey);
        CrossChainReactor reactor = new CrossChainReactor(PERMIT2, cosigner);
        vm.stopBroadcast();

        console.log("CrossChainReactor:", address(reactor));
    }

    // Chain B — EscrowDst is the clone template; EscrowDstFactory deploys one
    // clone per filler slot fill.  Only the factory address is needed in .env.
    // Requires env: PRIVATE_KEY
    function runChainB() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        EscrowDst        impl    = new EscrowDst();
        EscrowDstFactory factory = new EscrowDstFactory(address(impl));
        vm.stopBroadcast();

        console.log("EscrowDst impl:  ", address(impl));
        console.log("EscrowDstFactory:", address(factory));
    }
}
