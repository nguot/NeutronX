// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
//  EscrowDst  —  Chain B escrow, one instance per filler slot fill
// ─────────────────────────────────────────────────────────────────────────────
//
//  WHY A CLONE INSTEAD OF A SINGLE SHARED CONTRACT?
//  ─────────────────────────────────────────────────
//  A shared HTLC stores all fills in a mapping — one bug drains every filler's
//  funds simultaneously.  Instead we deploy one tiny clone (EIP-1167 minimal
//  proxy) per fill.  Each clone:
//    • holds exactly one filler's tokens in its own storage
//    • is isolated — a bug in one clone cannot touch another
//    • requires NO ERC-20 approval from the filler (tokens are sent directly
//      to the clone's precomputed CREATE2 address before deployment)
//
//  LIFECYCLE
//  ─────────
//  1. Filler pre-funds: USDC.transfer(cloneAddr, amount)   (no approve)
//  2. Factory deploys clone + calls initialize() — verifies balance
//  3. Backend chainBWatcher detects EscrowCreated, re-derives S_i, calls claim()
//  4. Claimed event emits S_i publicly → filler reads it, calls EscrowSrc.withdraw(S_i) on Chain A
//
//  REENTRANCY NOTE
//  ───────────────
//  We use a minimal inline mutex (uint8 starting at 0 = unlocked) instead of
//  OpenZeppelin's ReentrancyGuard because OZ initialises _status to 1 in its
//  constructor — clones skip constructors so _status would start at 0, which
//  OZ treats as an uninitialized/re-entered state in older versions.
//  Our mutex: 0 = free, 1 = locked — correct for zero-initialised clone storage.

import { IERC20 }    from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract EscrowDst {
    using SafeERC20 for IERC20;

    // ── State (zero-initialised in each fresh clone) ───────────────────────────
    bytes32 public hashlock;   // H_i = keccak256(S_i) — the secret commitment
    address public filler;     // who funded this escrow (can refund after T2)
    address public recipient;  // swapper — receives USDC when backend claims
    address public token;      // output token (e.g. USDC)
    uint256 public amount;     // token amount locked here
    uint256 public expiry;     // T2: block number after which filler may refund

    bool    public claimed;    // true after backend reveals S_i
    bool    public refunded;   // true after filler reclaims expired escrow

    bool    private _initialized;
    uint8   private _mutex;    // reentrancy guard: 0 = free, 1 = locked

    // ── Events ─────────────────────────────────────────────────────────────────
    // S_i is emitted here in plaintext — filler reads it from Chain B and uses
    // it to call EscrowSrc.withdraw(S_i) on Chain A (the clone deployed by
    // EscrowSrcFactory.fillSlot()).
    event Claimed(address indexed claimer, bytes32 secret);
    event Refunded(address indexed filler, uint256 amount);

    // ── Modifiers ──────────────────────────────────────────────────────────────
    modifier nonReentrant() {
        require(_mutex == 0, "reentrant");
        _mutex = 1;
        _;
        _mutex = 0;
    }

    // ── Initialize (called by factory right after clone deployment) ────────────
    /**
     * Sets up the escrow.  Called atomically by EscrowDstFactory.deploy().
     * Verifies that the clone already holds the required token balance —
     * the filler sent tokens to this address (precomputed via CREATE2) before
     * calling factory.deploy(), so no ERC-20 approve is ever needed.
     */
    function initialize(
        bytes32 _hashlock,
        address _filler,
        address _recipient,
        address _token,
        uint256 _amount,
        uint256 _expiry
    ) external {
        require(!_initialized,                                        "already init");
        require(_recipient != address(0),                            "zero recipient");
        // Slither (missing-zero-check): parity with EscrowSrc.initialize. The factory
        // always passes msg.sender as _filler (never zero), so this is defence-in-depth.
        require(_filler    != address(0),                            "zero filler");
        require(_amount    >  0,                                      "zero amount");
        require(_expiry    >  block.number,                          "expiry in past");
        require(_hashlock  != bytes32(0),                            "zero hashlock");
        require(IERC20(_token).balanceOf(address(this)) >= _amount,  "underfunded");

        _initialized = true;
        hashlock  = _hashlock;
        filler    = _filler;
        recipient = _recipient;
        token     = _token;
        amount    = _amount;
        expiry    = _expiry;
    }

    // ── claim ──────────────────────────────────────────────────────────────────
    /**
     * Called by the backend after verifying the filler locked enough tokens.
     * Revealing S_i here makes it public — the filler reads the Claimed event
     * on Chain B and submits S_i to EscrowSrc.withdraw() on Chain A.
     *
     * @param secret  S_i — preimage of H_i (hashlock)
     */
    function claim(bytes32 secret) external nonReentrant {
        require(_initialized,                                          "not init");
        require(!claimed && !refunded,                                "settled");
        require(block.number <= expiry,                               "expired");
        require(keccak256(abi.encodePacked(secret)) == hashlock,      "wrong secret");

        claimed = true;
        IERC20(token).safeTransfer(recipient, amount);
        emit Claimed(msg.sender, secret);
    }

    // ── refund ─────────────────────────────────────────────────────────────────
    /**
     * Filler calls this if the backend never claims before T2.
     * T2 < T1 invariant guarantees this can always happen before the swapper
     * reclaims on Chain A.
     */
    function refund() external nonReentrant {
        require(_initialized,          "not init");
        require(!claimed && !refunded, "settled");
        require(block.number > expiry, "not expired");
        require(msg.sender == filler,  "not filler");

        refunded = true;
        IERC20(token).safeTransfer(filler, amount);
        emit Refunded(filler, amount);
    }

    // ── status ─────────────────────────────────────────────────────────────────
    function status() external view returns (string memory) {
        if (!_initialized)         return "uninitialized";
        if (claimed)               return "claimed";
        if (refunded)              return "refunded";
        if (block.number > expiry) return "expired";
        return "active";
    }
}
