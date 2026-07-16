// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
//  EscrowSrcFactory  —  Chain A (SOURCE chain, where the swapper's tokens live)
// ─────────────────────────────────────────────────────────────────────────────
//
//  MODEL 2 — filler-holds-key, continuous fill (see
//  CROSSCHAIN_INTENT_REDESIGN_HUONG_PHAT_TRIEN.md at the repo root for the
//  full design). Supersedes the old Merkle-slot / cosigner-secret model:
//    • the FILLER generates the secret S per fill (not the swapper/backend)
//    • fills are continuous (one hashlock per filler per fill), not N fixed
//      Merkle slots — remaining input is tracked on-chain instead
//    • no cosigner signature at all — only the swapper's own two signatures
//      (see below)
//
//  TWO SWAPPER SIGNATURES, DIFFERENT LIFETIMES
//  --------------------------------------------
//  1. `swapperSig` over `OrderInfo` — the intent, signed ONCE off-chain
//     (inputToken/inputAmount/outputToken/minOutput/deadlineBase/nonce/feeTier).
//  2. `perFillSig` over `FillAuth` — signed PER FILL, AFTER the swapper (or
//     their client) has verified the filler's EscrowDst on chain B is genuine
//     (correct hashlock/recipient/token/amount/expiry — see
//     EscrowDstFactory). This is the ordering the design doc calls out as the
//     deterministic defense against "filler hủi hút TokenA rồi không fund
//     dest": the swapper only authorizes pulling their input AFTER dest is
//     already funded and verified.
//
//  Both signatures are re-verified on EVERY fillSlot() call (no lazily-cached
//  "OrderState" from the old design) — this mirrors PartialFillReactor's
//  _validateOrder-every-call pattern, and needs no first-fill special case.
//
//  REMAINING (ON-CHAIN, PARTIAL-FILL ACCOUNTING)
//  ------------------------------------------------
//  `_remaining[orderHash]` is tracked with the same RemainingLib packing
//  PartialFillReactor uses for single-chain partial fills: 0 = not started,
//  type(uint256).max = fully filled, otherwise the bitwise-complement of the
//  amount left. Every fillSlot() call decrements it by `fillAmount` and
//  reverts on over-fill.
//
//  KNOWN OPEN GAP (doc §12.4, not solved here): once a fill is decremented
//  from `remaining`, that amount is gone from the order's fillable total even
//  if the fill is later abandoned and its EscrowSrc clone is cancelled
//  (refunding the swapper's tokens to their WALLET, but not restoring
//  `remaining`). The design doc explicitly flags "đối soát partial-fill
//  cross-chain" as an unresolved problem — this factory does not invent a
//  reopen/restore mechanism for it.
//
//  BOND (DYNAMIC, VIA DynamicStakeLib)
//  ------------------------------------
//  Replaces the old flat `MIN_SAFETY_DEPOSIT`. Bond is sized off the value of
//  the INPUT token being locked on THIS (source) chain, quoted in this
//  chain's own native token via a pluggable `IEthNotionalOracle` (see
//  UniswapV3NotionalOracle for the default TWAP-based implementation) —
//  never a cross-chain price. A chain without a compatible DEX can supply a
//  different oracle implementation without touching this factory or
//  DynamicStakeLib. See DynamicStakeLib.requiredStakeByTimestamp (a twin of
//  the single-chain block-number-based requiredStake, needed because this
//  factory's timelocks are unix timestamps, not block numbers).
//
//  Unlike FillAuction's stake (which has a partial-fill refund SCHEDULE),
//  bond here is strictly binary per fill: EscrowSrc.withdraw() returns it in
//  full to the filler, EscrowSrc.cancel() forfeits it in full to the swapper.
//  Each escrow is one atomic fill — there is no partial-delivery-of-a-single-
//  escrow concept to schedule a refund curve against. Accordingly the
//  StakeConfig installed here only needs `requiredStakeByTimestamp`; the
//  refund-table fields are inert (never read via computeRefund).
//
//  The StakeConfig is fixed at deploy time (no PARAM_ADMIN / guard / cooldown
//  / rollback machinery like FillAuction's — that governance surface isn't
//  needed for a fixed-shape bond floor here, and adding it would be scope
//  well beyond this factory's job).
//
//  WHY NO reopenSlot() / SlotLib?
//  --------------------------------
//  Slots no longer exist. A hashlock funds at most one escrow: the CREATE2
//  salt is keccak256(orderHash, hashlock), so a second fillSlot() with the
//  same (orderHash, hashlock) collides on an already-deployed clone and
//  reverts — the same collision-based one-shot guarantee EscrowDstFactory
//  already relies on for its own clones.

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Clones }          from "@openzeppelin/contracts/proxy/Clones.sol";
import { ECDSA }            from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { IPermit2 }          from "../interfaces/IPermit2.sol";
import { IEthNotionalOracle } from "../interfaces/IEthNotionalOracle.sol";
import { RemainingLib }      from "../libs/RemainingLib.sol";
import { DynamicStakeLib }   from "../libs/DynamicStakeLib.sol";
import { EscrowSrc }         from "./EscrowSrc.sol";

