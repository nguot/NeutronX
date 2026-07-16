// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/FillAuction.sol";
import "../src/PartialFillReactor.sol";
import "../src/FallbackExecutor.sol";
import "../src/oracles/UniswapV3NotionalOracle.sol";

contract Deploy is Script {
    // địa chỉ thật trên mainnet
    address constant PERMIT2        = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant UNISWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    // AggregationRouterV6 — same address on every chain 1inch supports. Seeded into
    // the allowlist here to show that adding a fallback aggregator is just one
    // setRouterAllowed call, not a redeploy.
    address constant ONEINCH_ROUTER  = 0x111111125421cA6dc452d289314280a0f8842A65;
    // MetaAggregationRouterV2 — same address on every chain KyberSwap supports.
    // Single-address approve+call model, unlike ParaSwap's Augustus/tokenTransferProxy split.
    address constant KYBER_ROUTER    = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;
    // ParaSwap (now Velora) v5 — two-address model: Augustus is the call target,
    // TokenTransferProxy is the separate spender that must hold the approval.
    address constant PARASWAP_AUGUSTUS           = 0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57;
    address constant PARASWAP_TOKEN_TRANSFER_PROXY = 0x216B4B4Ba9F3e719726886d34a177484278Bfcae;
    // D-1 collateral oracle: real mainnet WETH + Uniswap V3 factory (present on a fork too).
    address constant WETH           = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant UNIV3_FACTORY  = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    // Short TWAP window: WETH inputs short-circuit (no oracle), and on a frozen
    // fork a short look-back stays within the pool's inherited observations.
    uint32  constant TWAP_WINDOW    = 60;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        // B1/B5: FillAuction's 3 economic roles (PARAM_ADMIN calls setStakeConfig,
        // GUARDIAN calls rollback/cancelPendingConfig, KEEPER only moves
        // sizeThresholds — B6, not wired yet). Each defaults to the deployer if
        // its env var is unset, so a bare `forge script` still works, but
        // demoing "tam quyền phân lập" (role separation) means setting these to
        // 3 DIFFERENT addresses in .env — see ACCOUNTS.md.
        address paramAdmin = vm.envOr("PARAM_ADMIN_ADDR", deployer);
        address guardian   = vm.envOr("GUARDIAN_ADDR", deployer);
        address keeper     = vm.envOr("KEEPER_ADDR", deployer);

        vm.startBroadcast(deployerKey);

        // 1. Deploy the notional oracle, then FillAuction pointed at it.
        UniswapV3NotionalOracle oracle = new UniswapV3NotionalOracle(WETH, UNIV3_FACTORY, TWAP_WINDOW);
        console.log("UniswapV3NotionalOracle:", address(oracle));
        FillAuction fillAuction = new FillAuction(deployer, oracle, false);
        console.log("FillAuction:        ", address(fillAuction));

        // 1b. Wire the 3 roles (deployer keeps DEFAULT_ADMIN_ROLE to grant/revoke later).
        fillAuction.grantRole(fillAuction.PARAM_ADMIN_ROLE(), paramAdmin);
        fillAuction.grantRole(fillAuction.GUARDIAN_ROLE(), guardian);
        fillAuction.grantRole(fillAuction.KEEPER_ROLE(), keeper);
        console.log("PARAM_ADMIN_ROLE -> ", paramAdmin);
        console.log("GUARDIAN_ROLE    -> ", guardian);
        console.log("KEEPER_ROLE      -> ", keeper);

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

        // 6. Allowlist further fallback aggregators alongside Uniswap.
        // Single-address aggregators: approveTarget == router itself.
        fallbackExecutor.setRouterAllowed(ONEINCH_ROUTER, ONEINCH_ROUTER, true);
        console.log("1inch router allowlisted");

        fallbackExecutor.setRouterAllowed(KYBER_ROUTER, KYBER_ROUTER, true);
        console.log("KyberSwap router allowlisted");

        // ParaSwap: approveTarget is the separate TokenTransferProxy, not Augustus.
        fallbackExecutor.setRouterAllowed(PARASWAP_AUGUSTUS, PARASWAP_TOKEN_TRANSFER_PROXY, true);
        console.log("ParaSwap (Augustus) router allowlisted");

        vm.stopBroadcast();
    }
}