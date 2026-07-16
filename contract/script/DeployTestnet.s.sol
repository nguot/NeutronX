// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/FillAuction.sol";
import "../src/PartialFillReactor.sol";
import "../src/FallbackExecutor.sol";
import "../src/oracles/UniswapV3NotionalOracle.sol";
import "../src/interfaces/IEthNotionalOracle.sol";

/**
 * Testnet deployment of the single-chain partial-fill stack.
 *
 * Oracle-DISABLED by default (no Uniswap V3 dependency), so it runs on ANY EVM
 * testnet out of the box. To use the real TWAP collateral oracle on a testnet
 * that has a Uniswap V3 (token, WETH) pool WITH observation history, set:
 *   ORACLE_DISABLED=false WETH=0x.. UNIV3_FACTORY=0x.. TWAP_WINDOW=60
 *
 * Deployer key: pass on the CLI via --private-key / --account / --ledger. Do NOT
 * rely on a PRIVATE_KEY env var — contract/.env sets it to the local-anvil key.
 *
 * Optional env (sensible defaults):
 *   PERMIT2            default = canonical 0x0000..78BA3 (present on Sepolia etc.)
 *   COSIGNER_ADDRESS   backend attestation key; default = deployer (bring-up only)
 *   ORACLE_DISABLED    default = true
 *   FALLBACK_ROUTER    aggregator router; if unset, FallbackExecutor is skipped
 *
 * Example (Sepolia, oracle-disabled):
 *   forge script script/DeployTestnet.s.sol \
 *     --rpc-url $SEPOLIA_RPC_URL --private-key 0x<funded> --broadcast
 */
contract DeployTestnet is Script {
    // Permit2 — same canonical CREATE2 address on every chain that has it.
    address constant PERMIT2_DEFAULT = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external {
        address permit2        = vm.envOr("PERMIT2", PERMIT2_DEFAULT);
        bool    oracleDisabled = vm.envOr("ORACLE_DISABLED", true);
        address weth           = vm.envOr("WETH", address(0));
        address univ3Factory   = vm.envOr("UNIV3_FACTORY", address(0));
        uint32  twapWindow     = uint32(vm.envOr("TWAP_WINDOW", uint256(0)));
        address fallbackRouter = vm.envOr("FALLBACK_ROUTER", address(0));

        // Broadcaster identity comes from the CLI (--private-key / --account /
        // --ledger), NOT a PRIVATE_KEY env var. The repo's contract/.env sets
        // PRIVATE_KEY to the local-anvil key and foundry auto-loads it, so reading
        // the env here would silently override --private-key (deploying from the
        // unfunded anvil account). Using the CLI broadcaster avoids that footgun.
        vm.startBroadcast();
        (, address deployer, ) = vm.readCallers();
        address cosigner = vm.envOr("COSIGNER_ADDRESS", deployer);

        console.log("Deployer:           ", deployer);
        console.log("Permit2:            ", permit2);
        console.log("Oracle disabled:    ", oracleDisabled);
        console.log("Cosigner:           ", cosigner);

        // 1. FillAuction — oracle-disabled unless explicitly enabled.
        IEthNotionalOracle oracle = oracleDisabled
            ? IEthNotionalOracle(address(0))
            : IEthNotionalOracle(address(new UniswapV3NotionalOracle(weth, univ3Factory, twapWindow)));
        if (!oracleDisabled) console.log("UniswapV3NotionalOracle:", address(oracle));
        FillAuction fillAuction = new FillAuction(deployer, oracle, oracleDisabled);
        console.log("FillAuction:        ", address(fillAuction));

        // 2. PartialFillReactor.
        PartialFillReactor reactor = new PartialFillReactor(permit2, address(fillAuction), cosigner);
        console.log("PartialFillReactor: ", address(reactor));

        // 3. Wire FillAuction -> Reactor (one-time).
        fillAuction.setReactor(address(reactor));
        console.log("setReactor done");

        // 4. Optional FallbackExecutor (only if a testnet aggregator router is given).
        if (fallbackRouter != address(0)) {
            FallbackExecutor fb = new FallbackExecutor(permit2, address(reactor), fallbackRouter);
            reactor.setFallbackExecutor(address(fb));
            console.log("FallbackExecutor:   ", address(fb));
        } else {
            console.log("FallbackExecutor:    SKIPPED (set FALLBACK_ROUTER to enable)");
        }

        vm.stopBroadcast();
    }
}