contract EscrowSrcFactory is ReentrancyGuard {

    // ─── Order intent (signed ONCE by the swapper, off-chain) ─────────────────
    struct OrderInfo {
        address swapper;
        address inputToken;    // token to sell on THIS chain
        uint256 inputAmount;   // total across all fills
        address outputToken;   // token wanted on the dest chain — not enforced here
        uint256 minOutput;     // total minimum output — enforced off-chain (filler quote gate)
        uint256 deadlineBase;  // ceiling: no fill's t1 may exceed this (unix timestamp)
        uint256 nonce;         // anti-replay: must be unique per swapper
        uint24  feeTier;       // Uniswap V3 fee tier for this factory's (inputToken, wrappedNative)
                                // TWAP pool — part of the signed order so a filler cannot inject a
                                // different tier to steer the bond's oracle read.
    }

    // ─── Per-fill authorization (signed PER FILL by the swapper, AFTER dest verify) ──
    struct FillAuth {
        bytes32 orderHash;   // binds this auth to a specific OrderInfo
        bytes32 hashlock;    // H — chosen by the filler for this fill
        uint256 fillAmount;  // this fill's share of inputAmount
        uint256 t1;          // source expiry (unix timestamp), <= info.deadlineBase
        uint256 t2;          // sanctioned dest expiry; enforced here as t2 > t1
    }

    // ─── EIP-712 setup ────────────────────────────────────────────────────────
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 public constant ORDER_TYPE_HASH = keccak256(
        "CrossChainOrder("
        "address swapper,address inputToken,uint256 inputAmount,"
        "address outputToken,uint256 minOutput,"
        "uint256 deadlineBase,uint256 nonce,uint24 feeTier"
        ")"
    );

    bytes32 public constant FILL_TYPE_HASH = keccak256(
        "CrossChainFill("
        "bytes32 orderHash,bytes32 hashlock,uint256 fillAmount,uint256 t1,uint256 t2"
        ")"
    );

    // ─── Bond config bounds (mirrors FillAuction's, minus the refund-schedule
    //     floor — a binary all-or-nothing bond has no partial-fill sniping
    //     economics to protect via a kappa floor) ─────────────────────────────
    uint32  public constant MAX_COLLATERAL_RATE = 1_000_000; // 10,000% ceiling
    uint32  public constant MAX_REFUND_BPS       = 10_000;    // 100% ceiling (inert field, still shape-checked)
    uint32  public constant MIN_COLLATERAL_RATE  = 100;       // 1% floor — a 0 rate makes bonding free
    uint256 public constant MAX_BUCKETS          = 16;

    // ─── Immutables ───────────────────────────────────────────────────────────
    address  public immutable implementation; // EscrowSrc logic contract
    IPermit2 public immutable permit2;

    // D-1-style ETH-denominated bond oracle — pluggable (see
    // IEthNotionalOracle / UniswapV3NotionalOracle). Always local to the
    // source chain (quotes this chain's own native token), never a
    // cross-chain price feed. Zero address = disabled (raw amount as
    // notional) — an explicit deploy-time choice, see the constructor.
    IEthNotionalOracle public immutable oracle;
    bool               public immutable oracleDisabled;

    // ─── State ────────────────────────────────────────────────────────────────
    // Fixed at deploy time — see the file header for why this factory doesn't
    // replicate FillAuction's live-reshape governance (PARAM_ADMIN/guard/
    // cooldown/rollback).
    DynamicStakeLib.StakeConfig private _config;

    // RemainingLib-packed per-order remaining input (see file header).
    mapping(bytes32 => uint256) private _remaining;

    // §12.4 orphaned-reservation fix: the order's total inputAmount, snapshotted
    // on first fill. restoreRemaining() needs it to interpret the RemainingLib
    // packing (which is orderAmount-relative) when handing a cancelled fill's
    // amount back to `remaining`. Always the same value for a given orderHash
    // (inputAmount is part of the order hash), so writing it every fill is safe.
    mapping(bytes32 => uint256) private _orderAmount;

    // ─── Events ───────────────────────────────────────────────────────────────
    event Filled(
        bytes32 indexed orderHash,
        bytes32 indexed hashlock,
        address indexed filler,
        address escrow,
        uint256 fillAmount,
        uint256 bondAmount,
        uint256 t1,
        uint256 t2
    );

    // §12.4 orphaned-reservation fix: emitted when a cancelled fill's reserved
    // amount is returned to the order's fillable remainder (see restoreRemaining).
    event RemainingRestored(
        bytes32 indexed orderHash,
        bytes32 indexed hashlock,
        uint256 amount,
        uint256 newRemaining
    );

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(
        address _implementation,
        address _permit2,
        IEthNotionalOracle _oracle,
        bool    _oracleDisabled,
        DynamicStakeLib.StakeConfig memory _stakeConfig
    ) {
        require(_implementation != address(0), "zero impl");
        require(_permit2        != address(0), "zero permit2");
        // Trufy 3.6 pattern (see FillAuction): oracle-disabled mode must be an
        // EXPLICIT deploy-time choice, never a silent fallback from a
        // half-configured deploy.
        if (_oracleDisabled) {
            require(address(_oracle) == address(0), "disabled needs zero oracle");
        } else {
            require(address(_oracle) != address(0), "zero oracle");
        }

        implementation = _implementation;
        permit2         = IPermit2(_permit2);
        oracle          = _oracle;
        oracleDisabled  = _oracleDisabled;

        DynamicStakeLib.validate(
            _stakeConfig,
            MIN_COLLATERAL_RATE,
            MAX_COLLATERAL_RATE,
            MAX_REFUND_BPS,
            MAX_BUCKETS,
            0 // no kappa floor — bond here is binary, not a partial-fill refund schedule
        );
        _config = _stakeConfig;

        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
            keccak256("NeutronX CrossChain"),
            block.chainid,
            address(this)
        ));
    }

    // ─── fillSlot ─────────────────────────────────────────────────────────────
    /**
     * Filler calls this once per fill. msg.value is this fill's bond,
     * forwarded to the new EscrowSrc clone.
     *
     * @param info        Order intent, signed once by the swapper
     * @param swapperSig  ECDSA signature by info.swapper over `info`
     * @param auth        This fill's terms — hashlock/amount/t1/t2, signed
     *                    by the swapper AFTER verifying the filler's dest
     *                    escrow (see EscrowDstFactory)
     * @param perFillSig  ECDSA signature by info.swapper over `auth`
     * @return escrow     Address of the newly deployed EscrowSrc clone
     */
    function fillSlot(
        OrderInfo calldata info,
        bytes     calldata swapperSig,
        FillAuth  calldata auth,
        bytes     calldata perFillSig
    ) external payable nonReentrant returns (address escrow) {
        bytes32 orderHash = _hashOrder(info);
        require(auth.orderHash == orderHash, "auth/order mismatch");

        require(info.inputAmount > 0,                 "zero amount");
        require(block.timestamp <= info.deadlineBase, "order expired");
        require(auth.t1 <= info.deadlineBase,          "t1 beyond deadlineBase");
        require(auth.t2 > auth.t1,                     "t2 must exceed t1");
        require(auth.fillAmount > 0,                   "zero fill amount");
        require(auth.fillAmount <= type(uint160).max,  "fill amount overflow");

        _verifySig(orderHash, swapperSig, info.swapper);
        _verifySig(_hashFill(auth), perFillSig, info.swapper);

        // §12.4: snapshot the order total so restoreRemaining() can later
        // interpret this order's RemainingLib packing on a cancelled fill.
        _orderAmount[orderHash] = info.inputAmount;

        // ── remaining (checks + effects before interactions) ───────────────────
        uint256 currentRemaining = RemainingLib.remaining(_remaining[orderHash], info.inputAmount);
        require(auth.fillAmount <= currentRemaining, "fill > remaining");
        uint256 newRemaining = currentRemaining - auth.fillAmount;
        _remaining[orderHash] = newRemaining == 0
            ? RemainingLib.fullyFilled()
            : RemainingLib.pack(newRemaining);

        // ── bond: size against the ETH-notional value of the input locked,
        //     priced on THIS (source) chain only ───────────────────────────────
        uint256 required = _requiredStake(auth.fillAmount, info.inputToken, info.feeTier, auth.t1);
        require(msg.value >= required, "bond below required stake");

        // ── deploy the per-fill clone and fund it ─────────────────────────────
        // salt binds (orderHash, hashlock): a second fillSlot() reusing the
        // same hashlock for this order collides on an already-deployed clone
        // and reverts — no explicit "already filled" bitmap needed.
        bytes32 salt = keccak256(abi.encodePacked(orderHash, auth.hashlock));
        escrow = Clones.cloneDeterministic(implementation, salt);

        // Redirect the swapper's standing Permit2 allowance straight into the
        // new clone — same primitive PartialFillReactor uses, just a
        // different `to` address.
        permit2.transferFrom(info.swapper, escrow, uint160(auth.fillAmount), info.inputToken);

        EscrowSrc(escrow).initialize{value: msg.value}(
            auth.hashlock, msg.sender, info.swapper, info.inputToken, auth.fillAmount, auth.t1,
            orderHash, address(this)
        );

        emit Filled(orderHash, auth.hashlock, msg.sender, escrow, auth.fillAmount, msg.value, auth.t1, auth.t2);
    }

    // ─── restoreRemaining (§12.4 orphaned-reservation fix) ──────────────────────
    /**
     * Called by an EscrowSrc clone from within its cancel() to return a
     * cancelled (abandoned) fill's `amount` to the order's fillable remainder.
     *
     * Safety:
     *  - AUTHENTICITY: only the exact clone this factory deployed for
     *    (orderHash, hashlock) can call — the CREATE2 address is recomputed and
     *    compared to msg.sender, so no arbitrary contract can inflate `remaining`.
     *  - ONE-SHOT: EscrowSrc.cancel() flips `cancelled` before calling here and
     *    reverts on a second cancel, so each clone restores at most its own
     *    `amount`, exactly once.
     *  - CONSERVATIVE: the restored value is clamped to the order total, so the
     *    remainder can never exceed inputAmount even under an unexpected sequence.
     *
     * The hashlock stays spent regardless (its clone still occupies the CREATE2
     * address), so this only reopens the *amount*, never the used hashlock — a
     * new filler must fill the reopened slice with a fresh hashlock.
     */
    function restoreRemaining(bytes32 orderHash, bytes32 hashlock, uint256 amount) external {
        address expected = Clones.predictDeterministicAddress(
            implementation, keccak256(abi.encodePacked(orderHash, hashlock))
        );
        require(msg.sender == expected, "not escrow clone");

        uint256 orderAmount = _orderAmount[orderHash];
        uint256 restored = RemainingLib.remaining(_remaining[orderHash], orderAmount) + amount;
        if (restored > orderAmount) restored = orderAmount; // never exceed the order total
        _remaining[orderHash] = restored == 0
            ? 0
            : RemainingLib.pack(restored);

        emit RemainingRestored(orderHash, hashlock, amount, restored);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function remainingInput(bytes32 orderHash, uint256 orderAmount) external view returns (uint256) {
        return RemainingLib.remaining(_remaining[orderHash], orderAmount);
    }

    function hashOrder(OrderInfo calldata info) external pure returns (bytes32) {
        return _hashOrder(info);
    }

    function hashFill(FillAuth calldata auth) external pure returns (bytes32) {
        return _hashFill(auth);
    }

    /**
     * Returns the address an EscrowSrc clone WILL be deployed to for
     * (orderHash, hashlock), before fillSlot() is called.
     */
    function computeAddress(bytes32 orderHash, bytes32 hashlock) external view returns (address) {
        return Clones.predictDeterministicAddress(
            implementation, keccak256(abi.encodePacked(orderHash, hashlock))
        );
    }

    /// True once a clone has been deployed for (orderHash, hashlock) — a
    /// hashlock can only ever fund one escrow (CREATE2 collision otherwise).
    function isFilled(bytes32 orderHash, bytes32 hashlock) external view returns (bool) {
        address escrow = Clones.predictDeterministicAddress(
            implementation, keccak256(abi.encodePacked(orderHash, hashlock))
        );
        return escrow.code.length > 0;
    }

    function stakeConfig() external view returns (DynamicStakeLib.StakeConfig memory) {
        return _config;
    }

    /**
     * Exact ETH bond a filler must attach as msg.value to fillSlot() for
     * `fillAmount` of `inputToken` at fee tier `feeTier`, expiring at `t1`.
     * Off-chain callers (fillers) call this instead of re-deriving the oracle
     * quote + bucket math themselves, then send it as msg.value.
     */
    function previewRequiredStake(
        uint256 fillAmount,
        address inputToken,
        uint24  feeTier,
        uint256 t1
    ) external view returns (uint256) {
        return _requiredStake(fillAmount, inputToken, feeTier, t1);
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _requiredStake(
        uint256 fillAmount,
        address inputToken,
        uint24  feeTier,
        uint256 t1
    ) internal view returns (uint256) {
        uint256 notionalEth = address(oracle) == address(0)
            ? fillAmount
            : oracle.quoteEthNotional(inputToken, fillAmount, feeTier);
        return DynamicStakeLib.requiredStakeByTimestamp(_config, notionalEth, t1);
    }

    function _hashOrder(OrderInfo calldata info) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            ORDER_TYPE_HASH,
            info.swapper,
            info.inputToken,
            info.inputAmount,
            info.outputToken,
            info.minOutput,
            info.deadlineBase,
            info.nonce,
            info.feeTier
        ));
    }

    function _hashFill(FillAuth calldata auth) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            FILL_TYPE_HASH,
            auth.orderHash,
            auth.hashlock,
            auth.fillAmount,
            auth.t1,
            auth.t2
        ));
    }

    function _verifySig(bytes32 structHash, bytes calldata sig, address expectedSigner) internal view {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = ECDSA.recover(digest, sig);
        require(signer != address(0) && signer == expectedSigner, "invalid signature");
    }
}
