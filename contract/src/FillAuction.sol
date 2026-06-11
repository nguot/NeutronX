// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { DynamicStakeLib } from "./libs/DynamicStakeLib.sol";

import { IFillAuction } from "./interfaces/IFillAuction.sol";

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
    }

    uint256 public constant SLASH_WINDOW = 50;

    address public immutable treasury;
    address public immutable owner;
    address public reactor;

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

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyReactor() {
        require(msg.sender == reactor, "only reactor");
        _;
    }

    constructor(address _treasury) {
        require(_treasury != address(0), "zero treasury");
        treasury = _treasury;
        owner    = msg.sender;

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
        collateralRate[sBucket] = value;
    }

    function setRefundTable(uint8 sBucket, uint8 rBucket, uint32 value) external onlyOwner {
        refundTable[sBucket][rBucket] = value;
    }

    function register(
        address filler,
        bytes32 orderHash,
        uint256 fillAmount,
        uint256 orderTotal,
        uint256 deadline
    ) external payable onlyReactor nonReentrant {
        require(block.number < deadline,  "deadline passed");
        require(fillAmount > 0,           "zero fill");
        require(fillAmount <= orderTotal, "fill > total");
        require(
            _registrations[orderHash][filler].filler == address(0),
            "already registered"
        );

        uint256 required = DynamicStakeLib.computeCollateral(fillAmount, orderTotal, deadline, collateralRate);
        require(msg.value >= required, "insufficient stake");

        _registrations[orderHash][filler] = Registration({
            filler:       filler,
            // forge-lint: disable-next-line(unsafe-typecast)
            fillAmount:   uint128(fillAmount),
            // forge-lint: disable-next-line(unsafe-typecast)
            stakeAmount:  uint128(required),
            // forge-lint: disable-next-line(unsafe-typecast)
            orderTotal:   uint128(orderTotal),
            registeredAt: uint64(block.number),
            // forge-lint: disable-next-line(unsafe-typecast)
            deadline:     uint64(deadline),
            filled:       false,
            slashed:      false
        });

        uint256 excess = msg.value - required;
        if (excess > 0) pendingReturns[filler] += excess;

        emit Registered(filler, orderHash, fillAmount, required);
    }

    function slash(bytes32 orderHash, address filler) external nonReentrant {
        Registration storage reg = _registrations[orderHash][filler];
        require(reg.filler != address(0),    "not registered");
        require(!reg.filled && !reg.slashed, "invalid state");
        require(block.number > reg.deadline + SLASH_WINDOW, "too early");

        reg.slashed = true;
        uint256 stake      = reg.stakeAmount;
        uint256 reward     = stake / 10;
        uint256 toTreasury = stake - reward;

        pendingReturns[msg.sender] += reward;
        pendingReturns[treasury]   += toTreasury;

        emit Slashed(filler, orderHash, stake, msg.sender, reward);
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
        uint256 actualFillAmount
    ) external onlyReactor {
        Registration storage reg = _registrations[orderHash][filler];
        require(!reg.filled && !reg.slashed, "invalid state");
        reg.filled = true;

        uint256 stake     = reg.stakeAmount;
        uint256 refund    = DynamicStakeLib.computeRefund(stake, actualFillAmount, reg.orderTotal, refundTable);
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
            // forge-lint: disable-next-line(unsafe-typecast)
            reg.fillAmount >= uint128(fillAmount) &&
            block.number <= reg.deadline
        );
    }
}
