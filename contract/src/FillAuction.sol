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
        uint64  registeredAt;
        uint64  deadline;
        bool    filled;
        bool    slashed;
    }

    uint256 public constant SLASH_WINDOW = 50;

    address public immutable treasury;
    address public immutable owner;
    address public reactor;

    uint32[5][4] public stakeTable;

    mapping(bytes32 => mapping(address => Registration)) private _registrations;
    mapping(address => uint256) public pendingReturns;

    event Registered(address indexed filler, bytes32 indexed orderHash, uint256 fillAmount, uint256 stake);
    event Slashed(address indexed filler, bytes32 indexed orderHash, uint256 stake, address caller, uint256 reward);
    event StakeReturned(address indexed filler, bytes32 indexed orderHash, uint256 stake);

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
    }

    function setReactor(address _reactor) external onlyOwner {
        require(reactor  == address(0), "already set");
        require(_reactor != address(0), "zero reactor");
        reactor = _reactor;
    }

    function setStakeTable(uint8 sBucket, uint8 rBucket, uint32 value) external onlyOwner {
        stakeTable[sBucket][rBucket] = value;
    }

    function register(
        bytes32 orderHash,
        uint256 fillAmount,
        uint256 orderTotal,
        uint256 deadline
    ) external payable nonReentrant {
        require(block.number < deadline,  "deadline passed");
        require(fillAmount > 0,           "zero fill");
        require(fillAmount <= orderTotal, "fill > total");
        require(
            _registrations[orderHash][msg.sender].filler == address(0),
            "already registered"
        );

        uint256 required = DynamicStakeLib.computeStake(fillAmount, orderTotal, deadline, stakeTable);
        require(msg.value >= required, "insufficient stake");

        _registrations[orderHash][msg.sender] = Registration({
            filler:       msg.sender,
            // forge-lint: disable-next-line(unsafe-typecast)
            fillAmount:   uint128(fillAmount),
            // forge-lint: disable-next-line(unsafe-typecast)
            stakeAmount:  uint128(required),
            registeredAt: uint64(block.number),
            // forge-lint: disable-next-line(unsafe-typecast)
            deadline:     uint64(deadline),
            filled:       false,
            slashed:      false
        });

        uint256 excess = msg.value - required;
        if (excess > 0) pendingReturns[msg.sender] += excess;

        emit Registered(msg.sender, orderHash, fillAmount, required);
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
        uint256 minAcceptable = uint256(reg.fillAmount) * 90 / 100;
        require(actualFillAmount >= minAcceptable, "filled too little");
        reg.filled = true;
        pendingReturns[filler] += reg.stakeAmount;
        emit StakeReturned(filler, orderHash, reg.stakeAmount);
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
            reg.fillAmount == uint128(fillAmount) &&
            block.number <= reg.deadline
        );
    }
}