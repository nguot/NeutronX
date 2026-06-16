// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { DynamicStakeLib } from "./libs/DynamicStakeLib.sol";

import { IFillAuction } from "./interfaces/IFillAuction.sol";

/// Minimal view into the reactor so the auction can tell whether an order was
/// satisfied / cancelled (stake reclaimable) vs. genuinely left unfilled (slashable).
interface IReactorView {
    function remainingInput(bytes32 orderHash, uint256 orderAmount) external view returns (uint256);
    function isCancelled(bytes32 orderHash) external view returns (bool);
    function isNonceInvalidatedForOrder(bytes32 orderHash) external view returns (bool);
}

contract FillAuction is IFillAuction, ReentrancyGuard {

    struct Registration {
        address filler;
        uint128 fillAmount;
        uint128 stakeAmount;
        uint128 orderTotal;
        uint64  registeredAt;
        uint64  deadline;
        bool    filled;
        bool    slashed;
        bool    released;     // H-1: stake returned because order satisfied/cancelled
        uint32[5] refundRow;  // M-2: refund schedule snapshotted at register time
    }

    uint256 public constant SLASH_WINDOW = 50;

    uint32 public constant MAX_COLLATERAL_RATE = 1_000_000; // 10,000% ceiling (L-2)
    uint32 public constant MAX_REFUND_BPS      = 10_000;    // 100% ceiling   (L-2)

    address public immutable treasury;
    address public immutable owner;
    address public reactor;

    // D-1: ETH-denominated collateral oracle config. `weth` is the ETH wrapper
    // used as the value reference; `uniV3Factory` locates the (token, WETH) pool
    // for the TWAP; `twapWindow` is the look-back in seconds. If uniV3Factory is
    // the zero address the oracle is disabled (raw amount treated as notional) —
    // intended only for local/mock environments without a Uniswap deployment.
    address public immutable weth;
    address public immutable uniV3Factory;
    uint32  public immutable twapWindow;

    // Trufy 3.6: oracle-disabled mode (raw amount treated as ETH notional) must
    // be chosen EXPLICITLY at deploy time via this flag. When false, the
    // constructor rejects a zero oracle config, so a production deployment can
    // never SILENTLY fall back to mispriced raw units through a misconfiguration.
    bool public immutable oracleDisabled;

    // Trufy 3.1: absolute floor (in wei) on required collateral, owner-settable,
    // default 0. A short-horizon TWAP can be pushed down to undercut the stake;
    // this floor bounds the worst case so a manipulated quote cannot drive the
    // required stake to near-zero. Applied in register() and previewCollateral().
    uint256 public minCollateral;

    // collateralRate[orderSizeBucket], in bps of fillAmount(ceiling). Sizes
    // registration-time collateral. No fill-ratio dimension, so collateral
    // is linear in the registered ceiling - a larger ceiling is never
    // cheaper than a smaller one ("ceiling-shopping" is impossible).
    uint32[4] public collateralRate;

    // refundTable[orderSizeBucket][fillRatioBucket], in bps of stakeAmount
    // returned to the filler at onFillSuccess, indexed by the *actual* fill
    // ratio. Each row is non-decreasing and ends at 10000 (100%): filling a
    // small % of the order forfeits most of the collateral to the treasury
    // as a "sniping fee", filling >=70% returns it in full. See
    // test/libs/DynamicStakeLibStake.md.
    uint32[5][4] public refundTable;

    mapping(bytes32 => mapping(address => Registration)) private _registrations;
    mapping(address => uint256) public pendingReturns;

    event Registered(address indexed filler, bytes32 indexed orderHash, uint256 fillAmount, uint256 stake);
    event Slashed(address indexed filler, bytes32 indexed orderHash, uint256 stake, address caller, uint256 reward);
    event StakeReturned(address indexed filler, bytes32 indexed orderHash, uint256 refund);
    event StakeForfeited(address indexed filler, bytes32 indexed orderHash, uint256 amount);
    event StakeReleased(address indexed filler, bytes32 indexed orderHash, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyReactor() {
        require(msg.sender == reactor, "only reactor");
        _;
    }

    constructor(address _treasury, address _weth, address _uniV3Factory, uint32 _twapWindow, bool _oracleDisabled) {
        require(_treasury != address(0), "zero treasury");
        // Trufy 3.6: fail closed on a half/zero oracle config unless oracle-disabled
        // mode was deliberately requested. The TWAP path only runs when
        // uniV3Factory != 0 (see DynamicStakeLib), so that is the switch that must
        // be intentional.
        if (_oracleDisabled) {
            require(_uniV3Factory == address(0), "disabled needs zero factory");
        } else {
            require(_weth         != address(0), "zero weth");
            require(_uniV3Factory != address(0), "zero univ3 factory");
            require(_twapWindow    > 0,          "zero twap window");
        }
        treasury       = _treasury;
        owner          = msg.sender;
        weth           = _weth;
        uniV3Factory   = _uniV3Factory;
        twapWindow     = _twapWindow;
        oracleDisabled = _oracleDisabled;

        // Default collateralRate[orderSizeBucket], in bps of fillAmount.
        // Taken from the original 2D design's "10-30% fill" row - a
        // mid-range rate that still scales with order size only.
        collateralRate = [uint32(2000), 5000, 10000, 30000];

        // Default refundTable[orderSizeBucket][fillRatioBucket]: the
        // per-column-normalized reciprocal of the original 2D design (each
        // column divided by its own minimum, which always sits at
        // fillRatioBucket 4). Non-decreasing per row, every row ends at
        // 10000 (100%).
        uint32[5][4] memory defaultRefundTable = [
            [uint32(500), 1000, 2500, 5000, 10000],
            [uint32(333), 1000, 2000, 5000, 10000],
            [uint32(100),  333, 1000, 3333, 10000],
            [uint32(100),  200,  667, 2000, 10000]
        ];
        for (uint8 s = 0; s < 4; s++) {
            for (uint8 r = 0; r < 5; r++) {
                refundTable[s][r] = defaultRefundTable[s][r];
            }
        }
    }

    function setReactor(address _reactor) external onlyOwner {
        require(reactor  == address(0), "already set");
        require(_reactor != address(0), "zero reactor");
        reactor = _reactor;
    }

    function setCollateralRate(uint8 sBucket, uint32 value) external onlyOwner {
        require(sBucket < 4,                  "bad bucket");      // L-2
        require(value <= MAX_COLLATERAL_RATE, "rate too high");   // L-2
        collateralRate[sBucket] = value;
    }

    function setRefundTable(uint8 sBucket, uint8 rBucket, uint32 value) external onlyOwner {
        require(sBucket < 4 && rBucket < 5, "bad bucket");        // L-2
        require(value <= MAX_REFUND_BPS,    "refund > 100%");     // L-2
        refundTable[sBucket][rBucket] = value;
    }

    // Trufy 3.1: set the absolute collateral floor (wei). Owner-only.
    function setMinCollateral(uint256 value) external onlyOwner {
        minCollateral = value;
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
        uint256 notionalEth = DynamicStakeLib.toEthNotional(
            fillAmount, inputToken, feeTier, weth, uniV3Factory, twapWindow
        );
        uint256 required = DynamicStakeLib.computeCollateral(notionalEth, deadline, collateralRate);
        return required < minCollateral ? minCollateral : required;   // Trufy 3.1 floor
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
        uint256 notionalEth = DynamicStakeLib.toEthNotional(
            fillAmount, inputToken, feeTier, weth, uniV3Factory, twapWindow
        );
        uint256 required = DynamicStakeLib.computeCollateral(notionalEth, deadline, collateralRate);
        if (required < minCollateral) required = minCollateral;   // Trufy 3.1: absolute floor
        require(msg.value >= required,           "insufficient stake");
        require(required  <= type(uint128).max,  "stake too large");

        uint8 sBucket = DynamicStakeLib.getOrderSizeBucketETH(notionalEth);

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
        // M-2: snapshot the refund schedule for this order's size bucket.
        for (uint8 i = 0; i < 5; i++) {
            reg.refundRow[i] = refundTable[sBucket][i];
        }

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
        // 3.3: a swapper who invalidated the order's nonce made it terminally
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
        // 3.3: nonce invalidation is terminal too — the order can never be
        // filled again, so the stranded stake must be reclaimable.
        bool invalidated = IReactorView(reactor).isNonceInvalidatedForOrder(orderHash);
        require(satisfied || cancelled || invalidated, "still fillable");

        reg.released = true;
        pendingReturns[reg.filler] += reg.stakeAmount;
        emit StakeReleased(reg.filler, orderHash, reg.stakeAmount);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingReturns[msg.sender];
        require(amount > 0, "nothing to withdraw");
        pendingReturns[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
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
        // 3.5: a competing filler can shrink the live remainder BELOW this
        // registrant's commitment, so the most they could possibly have filled is
        // `remainingAtFill`, not `reg.fillAmount`. Penalising against the full
        // commitment would then forfeit stake for volume that was never available
        // to them. Cap the refund denominator at what was actually fillable —
        // min(commitment, remaining-at-fill) — so consuming the entire live
        // remainder always returns the full stake, while genuine under-delivery
        // (remainder >= commitment) is still penalised exactly as before.
        uint256 deliverable = remainingAtFill < reg.fillAmount ? remainingAtFill : reg.fillAmount;
        uint256 refund    = DynamicStakeLib.computeRefund(stake, actualFillAmount, deliverable, reg.refundRow);
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
