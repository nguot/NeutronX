// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { DynamicStakeLib } from "./libs/DynamicStakeLib.sol";

import { IFillAuction } from "./interfaces/IFillAuction.sol";
import { IEthNotionalOracle } from "./interfaces/IEthNotionalOracle.sol";

// ─────────────────────────────────────────────────────────────────────────
// COMMENT-CODE LEGEND — every short label cited below, spelled out once here
// so reading a comment never requires looking up an external report.
//
//   H-1  (High, audit.md)   Losing fillers used to forfeit their ENTIRE stake
//                           with no way back except being slashed. Fixed by
//                           releaseRegistration(): reclaim in full once the
//                           order is satisfied/cancelled through no fault of yours.
//   H-2  (High, audit.md)   A swapper could bait fillers into staking, then
//                           cancelOrder() to make an honest registration look
//                           "abandoned" and slashable. Fixed: slash() now
//                           requires the order NOT be cancelled.
//   M-2  (Medium, audit.md) The owner could rewrite collateralRate/refundTable
//                           AFTER a filler had already staked under the old
//                           numbers — retroactively changing the deal. Fixed by
//                           snapshotting the refund row into the Registration
//                           at register time (see #3 below for the sequel bug).
//   L-2  (Low, audit.md)    Missing bounds on uint128/uint160 casts and on the
//                           old per-cell setters could silently truncate or
//                           accept unreasonable values. Fixed with explicit
//                           range checks everywhere a value crosses a width.
//   D-1  (High, audit.md's own "D" series — NOT the same series as the D1-D4
//        design decisions futher down)
//                           The original collateral math treated the raw
//                           input-token AMOUNT as if it were the notional
//                           value, regardless of which token or its price/
//                           decimals — so a non-WETH order could require ≈0
//                           collateral. Fixed by pricing the notional through
//                           an ETH-denominated oracle (IEthNotionalOracle —
//                           see UniswapV3NotionalOracle for the default
//                           Uniswap V3 TWAP implementation).
//   D-2  (Medium, audit.md) The refund schedule measured "how much did they
//                           fill" as a fraction of the WHOLE order instead of
//                           the filler's OWN committed amount, so an honest
//                           partial filler could be penalised as if they'd
//                           under-delivered. Fixed by keying the refund ratio
//                           to actualFill ÷ committedFill.
//   Trufy 3.1 (external audit) Collateral-floor finding: a thin-liquidity TWAP
//                           window can be pushed down to undercut the quoted
//                           price, so the required stake needs an absolute
//                           wei floor (minCollateral) as a backstop no matter
//                           what the TWAP says.
//   Trufy 3.3 (external audit) If the swapper invalidates their Permit2 nonce,
//                           the order becomes permanently unfillable through
//                           no fault of the filler — must NOT be treated as a
//                           slashable abandonment, and the stake must still
//                           be reclaimable.
//   Trufy 3.5 (external audit) "Honest-filler forfeiture": a COMPETING filler
//                           could shrink the live remaining amount below what
//                           an honest registrant committed to; the old code
//                           then penalised the honest filler for "under-
//                           delivering" against volume that was never actually
//                           available. Fixed by capping the refund's
//                           denominator at min(commitment, remaining-at-fill).
//   Trufy 3.6 (external audit) Oracle-disabled mode (skip the TWAP, treat the
//                           raw amount as the ETH notional) must be an
//                           EXPLICIT deploy-time choice, never a silent
//                           fallback a misconfigured deploy could drift into.
//
//   B1-B6                   The 6 build phases of the dynamic-stake-config
//                           refactor (see DYNAMIC_STAKE_CONFIG_REFACTOR.md):
//                           B1 auth→AccessControl, B2 dynamic StakeConfig,
//                           B3 validate + atomic setter, B4 guard/timelock/
//                           rollback, B5 deploy script + ABI, B6 off-chain.
//   D1-D4  (no hyphen — B4's 4 design decisions, that doc's "🔑 D" section;
//           unrelated to the D-1/D-2 audit findings above)
//                           D1: compare configs by ECONOMIC OUTPUT at fixed
//                               sample points (not raw array cells), so the
//                               change-size guard still works even when the
//                               number of buckets itself changes.
//                           D2: always snapshot the OLD config right before
//                               installing a new one, so rollback() can only
//                               undo exactly one step, never more.
//                           D3: the cooldown timer starts on EITHER path
//                               (immediate apply OR queuing a pending change),
//                               and only one pending change may exist at a
//                               time — otherwise repeated small "loosening"
//                               edits could slip past the cooldown one at a time.
//                           D4: four smaller decisions bundled together —
//                               reject a new change while one is pending;
//                               rollback() clears any pending change;
//                               setReactor keeps requiring DEFAULT_ADMIN_ROLE
//                               (it's structural wiring, not economics); and
//                               minCollateral is folded into StakeConfig
//                               instead of having its own separate setter.
//   #1/#2/#3                The 3 risk items from that doc's risk-analysis
//                           section (§4):
//                           #1: an over-permissive setter could re-open old
//                               vulnerabilities (e.g. collateralRate=0 makes
//                               registration free).
//                           #2: PARAM_ADMIN could reshape the ratio buckets to
//                               gut the "sniping fee" penalty at exactly the
//                               fill percentages that matter, even while each
//                               individual change stays within its allowed
//                               delta — hence the separate absolute penalty
//                               floor (MIN_PENALTY_BPS).
//                           #3: the "dynamic-bucket danger" — if the NUMBER of
//                               ratio buckets changes between when a filler
//                               registers and when they get filled, computing
//                               their bucket against the LIVE (reshaped)
//                               config could read the wrong column entirely.
//                               Settlement must always use the snapshot taken
//                               at register time.
// ─────────────────────────────────────────────────────────────────────────

