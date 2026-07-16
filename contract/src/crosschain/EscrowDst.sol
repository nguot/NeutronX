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
//  LIFECYCLE (filler-holds-key model — filler funds THIS dest escrow first,
//  before the matching EscrowSrc even exists on chain A)
//  ─────────
//  1. Filler pre-funds: token.transfer(cloneAddr, amount)   (no approve)
//  2. Factory deploys clone + calls initialize() — verifies balance
//  3. Swapper (or their client) verifies this escrow is genuine (correct
//     hashlock/recipient/token/amount/expiry) before authorizing the source
//     leg — see EscrowSrcFactory. Filler then reveals the secret on chain A
//     by calling EscrowSrc.withdraw(secret), which emits it publicly there.
//  4. A relayer (no secret custody — just reads the public event on chain A)
//     calls claim() here with that secret. No party on this chain ever
//     derives or holds the secret ahead of time.
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
    uint256 public expiry;     // T2: unix timestamp after which filler may refund

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
        require(_expiry    >  block.timestamp,                       "expiry in past");
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
     * Callable by anyone once the secret is public — normally a relayer,
     * paying gas on the swapper's behalf, after reading the secret from
     * EscrowSrc's Withdrawn event on chain A (the filler revealed it there
     * first; this contract is never the first place the secret appears).
     * Funds always go to `recipient` regardless of who submits, so there is
     * no incentive to front-run — whoever submits first just saves gas for
     * the recipient. If the relayer is unavailable, the swapper can call
     * this directly as a fallback.
     *
     * @param secret  preimage of `hashlock`
     */
    function claim(bytes32 secret) external nonReentrant {
        require(_initialized,                                          "not init");
        require(!claimed && !refunded,                                "settled");
        require(block.timestamp <= expiry,                            "expired");
        require(keccak256(abi.encodePacked(secret)) == hashlock,      "wrong secret");

        claimed = true;
        IERC20(token).safeTransfer(recipient, amount);
        emit Claimed(msg.sender, secret);
    }

    // ── refund ─────────────────────────────────────────────────────────────────
    /**
     * Filler calls this if nobody claims before T2.
     * T2 > T1 (dest closes AFTER source, see EscrowSrc): if the filler never
     * reveals the secret on the source chain, the source escrow already
     * refunds the swapper at T1 — well before this dest refund becomes
     * callable at the later T2. The filler reclaiming its own dest funds
     * here never costs the swapper anything either way.
     */
    function refund() external nonReentrant {
        require(_initialized,             "not init");
        require(!claimed && !refunded,    "settled");
        require(block.timestamp > expiry, "not expired");
        require(msg.sender == filler,     "not filler");

        refunded = true;
        IERC20(token).safeTransfer(filler, amount);
        emit Refunded(filler, amount);
    }

    // ── status ─────────────────────────────────────────────────────────────────
    function status() external view returns (string memory) {
        if (!_initialized)         return "uninitialized";
        if (claimed)                  return "claimed";
        if (refunded)                 return "refunded";
        if (block.timestamp > expiry) return "expired";
        return "active";
    }
}
