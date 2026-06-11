// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";

import { RemainingLib } from "./libs/RemainingLib.sol";
import { DecayCursorLib } from "./libs/DecayCursorLib.sol";
import { ScaledOutputLib } from "./libs/ScaledOutputLib.sol";

import { IPermit2 } from "./interfaces/IPermit2.sol";
import { IFillAuction } from "./interfaces/IFillAuction.sol";

contract PartialFillReactor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct OrderInfo {
        address swapper;
        address inputToken;
        uint256 inputAmount;
        address outputToken;
        uint256 minOutputAmount;
        uint256 deadline;
        uint256 nonce;
        uint16  minFillBps;
        uint128 startPrice;
        uint32  decayPerBlock;
        uint24  feeTier;
    }

    struct SignedOrder {
        OrderInfo info;
        bytes     sig;
    }

    IPermit2     public immutable permit2;
    IFillAuction public immutable fillAuction;
    address      public immutable cosigner;

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant ORDER_TYPE_HASH = keccak256(
        "PartialFillOrder("
        "address swapper,address inputToken,uint256 inputAmount,"
        "address outputToken,uint256 minOutputAmount,"
        "uint256 deadline,uint256 nonce,uint16 minFillBps"
        ")"
    );

    mapping(bytes32 => uint256) private _remaining;
    mapping(bytes32 => DecayCursorLib.DecayCursor) private _cursors;
    mapping(bytes32 => uint256) private _paidOutput;
    mapping(bytes32 => bool)    private _fallbackInitiated;
    mapping(bytes32 => bool)    private _cancelled;

    address public fallbackExecutor;

    event PartialFillExecuted(
        bytes32 indexed orderHash,
        address indexed filler,
        uint256 fillAmount,
        uint256 outputAmount
    );
    event OrderCancelled(bytes32 indexed orderHash, address indexed swapper);

    constructor(address _permit2, address _fillAuction, address _cosigner) {
        require(_permit2     != address(0), "zero permit2");
        require(_fillAuction != address(0), "zero fillAuction");
        require(_cosigner    != address(0), "zero cosigner");
        permit2     = IPermit2(_permit2);
        fillAuction = IFillAuction(_fillAuction);
        cosigner    = _cosigner;

        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
            keccak256("NeutronX"),
            block.chainid,
            address(this)
        ));
    }

    /// Registers msg.sender as a filler for up to `fillAmount` of `order`.
    /// orderTotal/deadline are derived from the real signed order, not
    /// caller input - see exploit.md (registration forgery fix).
    function register(SignedOrder calldata order, uint256 fillAmount) external payable {
        bytes32 orderHash = _hashOrder(order.info);
        fillAuction.register{value: msg.value}(
            msg.sender, orderHash, fillAmount, order.info.inputAmount, order.info.deadline
        );
    }

    function executePartialChunk(
        SignedOrder calldata order,
        uint256 fillAmount
    ) external nonReentrant {
        bytes32 orderHash = _hashOrder(order.info);

        // ── CHECKS ──
        require(!_cancelled[orderHash], "cancelled");
        require(
            fillAuction.hasValidRegistration(orderHash, msg.sender, fillAmount),
            "not registered"
        );

        uint256 rawRemaining = _remaining[orderHash];
        bool isFirstFill = RemainingLib.isNewOrder(rawRemaining);
        if (isFirstFill) _validateOrder(order);

        require(block.number <= order.info.deadline, "expired");

        uint256 currentRemaining = RemainingLib.remaining(rawRemaining, order.info.inputAmount);
        require(fillAmount <= currentRemaining, "fill > remaining");
        require(fillAmount >= _minFill(order),  "fill < minimum");

        // ── EFFECTS ──
        uint256 newRemaining = currentRemaining - fillAmount;
        _remaining[orderHash] = newRemaining == 0
            ? RemainingLib.fullyFilled()
            : RemainingLib.pack(newRemaining);

        DecayCursorLib.DecayCursor storage cursor = _cursors[orderHash];
        uint128 currentPrice;
        if (isFirstFill) {
            DecayCursorLib.init(cursor, order.info.startPrice, order.info.decayPerBlock, uint64(block.number));
            currentPrice = order.info.startPrice;
        } else {
            currentPrice = DecayCursorLib.getCurrentPrice(cursor);
        }
        DecayCursorLib.reset(cursor, currentPrice, uint64(block.number));

        uint256 decayedTotalOutput = _calcOutputAtPrice(order, currentPrice);
        uint256 alreadyPaid  = _paidOutput[orderHash];
        uint256 outputAmount = ScaledOutputLib.scaleOutput(
            decayedTotalOutput, fillAmount, order.info.inputAmount,
            newRemaining == 0, alreadyPaid
        );
        _paidOutput[orderHash] = alreadyPaid + outputAmount;

        // ── INTERACTIONS ──
        // forge-lint: disable-next-line(unsafe-typecast)
        permit2.transferFrom(order.info.swapper, msg.sender, uint160(fillAmount), order.info.inputToken);
        IERC20(order.info.outputToken).safeTransferFrom(msg.sender, order.info.swapper, outputAmount);

        fillAuction.onFillSuccess(orderHash, msg.sender, fillAmount);
        emit PartialFillExecuted(orderHash, msg.sender, fillAmount, outputAmount);
    }

    function remainingInput(bytes32 orderHash, uint256 orderAmount)
        external view returns (uint256)
    {
        return RemainingLib.remaining(_remaining[orderHash], orderAmount);
    }

    function markFallbackInitiated(bytes32 orderHash) external {
        require(msg.sender == fallbackExecutor, "not fallbackExecutor");
        _fallbackInitiated[orderHash] = true;
    }

    /// One-time setter — can only be called once (when fallbackExecutor is still zero).
    function setFallbackExecutor(address _fallbackExecutor) external {
        require(fallbackExecutor == address(0), "already set");
        require(_fallbackExecutor != address(0), "zero address");
        fallbackExecutor = _fallbackExecutor;
    }

    /// Swapper can cancel their own order before it is filled.
    function cancelOrder(OrderInfo calldata info) external {
        require(msg.sender == info.swapper, "not swapper");
        bytes32 orderHash = _hashOrder(info);
        require(!_cancelled[orderHash], "already cancelled");
        _cancelled[orderHash] = true;
        emit OrderCancelled(orderHash, msg.sender);
    }

    function _hashOrder(OrderInfo calldata info) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            ORDER_TYPE_HASH,
            info.swapper, info.inputToken, info.inputAmount,
            info.outputToken, info.minOutputAmount,
            info.deadline, info.nonce, info.minFillBps
        ));
    }

    function _validateOrder(SignedOrder calldata order) internal view {
        require(block.number <= order.info.deadline, "expired");
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, _hashOrder(order.info))
        );
        address signer = ECDSA.recover(digest, order.sig);
        require(signer != address(0), "invalid sig recovery");
        require(signer == cosigner,   "invalid sig");
    }

    function _minFill(SignedOrder calldata order) internal pure returns (uint256) {
        return (order.info.inputAmount * order.info.minFillBps) / 10000;
    }

    function _calcOutputAtPrice(SignedOrder calldata order, uint128 price)
        internal pure returns (uint256)
    {
        return FullMath.mulDiv(order.info.inputAmount, uint256(price), 1e18);
    }
}