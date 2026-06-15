// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/crosschain/EscrowSrc.sol";
import "../src/crosschain/EscrowSrcFactory.sol";
import "../src/crosschain/EscrowDst.sol";
import "../src/crosschain/EscrowDstFactory.sol";

/**
 * Four entry points — each pair deployed to its own chain. A→B swaps use
 * runChainA()+runChainB(); B→A swaps use the mirror-image runChainB_Src()+
 * runChainA_Dst(), reusing the SAME cosigner. COSIGNER_ADDRESS is the SERVER's
 * single attestation key (Trufy 3.1) — one key for every swapper and every
 * order, NOT one per session — and must equal the backend's COSIGNER_PRIVATE_KEY
 * address. The factory stores it immutably and accepts only signatures from it:
 *
 *   Chain A (source / WETH):
 *     PRIVATE_KEY=0x... COSIGNER_ADDRESS=0x... forge script script/DeployCrossChain.s.sol \
 *       --sig "runChainA()" --rpc-url http://127.0.0.1:8545 --broadcast
 *
 *   Chain B (destination / USDC):
 *     PRIVATE_KEY=0x... forge script script/DeployCrossChain.s.sol \
 *       --sig "runChainB()" --rpc-url http://127.0.0.1:8546 --broadcast
 *
 *   Chain B (source / USDC, for B→A swaps):
 *     PRIVATE_KEY=0x... COSIGNER_ADDRESS=0x... forge script script/DeployCrossChain.s.sol \
 *       --sig "runChainB_Src()" --rpc-url http://127.0.0.1:8546 --broadcast
 *
 *   Chain A (destination / WETH, for B→A swaps):
 *     PRIVATE_KEY=0x... forge script script/DeployCrossChain.s.sol \
 *       --sig "runChainA_Dst()" --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract DeployCrossChain is Script {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Chain A — EscrowSrc is the clone template; EscrowSrcFactory verifies
    // signatures + Merkle proofs and deploys one clone per filled slot,
    // pulling the swapper's WETH via Permit2 redirect.
    // Requires env: PRIVATE_KEY, COSIGNER_ADDRESS
    function runChainA() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address cosigner    = vm.envAddress("COSIGNER_ADDRESS");

        vm.startBroadcast(deployerKey);
        EscrowSrc        impl    = new EscrowSrc();
        EscrowSrcFactory factory = new EscrowSrcFactory(address(impl), PERMIT2, cosigner);
        vm.stopBroadcast();

        console.log("EscrowSrc impl:  ", address(impl));
        console.log("EscrowSrcFactory:", address(factory));
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

    // Chain B — mirror of runChainA(), for B→A swaps: the swapper locks USDC
    // here via Permit2, fillers pull it out after revealing S_i on Chain A.
    // Requires env: PRIVATE_KEY, COSIGNER_ADDRESS
    function runChainB_Src() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address cosigner    = vm.envAddress("COSIGNER_ADDRESS");

        vm.startBroadcast(deployerKey);
        EscrowSrc        impl    = new EscrowSrc();
        EscrowSrcFactory factory = new EscrowSrcFactory(address(impl), PERMIT2, cosigner);
        vm.stopBroadcast();

        console.log("EscrowSrc impl:  ", address(impl));
        console.log("EscrowSrcFactory:", address(factory));
    }

    // Chain A — mirror of runChainB(), for B→A swaps: fillers deploy isolated
    // WETH escrow clones here, claimed by the backend's chainAWatcher.
    // Requires env: PRIVATE_KEY
    function runChainA_Dst() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        EscrowDst        impl    = new EscrowDst();
        EscrowDstFactory factory = new EscrowDstFactory(address(impl));
        vm.stopBroadcast();

        console.log("EscrowDst impl:  ", address(impl));
        console.log("EscrowDstFactory:", address(factory));
    }
}
