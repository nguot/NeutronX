// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUniswapV3Factory, IUniswapV3PoolOracle} from "../interfaces/IUniswapV3.sol";

// Comment-code legend: see the top of FillAuction.sol for the full write-up of
// every label used below. Quick reference —
//   D-1/D-2 (hyphen)  = audit.md's own findings (D-1: collateral math was
//                        dimensionally broken for non-WETH tokens; D-2: refund
//                        ratio was keyed to the whole order, not the filler's
//                        own commitment).
//   Trufy 3.1         = external audit: absolute collateral-floor backstop.
//   B1-B6 / D1-D4 / #1-#3 = the refactor's own build phases / B4 design
//                        decisions / risk items, see DYNAMIC_STAKE_CONFIG_REFACTOR.md.
library DynamicStakeLib {
    // B2: bucket boundaries + rates/multipliers/refund table are now runtime
    // config instead of hardcoded arrays, so both the VALUES and the NUMBER OF
    // BUCKETS can be changed without redeploying. See FillAuction._validate for
    // the invariants a StakeConfig must satisfy before it can be installed.
    struct StakeConfig {
        uint256[] sizeThresholds;  // len = S-1, strictly increasing (ETH wei)  -> S size buckets
        uint32[]  collateralRate;  // len = S, bps of notional
        uint256[] timeThresholds;  // len = T-1, strictly DECREASING (blocks-left) -> T time buckets
        uint32[]  timeMult;        // len = T, bps (10000 = 1x)
        uint256[] ratioThresholds; // len = R-1, strictly increasing (bps of fill ratio) -> R fill-ratio buckets
        uint32[]  refundTable;     // len = S*R, row-major: refundTable[s*R + r], bps of stake
        // B4/D4: folded in rather than left as a standalone FillAuction setter —
        // a separate `setMinCollateral` would let PARAM_ADMIN zero out the
        // collateral floor with none of _validate/_isLoosening/maxDelta/pending
        // applying to it. As a StakeConfig field it goes through all of them.
        uint256   minCollateral;
    }

    /// B2: the pre-refactor fixed-array defaults (4 size buckets x 5 fill-ratio
    /// buckets), expressed as dynamic arrays — same numbers as the original
    /// design, called once from FillAuction's constructor. Lives here (not in
    /// FillAuction) purely so this constructor-only table-building code doesn't
    /// count against FillAuction's own EIP-170 deployed-bytecode budget.
    function defaultStakeConfig() public pure returns (StakeConfig memory c) {
        c.sizeThresholds = new uint256[](3);
        c.sizeThresholds[0] = 1 ether;
        c.sizeThresholds[1] = 10 ether;
        c.sizeThresholds[2] = 100 ether;

        // collateralRate[orderSizeBucket], in bps of fillAmount(ceiling). Taken
        // from the original 2D design's "10-30% fill" row - a mid-range rate
        // that still scales with order size only.
        c.collateralRate = new uint32[](4);
        c.collateralRate[0] = 2000;
        c.collateralRate[1] = 5000;
        c.collateralRate[2] = 10000;
        c.collateralRate[3] = 30000;

        // time buckets: >50 / >20 / >5 / else blocks left -> 1x/1.5x/3x/5x
        c.timeThresholds = new uint256[](3);
        c.timeThresholds[0] = 50;
        c.timeThresholds[1] = 20;
        c.timeThresholds[2] = 5;

        c.timeMult = new uint32[](4);
        c.timeMult[0] = 10000;
        c.timeMult[1] = 15000;
        c.timeMult[2] = 30000;
        c.timeMult[3] = 50000;

        // fill-ratio buckets, in bps of the ratio: <2% / <10% / <30% / <70% / else
        c.ratioThresholds = new uint256[](4);
        c.ratioThresholds[0] = 200;
        c.ratioThresholds[1] = 1000;
        c.ratioThresholds[2] = 3000;
        c.ratioThresholds[3] = 7000;

        // refundTable[orderSizeBucket][fillRatioBucket], in bps of stakeAmount
        // returned to the filler at onFillSuccess, row-major [s*5 + r]. Each row
        // is non-decreasing and ends at 10000 (100%): filling a small % of the
        // order forfeits most of the collateral to the treasury as a "sniping
        // fee", filling >=70% returns it in full. See test/libs/DynamicStakeLibStake.md.
        uint32[5][4] memory defaultRefundTable = [
            [uint32(500), 1000, 2500, 5000, 10000],
            [uint32(333), 1000, 2000, 5000, 10000],
            [uint32(100),  333, 1000, 3333, 10000],
            [uint32(100),  200,  667, 2000, 10000]
        ];
        c.refundTable = new uint32[](20);
        for (uint256 s = 0; s < 4; s++) {
            for (uint256 r = 0; r < 5; r++) {
                c.refundTable[s * 5 + r] = defaultRefundTable[s][r];
            }
        }
    }

    /// Order-size bucket on an ETH-denominated notional (wei). `sizeThresholds`
    /// must be strictly increasing; bucket i is picked for the first threshold
    /// the notional is strictly below, else the last bucket.
    function getOrderSizeBucketETH(
        uint256 notionalEth,
        uint256[] memory sizeThresholds
    ) public pure returns (uint8) {
        uint256 n = sizeThresholds.length;
        for (uint256 i = 0; i < n; i++) {
            if (notionalEth < sizeThresholds[i]) return uint8(i);
        }
        return uint8(n);
    }

    /// D-2: fill-ratio bucket as bps of the filler's OWN commitment delivered
    /// (`fill`/`total`), against `ratioThresholds` (strictly increasing, bps).
    /// `fill >= total` (full delivery) always lands in the last bucket, both as
    /// the correct 100% answer and to sidestep a division when total == 0.
    function getFillRatioBucket(
        uint256 fill,
        uint256 total,
        uint256[] memory ratioThresholds
    ) public pure returns (uint8) {
        uint256 n = ratioThresholds.length;
        if (fill >= total) return uint8(n);
        uint256 pctBps = (fill * 10000) / total;
        for (uint256 i = 0; i < n; i++) {
            if (pctBps < ratioThresholds[i]) return uint8(i);
        }
        return uint8(n);
    }

    /// Legacy USDC-denominated size bucket. Retained only for the refund-table
    /// shape tests; production collateral/refund now bucket on the ETH notional.
    function getOrderSizeBucket(uint256 total) public pure returns (uint8) {
        // Units: USDC (6 decimals)
        if (total < 10_000e6) return 0;
        if (total < 100_000e6) return 1;
        if (total < 1_000_000e6) return 2;
        return 3;
    }

    /// Time bucket off blocks-left-to-deadline. `timeThresholds` is strictly
    /// DECREASING (more blocks left => lower bucket => smaller multiplier);
    /// bucket i is picked for the first threshold `left` is strictly above.
    function getTimeBucket(
        uint256 deadline,
        uint256[] memory timeThresholds
    ) public view returns (uint8) {
        uint256 n = timeThresholds.length;
        if (block.number >= deadline) return uint8(n);
        uint256 left = deadline - block.number;
        for (uint256 i = 0; i < n; i++) {
            if (left > timeThresholds[i]) return uint8(i);
        }
        return uint8(n);
    }

    /// D-1: value `fillAmount` of `inputToken` in ETH (wei), via a Uniswap V3
    /// TWAP over the (inputToken, WETH) pool at the order's `feeTier`.
    /// - inputToken == weth  → 1:1 (no oracle needed)
    /// - factory == 0        → oracle disabled (test/mock mode): treats the raw
    ///                         amount as the notional, reproducing pre-D-1 behaviour
    /// The V3 price is already expressed in raw token units, so token decimals
    /// are handled automatically.
    function toEthNotional(
        uint256 fillAmount,
        address inputToken,
        uint24  feeTier,
        address weth,
        address uniV3Factory,
        uint32  twapWindow
    ) public view returns (uint256) {
        if (uniV3Factory == address(0) || weth == address(0) || inputToken == weth) {
            return fillAmount;
        }
        address pool = IUniswapV3Factory(uniV3Factory).getPool(inputToken, weth, feeTier);
        require(pool != address(0), "no twap pool");

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives, ) = IUniswapV3PoolOracle(pool).observe(secondsAgos);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int24 meanTick = int24(delta / int56(uint56(twapWindow)));
        // round toward negative infinity (matches Uniswap's OracleLibrary)
        if (delta < 0 && (delta % int56(uint56(twapWindow)) != 0)) meanTick--;

        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(meanTick);
        return _quoteWeth(sqrtPriceX96, fillAmount, inputToken, weth);
    }

    /// WETH amount for `amountIn` of `inputToken` at the given sqrt price.
    /// Mirrors Uniswap OracleLibrary.getQuoteAtTick.
    function _quoteWeth(
        uint160 sqrtPriceX96,
        uint256 amountIn,
        address inputToken,
        address weth
    ) private pure returns (uint256 quote) {
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            quote = inputToken < weth
                ? FullMath.mulDiv(ratioX192, amountIn, 1 << 192)
                : FullMath.mulDiv(1 << 192, amountIn, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 64);
            quote = inputToken < weth
                ? FullMath.mulDiv(ratioX128, amountIn, 1 << 128)
                : FullMath.mulDiv(1 << 128, amountIn, ratioX128);
        }
    }

    /// Registration-time collateral: notionalEth(ceiling, in ETH wei) x
    /// collateralRate[orderSizeBucket] x timeMultiplier. No fill-ratio
    /// dimension - linear in the notional, so a larger ceiling is never
    /// cheaper than a smaller one (no "ceiling-shopping" discount).
    ///
    /// D-1: the input is now an ETH-denominated notional (see toEthNotional),
    /// so the stake is dimensionally consistent with the ETH it is paid in,
    /// for any input token — not just WETH.
    function computeCollateral(
        uint256 notionalEth,
        uint256 deadline,
        StakeConfig storage cfg
    ) public view returns (uint256) {
        uint8 sBucket = getOrderSizeBucketETH(notionalEth, cfg.sizeThresholds);
        uint8 tBucket = getTimeBucket(deadline, cfg.timeThresholds);
        uint32 rateBps  = cfg.collateralRate[sBucket];
        uint32 timeMult = cfg.timeMult[tBucket];
        return
            FullMath.mulDiv(
                FullMath.mulDiv(notionalEth, rateBps, 10000),
                timeMult,
                10000
            );
    }

    /// Trufy 3.1: `computeCollateral` with the absolute minCollateral floor
    /// applied. Shared by previewCollateral() and computeRegistration() so the
    /// floor logic lives in exactly one place.
    function requiredStake(
        StakeConfig storage cfg,
        uint256 notionalEth,
        uint256 deadline
    ) public view returns (uint256 required) {
        required = computeCollateral(notionalEth, deadline, cfg);
        if (required < cfg.minCollateral) required = cfg.minCollateral;
    }

    /// B2/#3: bundles what FillAuction.register() needs from `cfg` in one call —
    /// the required stake (with the Trufy 3.1 minCollateral floor applied) and
    /// the refund-row/ratio-threshold SNAPSHOT for this order's size bucket, so
    /// a later reshape of the live config can't affect this registration's
    /// eventual settlement (see computeRefund). Moved here (out of
    /// FillAuction.register) for the same bytecode-size reason as
    /// validate/guardCheck above.
    function computeRegistration(
        StakeConfig storage cfg,
        uint256 notionalEth,
        uint256 deadline
    ) public view returns (uint256 required, uint32[] memory refundRow, uint256[] memory ratioSnapshot) {
        required = requiredStake(cfg, notionalEth, deadline);

        uint8 sBucket = getOrderSizeBucketETH(notionalEth, cfg.sizeThresholds);
        uint256 R = cfg.ratioThresholds.length + 1;
        refundRow = new uint32[](R);
        for (uint256 i = 0; i < R; i++) {
            refundRow[i] = cfg.refundTable[sBucket * R + i];
        }
        ratioSnapshot = cfg.ratioThresholds;
    }

    /// B4/D1: memory-argument twin of computeCollateral() above (kept as a
    /// distinct name, not an overload — Solidity's overload resolution cannot
    /// reliably disambiguate a `storage` vs. `memory` struct parameter at the
    /// call site). Needed so the setStakeConfig guard can evaluate a CANDIDATE
    /// config that isn't installed in storage yet (see
    /// FillAuction._guardCheck's output-sampling comparison of old vs. new).
    function computeCollateralMemory(
        uint256 notionalEth,
        uint256 deadline,
        StakeConfig memory cfg
    ) public view returns (uint256) {
        uint8 sBucket = getOrderSizeBucketETH(notionalEth, cfg.sizeThresholds);
        uint8 tBucket = getTimeBucket(deadline, cfg.timeThresholds);
        uint32 rateBps  = cfg.collateralRate[sBucket];
        uint32 timeMult = cfg.timeMult[tBucket];
        return
            FullMath.mulDiv(
                FullMath.mulDiv(notionalEth, rateBps, 10000),
                timeMult,
                10000
            );
    }

    /// B4/D1: the refund fraction (bps of stake) a HYPOTHETICAL registration at
    /// `notionalEth` would get back for delivering `fillBps` (bps, 0-10000) of
    /// its own commitment, under `cfg`. Used only by the setStakeConfig guard's
    /// output-sampling grid — never by register()/onFillSuccess(), which always
    /// use a real Registration's snapshot.
    function refundFracBpsAt(
        StakeConfig memory cfg,
        uint256 notionalEth,
        uint256 fillBps
    ) public pure returns (uint32) {
        uint8 sBucket = getOrderSizeBucketETH(notionalEth, cfg.sizeThresholds);
        uint8 rBucket = getFillRatioBucket(fillBps, 10000, cfg.ratioThresholds);
        uint256 R = cfg.ratioThresholds.length + 1;
        return cfg.refundTable[sBucket * R + rBucket];
    }

    /// Settlement-time refund: stakeAmount x refundRow[fillRatioBucket(...)].
    /// D-2: the ratio is the fraction of the filler's OWN commitment delivered,
    /// not the fraction of the whole order.
    ///
    /// M-2 / #3 (dynamic-bucket danger): both `refundRow` AND `ratioThresholds`
    /// must be the SNAPSHOT taken at register time (Registration.refundRow /
    /// .ratioSnapshot), never the live `_config`. A registration's refund is
    /// then self-consistent no matter how many times the owner reshapes the
    /// live config afterwards (see FillAuction.register / onFillSuccess).
    function computeRefund(
        uint256 stakeAmount,
        uint256 actualFillAmount,
        uint256 committedFill,
        uint32[] memory refundRow,
        uint256[] memory ratioThresholds
    ) public pure returns (uint256) {
        uint8 rBucket = getFillRatioBucket(actualFillAmount, committedFill, ratioThresholds);
        uint32 refundBps = refundRow[rBucket];
        return FullMath.mulDiv(stakeAmount, refundBps, 10000);
    }

    /// B3: the 7 required invariants a candidate StakeConfig must satisfy
    /// before it can be installed (see DYNAMIC_STAKE_CONFIG_REFACTOR.md §2 for
    /// the original write-up). Moved here from FillAuction purely to keep
    /// FillAuction's own deployed bytecode under EIP-170's 24,576-byte limit
    /// (see also computeCollateralMemory / guardCheck below) — the logic
    /// itself is unchanged from the original design.
    function validate(
        StakeConfig calldata c,
        uint32 minCollateralRate,
        uint32 maxCollateralRate,
        uint32 maxRefundBps,
        uint256 maxBuckets
    ) public pure {
        uint256 S = c.collateralRate.length;
        uint256 T = c.timeMult.length;
        uint256 R = c.ratioThresholds.length + 1;

        // Invariants 1-3 (rectangular shape): each threshold array must have
        // exactly one fewer entry than the bucket-count it defines, and the
        // (flattened) refund table must be exactly S*R long — otherwise a
        // bucket lookup could index out of bounds or read another row's data.
        require(S == c.sizeThresholds.length + 1, "bad size shape");
        require(T == c.timeThresholds.length + 1, "bad time shape");
        require(c.refundTable.length == S * R,     "bad refund shape");

        // Invariant 7 (bounded bucket counts): caps every bucket count so a
        // config can never blow up register()/onFillSuccess() gas (or storage)
        // via an unbounded array — this is the DoS guard for the "PARAM_ADMIN
        // can resize the table" feature itself.
        require(S >= 1 && S <= maxBuckets, "bad size bucket count");
        require(T >= 1 && T <= maxBuckets, "bad time bucket count");
        require(R >= 1 && R <= maxBuckets, "bad ratio bucket count");

        // Invariant 4 (thresholds strictly ordered): size/ratio thresholds must
        // increase with bucket index (bigger order / higher fill % = higher
        // bucket); time thresholds are blocks-LEFT, so they must strictly
        // DECREASE with bucket index (less time left = higher/more urgent bucket).
        for (uint256 i = 1; i < c.sizeThresholds.length; i++) {
            require(c.sizeThresholds[i] > c.sizeThresholds[i - 1], "size thresholds not increasing");
        }
        for (uint256 i = 1; i < c.ratioThresholds.length; i++) {
            require(c.ratioThresholds[i] > c.ratioThresholds[i - 1], "ratio thresholds not increasing");
        }
        for (uint256 i = 1; i < c.timeThresholds.length; i++) {
            require(c.timeThresholds[i] < c.timeThresholds[i - 1], "time thresholds not decreasing");
        }

        // Invariant 5 (absolute collateral-rate bounds): a rate of 0 would make
        // registration free (griefing — see #1 in the legend), so every rate
        // must sit within [minCollateralRate, maxCollateralRate].
        for (uint256 i = 0; i < S; i++) {
            require(
                c.collateralRate[i] >= minCollateralRate && c.collateralRate[i] <= maxCollateralRate,
                "rate out of bounds"
            );
        }

        // Invariant 6 (refund rows well-formed): every refund row is
        // non-decreasing across its fill-ratio buckets and ends at exactly
        // 100% (maxRefundBps) — i.e. fully honouring your commitment always
        // returns the full stake, and delivering more never returns less.
        for (uint256 s = 0; s < S; s++) {
            uint32 prev = 0;
            for (uint256 r = 0; r < R; r++) {
                uint32 v = c.refundTable[s * R + r];
                require(v <= maxRefundBps, "refund > 100%");
                require(v >= prev,         "refund row not monotonic");
                prev = v;
            }
            require(prev == maxRefundBps, "refund row must end at 100%");
        }
    }

    /// D1: shape-independent comparison of `newCfg` against the live `oldCfgStorage`,
    /// at a fixed grid of reference points (notional x fill%) — comparing OUTPUT
    /// (collateral required, penalty forfeited) rather than raw array cells,
    /// which breaks once the two configs can have different bucket COUNTS.
    /// Enforces `maxDeltaBps` at every point and returns whether `newCfg` is a
    /// net loosening (weaker for the filler) at any point. Moved here from
    /// FillAuction for the same bytecode-size reason as `validate` above.
    ///
    /// Known limitation (documented, not fixed): the grid is discrete, so a
    /// pathological reshape could in principle hide a violation strictly
    /// between two sampled points. The grid is deliberately dense enough to
    /// cover the fill percentages that matter (1/5/20/50/100%) and a wide
    /// notional spread (0.5-500 ETH).
    function guardCheck(
        StakeConfig storage oldCfgStorage,
        StakeConfig memory newCfg,
        uint256 maxDeltaBps,
        uint256 minPenaltyBps,
        uint256 maxRefundBps
    ) public view returns (bool isLoosening) {
        uint256[4] memory sampleNotionals = [uint256(0.5 ether), 5 ether, 50 ether, 500 ether];
        uint256[5] memory sampleFillsBps  = [uint256(100), 500, 2000, 5000, 10000]; // 1/5/20/50/100%
        uint256 refDeadline = block.number + 10_000_000; // far beyond any timeThresholds -> fixed time bucket on both sides

        StakeConfig memory oldCfg = oldCfgStorage;

        for (uint256 i = 0; i < sampleNotionals.length; i++) {
            uint256 notional = sampleNotionals[i];

            uint256 collOld = computeCollateralMemory(notional, refDeadline, oldCfg);
            if (collOld < oldCfg.minCollateral) collOld = oldCfg.minCollateral;
            uint256 collNew = computeCollateralMemory(notional, refDeadline, newCfg);
            if (collNew < newCfg.minCollateral) collNew = newCfg.minCollateral;

            if (collNew < collOld) isLoosening = true;
            require(_withinMaxDelta(collNew, collOld, maxDeltaBps), "collateral delta too large");

            for (uint256 j = 0; j < sampleFillsBps.length; j++) {
                uint256 fillBps = sampleFillsBps[j];
                uint32 refundOldBps = refundFracBpsAt(oldCfg, notional, fillBps);
                uint32 refundNewBps = refundFracBpsAt(newCfg, notional, fillBps);

                uint256 penaltyOld = collOld * (maxRefundBps - refundOldBps) / maxRefundBps;
                uint256 penaltyNew = collNew * (maxRefundBps - refundNewBps) / maxRefundBps;

                if (penaltyNew < penaltyOld) isLoosening = true;
                require(_withinMaxDelta(penaltyNew, penaltyOld, maxDeltaBps), "penalty delta too large");

                // #2 (penalty floor): at the low, attacker-relevant fill points
                // only, the penalty itself (not just its DELTA from the old
                // value) must clear an absolute floor, so PARAM_ADMIN can't gut
                // the sniping fee even gradually, across many small individually
                // maxDelta-compliant changes (each step legal on its own, but
                // the cumulative drift would otherwise erode the fee to nothing).
                if (fillBps == 100 || fillBps == 500 || fillBps == 2000) {
                    require(
                        refundNewBps <= maxRefundBps - minPenaltyBps,
                        "penalty floor breached"
                    );
                }
            }
        }
    }

    function _withinMaxDelta(uint256 newV, uint256 oldV, uint256 maxDeltaBps) private pure returns (bool) {
        if (oldV == 0) return newV == 0; // both sides must agree at exactly zero
        uint256 diff = newV > oldV ? newV - oldV : oldV - newV;
        return diff * 10000 <= oldV * maxDeltaBps;
    }
}