/// Minimal view into the reactor so the auction can tell whether an order was
/// satisfied / cancelled (stake reclaimable) vs. genuinely left unfilled (slashable).
interface IReactorView {
    function remainingInput(bytes32 orderHash, uint256 orderAmount) external view returns (uint256);
    function isCancelled(bytes32 orderHash) external view returns (bool);
    function isNonceInvalidatedForOrder(bytes32 orderHash) external view returns (bool);
}

contract FillAuction is IFillAuction, ReentrancyGuard, AccessControl {

    struct Registration {
        address filler;
        uint128 fillAmount;
        uint128 stakeAmount;
        uint128 orderTotal;
        uint64  registeredAt;
        uint64  deadline;
        bool    filled;
        bool    slashed;
        bool    released;         // H-1: stake returned because order satisfied/cancelled
        uint32[]  refundRow;      // M-2: refund schedule snapshotted at register time (len = R)
        uint256[] ratioSnapshot;  // #3: ratioThresholds snapshotted at register time (len = R-1) —
                                  // settlement buckets against THIS, never the live _config, so a
                                  // later reshape of the ratio-bucket count cannot break or shift an
                                  // already-registered filler's refund row.
    } 

    uint256 public constant SLASH_WINDOW = 50;

    uint32 public constant MAX_COLLATERAL_RATE = 1_000_000; // 10,000% ceiling (L-2)
    uint32 public constant MAX_REFUND_BPS      = 10_000;    // 100% ceiling   (L-2)
    // B3: absolute collateral-rate floor. Without it, PARAM_ADMIN could set a
    // bucket's rate to 0 -> free registration -> griefing (#1 in the refactor doc).
    // 100 bps (1%) is a conservative non-zero floor well below every default rate.
    uint32 public constant MIN_COLLATERAL_RATE = 100;
    // B3: cap on any StakeConfig array length (S, T, or R buckets), so PARAM_ADMIN
    // cannot blow up register()/onFillSuccess() gas (or storage cost) by installing
    // an arbitrarily large bucket table.
    uint256 public constant MAX_BUCKETS = 16;

    // B4/D1: max relative move (bps of the OLD value) allowed per setStakeConfig
    // call, checked at every point of the output-sampling grid (see _guardCheck).
    // Bounds both the collateral required and the penalty forfeited, in either
    // direction — this is what makes a single call unable to swing the economics
    // by more than 20%, forcing gradual (and hence cooldown/pending-visible) change.
    uint256 public constant MAX_DELTA_BPS = 2000; // 20%
    // B4/D3: minimum spacing between the START of any two changes (both the
    // immediate-apply/tighten path and queuing a new pending loosening) — the
    // anti-salami guard. Without gating the loosening path too, PARAM_ADMIN could
    // requeue an ever-more-aggressive `_pending` every block with no cooldown.
    uint256 public constant CHANGE_COOLDOWN = 1 days;
    // B4: a config that is a net LOOSENING (see _guardCheck) is queued as
    // `_pending` and only takes effect after this delay — asymmetric friction:
    // tightening (safer) applies immediately, loosening (riskier) does not.
    uint256 public constant LOOSEN_DELAY = 7 days;
    // B4/D1: floor on the penalty (bps of collateral forfeited) sampled at the
    // low, attacker-relevant fill points (1%/5%/20%) and at every non-honest
    // ratio-bucket edge — stops PARAM_ADMIN from reshaping the ratio buckets
    // to gut the "sniping fee" at exactly the fill ratios a griefer would
    // pick, without touching the raw MAX_REFUND_BPS bound.
    uint256 public constant MIN_PENALTY_BPS = 500; // 5%
    // Direct floor on the config's actual worst-case economics (see
    // DynamicStakeLib.worstCaseKappaBps): the minimum price edge a filler
    // would need, on the fill% that actually maximises a snipe's profit, for
    // ANY partial-fill-then-abandon strategy to turn a profit under this
    // config. Deliberately a single check on the COMBINED (rate x time x
    // penalty) economics rather than raising MIN_COLLATERAL_RATE or
    // MIN_PENALTY_BPS individually — those would each have to climb much
    // higher (and fight with wanting low per-field floors for flexibility) to
    // reach the same guarantee, since the three multiply together. Also
    // closes two gaps neither field-level floor reaches: timeMult has no
    // floor of its own (this catches it via the same formula), and a config
    // with zero non-honest ratio buckets (R==1) correctly reads as 0 here
    // (rejected), since it offers no deterrent at all.
    uint256 public constant MIN_WORST_CASE_KAPPA_BPS = 1000; // 10%

    // B1: AccessControl replaces the single `owner`. DEFAULT_ADMIN_ROLE (from
    // AccessControl) grants/revokes the roles below and wires the one-time
    // reactor address (D4); PARAM_ADMIN_ROLE calls setStakeConfig (B3/B4);
    // GUARDIAN_ROLE and KEEPER_ROLE are wired for the B4/B6 guard + keeper work.
    bytes32 public constant PARAM_ADMIN_ROLE = keccak256("PARAM_ADMIN_ROLE");
    bytes32 public constant GUARDIAN_ROLE    = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE      = keccak256("KEEPER_ROLE");

    address public immutable treasury;
    address public reactor;

    // D-1: ETH-denominated collateral oracle. Pluggable — any implementation
    // of IEthNotionalOracle works (see UniswapV3NotionalOracle for the default
    // Uniswap V3 TWAP one). If `oracle` is the zero address the oracle is
    // disabled (raw amount treated as notional) — intended only for
    // local/mock environments or chains without a compatible DEX.
    IEthNotionalOracle public immutable oracle;

    // Trufy 3.6: oracle-disabled mode (raw amount treated as ETH notional) must
    // be chosen EXPLICITLY at deploy time via this flag. When false, the
    // constructor rejects a zero oracle config, so a production deployment can
    // never SILENTLY fall back to mispriced raw units through a misconfiguration.
    bool public immutable oracleDisabled;

    // B2: bucket boundaries + rates/multipliers/refund table + the collateral
    // floor (Trufy 3.1, folded in at B4/D4 — see StakeConfig.minCollateral), as
    // a single dynamically-sized config (was fixed uint32[4]/uint32[5][4]
    // arrays plus a standalone `minCollateral` before the refactor). See
    // DynamicStakeLib.StakeConfig for the field layout and `_validate` for the
    // invariants a new config must satisfy. Kept private because Solidity's
    // auto-getter for a struct silently drops dynamic-array members;
    // `stakeConfig()` below is the real read path.
    DynamicStakeLib.StakeConfig private _config;

    // B4/D2: the config `_config` replaced at the last _apply() — the ONE step
    // `rollback()` can undo (see rollback() for why this is "one-deep").
    DynamicStakeLib.StakeConfig private _previousConfig;
    // B4: a queued net-loosening config, or the zero-value StakeConfig (all
    // arrays empty) as the "no pending" sentinel — a validated config always has
    // collateralRate.length >= 1 (bullet 7 of _validate), so length == 0 can
    // only mean "nothing queued". Avoids a separate bool storage slot.
    DynamicStakeLib.StakeConfig private _pending;
    uint256 public pendingEffective;
    // B4/D3: timestamp of the last change INITIATED (either applied immediately
    // or queued as pending) — gates CHANGE_COOLDOWN on both paths.
    uint256 public lastChange;

    mapping(bytes32 => mapping(address => Registration)) private _registrations;
    mapping(address => uint256) public pendingReturns;

    event Registered(address indexed filler, bytes32 indexed orderHash, uint256 fillAmount, uint256 stake);
    event Slashed(address indexed filler, bytes32 indexed orderHash, uint256 stake, address caller, uint256 reward);
    event StakeReturned(address indexed filler, bytes32 indexed orderHash, uint256 refund);
    event StakeForfeited(address indexed filler, bytes32 indexed orderHash, uint256 amount);
    event StakeReleased(address indexed filler, bytes32 indexed orderHash, uint256 amount);
    // Slither (events-access / events-maths): emit on critical admin state changes so
    // off-chain watchers/indexers can track the one-time reactor wiring and the
    // collateral-floor parameter without polling.
    event ReactorSet(address indexed reactor);
    // B3/B4: emitted whenever the live StakeConfig changes (immediately, or via
    // a pending config being committed); off-chain indexers (B6) read
    // `stakeConfig()` afresh on this event rather than decoding the dynamic
    // arrays out of the log itself.
    event StakeConfigUpdated();
    event PendingConfigQueued(uint256 effectiveAt);
    event PendingConfigCancelled();
    event ConfigRollback();

    // B4: custom errors (not require-strings) for the setStakeConfig state
    // machine — cheaper in deployed bytecode than the equivalent ABI-encoded
    // string reverts, and this file was already at the EIP-170 boundary.
    error Cooldown();
    error PendingExists();
    error NoPending();
    error StillPending();
    error NoPreviousConfig();

    modifier onlyReactor() {
        require(msg.sender == reactor, "only reactor");
        _;
    }

    constructor(address _treasury, IEthNotionalOracle _oracle, bool _oracleDisabled) {
        require(_treasury != address(0), "zero treasury");
        // Trufy 3.6: fail closed on a half/zero oracle config unless oracle-disabled
        // mode was deliberately requested — must be an intentional choice, not
        // a misconfigured deploy silently falling back to mispriced raw units.
        if (_oracleDisabled) {
            require(address(_oracle) == address(0), "disabled needs zero oracle");
        } else {
            require(address(_oracle) != address(0), "zero oracle");
        }
        treasury       = _treasury;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        oracle         = _oracle;
        oracleDisabled = _oracleDisabled;

        // B2: seed with the pre-refactor fixed-array defaults (4 size buckets x
        // 5 fill-ratio buckets), just expressed as dynamic arrays. Same numbers
        // as the original design so behaviour is unchanged until PARAM_ADMIN
        // calls setStakeConfig. Table-building lives in the library (not here)
        // to keep this constructor-only code out of FillAuction's own bytecode.
        _config = DynamicStakeLib.defaultStakeConfig();
    }

    // D4: one-time structural wiring, gated by DEFAULT_ADMIN_ROLE (not
    // PARAM_ADMIN_ROLE) since it is not a stake-economics parameter.
    function setReactor(address _reactor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(reactor  == address(0), "already set");
        require(_reactor != address(0), "zero reactor");
        reactor = _reactor;
        emit ReactorSet(_reactor);
    }

    // B3/B4: single atomic setter replacing setCollateralRate/setRefundTable —
    // can change both the VALUES and the NUMBER OF BUCKETS in one transaction,
    // with no intermediate (partially-updated) state. `_validate` re-checks
    // every SHAPE/bound invariant from scratch; `_guardCheck` then compares the
    // candidate's ECONOMIC OUTPUT against the live config (D1) and gates the
    // change behind cooldown + (for a net loosening) a pending delay (D3).
    function setStakeConfig(DynamicStakeLib.StakeConfig calldata c) external onlyRole(PARAM_ADMIN_ROLE) {
        // lastChange == 0 is the "no change yet" sentinel (real timestamps are
        // always > 0), so the very first call isn't blocked by a cooldown
        // measured from a change that never happened.
        if (lastChange != 0 && block.timestamp < lastChange + CHANGE_COOLDOWN) revert Cooldown(); // D3
        if (_pending.collateralRate.length != 0) revert PendingExists();           // D3: only one at a time
        // also enforces the direct worst-case-kappa floor (Invariant 8)
        DynamicStakeLib.validate(c, MIN_COLLATERAL_RATE, MAX_COLLATERAL_RATE, MAX_REFUND_BPS, MAX_BUCKETS, MIN_WORST_CASE_KAPPA_BPS);
        // also enforces MAX_DELTA_BPS (D1)
        bool loosening = DynamicStakeLib.guardCheck(_config, c, MAX_DELTA_BPS, MIN_PENALTY_BPS, MAX_REFUND_BPS);

        if (loosening) {
            _pending = c;
            pendingEffective = block.timestamp + LOOSEN_DELAY;
            lastChange = block.timestamp; // D3: gate the loosening path too
            emit PendingConfigQueued(pendingEffective);
        } else {
            _apply(c);
        }
    }

    /// D2: the ONLY place `_config` is overwritten with a new live value (both
    /// the immediate-tighten path and a committed pending loosening route
    /// through here), so `_previousConfig` always holds exactly the config that
    /// was replaced — the invariant `rollback()` depends on for "one-deep".
    function _apply(DynamicStakeLib.StakeConfig memory cfg) private {
        _previousConfig = _config;
        _config = cfg;
        lastChange = block.timestamp;
        emit StakeConfigUpdated();
    }

    /// Commit a queued pending (loosening) config once its delay has elapsed.
    /// Permissionless — anyone can trigger it once the wait is over.
    function commitPending() external {
        if (_pending.collateralRate.length == 0) revert NoPending();
        if (block.timestamp < pendingEffective) revert StillPending();
        DynamicStakeLib.StakeConfig memory p = _pending;
        delete _pending;
        _apply(p);
    }

    /// D4: guardian veto on a not-yet-effective loosening.
    function cancelPendingConfig() external onlyRole(GUARDIAN_ROLE) {
        if (_pending.collateralRate.length == 0) revert NoPending();
        delete _pending;
        emit PendingConfigCancelled();
    }

    /// C.1/C.2/D4: emergency brake — restores the config `_apply` last replaced.
    /// Deliberately ONE-DEEP (assigns from `_previousConfig` without touching
    /// it), so calling this twice in a row is a no-op, not a walk further back
    /// through history: letting guardian pick an arbitrary past config would
    /// make guardian == param-admin and collapse the role separation this
    /// refactor's whole auth model rests on. Exempt from cooldown/maxDelta (it
    /// is the designated large jump to undo a mistake) but `_previousConfig`
    /// was itself `_validate`d + guard-checked when it was installed, so the
    /// absolute invariants (C.2) are already satisfied without re-checking.
    function rollback() external onlyRole(GUARDIAN_ROLE) {
        if (_previousConfig.collateralRate.length == 0) revert NoPreviousConfig();
        _config = _previousConfig;
        delete _pending; // D4: an in-flight loosening no longer makes sense against the restored config
        emit ConfigRollback();
    }

    /// The currently-queued pending config, if any (see `_pending`'s "length ==
    /// 0 means none" convention above).
    function pendingConfig() external view returns (DynamicStakeLib.StakeConfig memory) {
        return _pending;
    }

    /// Full current config (dynamic arrays are dropped by Solidity's automatic
    /// struct getter, so this explicit view is the real read path — see B6 indexer).
    function stakeConfig() external view returns (DynamicStakeLib.StakeConfig memory) {
        return _config;
    }

    /// D-1: exact ETH collateral a filler must stake for `fillAmount` of an order
    /// with this `inputToken`/`feeTier`/`deadline`. Off-chain clients call this
    /// instead of re-deriving the TWAP, then send it as msg.value to reactor.register.
    function previewCollateral(
        address inputToken,
        uint24  feeTier,
        uint256 fillAmount,
        uint256 deadline
    ) external view returns (uint256) {
        uint256 notionalEth = _notionalEth(inputToken, feeTier, fillAmount);
        return DynamicStakeLib.requiredStake(_config, notionalEth, deadline); // Trufy 3.1 floor applied inside
    }

    /// D-1: `fillAmount` of `inputToken` valued in ETH wei, via the pluggable
    /// oracle — or the raw amount unchanged when oracle-disabled (test/mock
    /// mode, or a chain with no compatible price source, chosen explicitly at
    /// deploy time — see the constructor's Trufy 3.6 check).
    function _notionalEth(address inputToken, uint24 feeTier, uint256 fillAmount) private view returns (uint256) {
        if (address(oracle) == address(0)) return fillAmount;
        return oracle.quoteEthNotional(inputToken, fillAmount, feeTier);
    }

    function register(
        address filler,
        bytes32 orderHash,
        uint256 fillAmount,
        uint256 orderTotal,
        uint256 deadline,
        address inputToken,
        uint24  feeTier
    ) external payable onlyReactor nonReentrant {
        require(block.number < deadline,  "deadline passed");
        require(fillAmount > 0,           "zero fill");
        require(fillAmount <= orderTotal, "fill > total");
        require(
            _registrations[orderHash][filler].filler == address(0),
            "already registered"
        );
        // L-2: reject values that would truncate when cast to the uint128 fields.
        require(fillAmount <= type(uint128).max, "fill too large");
        require(orderTotal <= type(uint128).max, "total too large");

        // D-1: size the stake off the fill's ETH-denominated notional.
        uint256 notionalEth = _notionalEth(inputToken, feeTier, fillAmount);
        // M-2 / #3: `refundRow`/`ratioSnapshot` are this order's SNAPSHOT of the
        // refund schedule — settlement must bucket against these, never the live
        // _config (see DynamicStakeLib.computeRefund).
        (uint256 required, uint32[] memory refundRow, uint256[] memory ratioSnapshot) =
            DynamicStakeLib.computeRegistration(_config, notionalEth, deadline);
        require(msg.value >= required,           "insufficient stake");
        require(required  <= type(uint128).max,  "stake too large");

        Registration storage reg = _registrations[orderHash][filler];
        reg.filler       = filler;
        // forge-lint: disable-next-line(unsafe-typecast)
        reg.fillAmount   = uint128(fillAmount);
        // forge-lint: disable-next-line(unsafe-typecast)
        reg.stakeAmount  = uint128(required);
        // forge-lint: disable-next-line(unsafe-typecast)
        reg.orderTotal   = uint128(orderTotal);
        reg.registeredAt = uint64(block.number);
        // forge-lint: disable-next-line(unsafe-typecast)
        reg.deadline     = uint64(deadline);
        reg.refundRow     = refundRow;
        reg.ratioSnapshot = ratioSnapshot;

        uint256 excess = msg.value - required;
        if (excess > 0) pendingReturns[filler] += excess;

        emit Registered(filler, orderHash, fillAmount, required);
    }

    /// H-1 / H-2: slash only when the filler genuinely abandoned committed
    /// volume — i.e. the order still has unfilled remaining and was NOT cancelled.
    /// A filler who simply lost the fill race (remaining == 0) or whose order was
    /// cancelled is not at fault; they reclaim their stake via releaseRegistration.
    function slash(bytes32 orderHash, address filler) external nonReentrant {
        Registration storage reg = _registrations[orderHash][filler];
        require(reg.filler != address(0),                 "not registered");
        require(!reg.filled && !reg.slashed && !reg.released, "invalid state");
        require(block.number > reg.deadline + SLASH_WINDOW, "too early");
        require(!IReactorView(reactor).isCancelled(orderHash), "cancelled");                         // H-2
        // Trufy 3.3: a swapper who invalidated the order's nonce made it terminally
        // unfillable through no fault of the filler — not a slashable abandonment.
        require(!IReactorView(reactor).isNonceInvalidatedForOrder(orderHash), "nonce invalidated");
        require(IReactorView(reactor).remainingInput(orderHash, reg.orderTotal) > 0, "order satisfied"); // H-1

        reg.slashed = true;
        uint256 stake      = reg.stakeAmount;
        uint256 reward     = stake / 10;
        uint256 toTreasury = stake - reward;

        pendingReturns[msg.sender] += reward;
        pendingReturns[treasury]   += toTreasury;

        emit Slashed(filler, orderHash, stake, msg.sender, reward);
    }

    /// H-1 / H-2: return a registrant's full stake once the order can no longer be
    /// filled by them through no fault of their own — it was either fully satisfied
    /// (by another filler / the fallback) or cancelled by the swapper. Permissionless;
    /// funds always go to the registrant, never the caller.
    function releaseRegistration(bytes32 orderHash, address filler) external nonReentrant {
        Registration storage reg = _registrations[orderHash][filler];
        require(reg.filler != address(0),                    "not registered");
        require(!reg.filled && !reg.slashed && !reg.released, "invalid state");

        bool satisfied   = IReactorView(reactor).remainingInput(orderHash, reg.orderTotal) == 0;
        bool cancelled   = IReactorView(reactor).isCancelled(orderHash);
        // Trufy 3.3: nonce invalidation is terminal too — the order can never be
        // filled again, so the stranded stake must be reclaimable.
        bool invalidated = IReactorView(reactor).isNonceInvalidatedForOrder(orderHash);
        require(satisfied || cancelled || invalidated, "still fillable");

        reg.released = true;
        pendingReturns[reg.filler] += reg.stakeAmount;
        emit StakeReleased(reg.filler, orderHash, reg.stakeAmount);
    }

    function withdraw(address payable to) external nonReentrant {
        require(to != address(0), "zero to");
        uint256 amount = pendingReturns[msg.sender];
        require(amount > 0, "nothing to withdraw");
        pendingReturns[msg.sender] = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function onFillSuccess(
        bytes32 orderHash,
        address filler,
        uint256 actualFillAmount,
        uint256 remainingAtFill
    ) external onlyReactor {
        Registration storage reg = _registrations[orderHash][filler];
        require(!reg.filled && !reg.slashed && !reg.released, "invalid state");
        reg.filled = true;

        uint256 stake     = reg.stakeAmount;
        // M-2: refund off the snapshotted row, not the (mutable) live table.
        // D-2: key the refund to the filler's OWN commitment (reg.fillAmount), not
        // the whole order — so honouring your commitment (any size) returns the full
        // stake, and only under-delivering vs. what you promised is penalised.
        // Fragmentation is controlled separately by the order's minFillBps.
        //
        // Trufy 3.5: a competing filler can shrink the live remainder BELOW this
        // registrant's commitment, so the most they could possibly have filled is
        // `remainingAtFill`, not `reg.fillAmount`. Penalising against the full
        // commitment would then forfeit stake for volume that was never available
        // to them. Cap the refund denominator at what was actually fillable —
        // min(commitment, remaining-at-fill) — so consuming the entire live
        // remainder always returns the full stake, while genuine under-delivery
        // (remainder >= commitment) is still penalised exactly as before.
        uint256 deliverable = remainingAtFill < reg.fillAmount ? remainingAtFill : reg.fillAmount;
        // #3: bucket against the snapshot taken at register time, not the live
        // (possibly reshaped since) _config.
        uint32[]  memory refundRowSnap  = reg.refundRow;
        uint256[] memory ratioThreshSnap = reg.ratioSnapshot;
        uint256 refund    = DynamicStakeLib.computeRefund(stake, actualFillAmount, deliverable, refundRowSnap, ratioThreshSnap);
        uint256 forfeited = stake - refund;

        pendingReturns[filler] += refund;
        emit StakeReturned(filler, orderHash, refund);

        if (forfeited > 0) {
            pendingReturns[treasury] += forfeited;
            emit StakeForfeited(filler, orderHash, forfeited);
        }
    }

    function hasValidRegistration(
        bytes32 orderHash,
        address filler,
        uint256 fillAmount
    ) public view returns (bool) {
        Registration storage reg = _registrations[orderHash][filler];
        return (
            reg.filler == filler &&
            !reg.filled &&
            !reg.slashed &&
            !reg.released &&
            // forge-lint: disable-next-line(unsafe-typecast)
            reg.fillAmount >= uint128(fillAmount) &&
            block.number <= reg.deadline
        );
    }
}
