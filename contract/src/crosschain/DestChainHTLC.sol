// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
//  DestChainHTLC  —  Chain B (DESTINATION chain, where output tokens live)
// ─────────────────────────────────────────────────────────────────────────────
//
//  WHAT THIS CONTRACT DOES
//  -----------------------
//  It is a Hashed Time-Lock Contract (HTLC) that sits on the destination chain
//  (e.g. Arbitrum / Optimism).  Fillers lock their output tokens (e.g. USDC)
//  here against a hashlock H_i = keccak256(S_i).  The KeyDistributor server
//  watches this contract; once it confirms a lock, it reveals S_i by calling
//  claim() — which sends USDC to the swapper AND emits S_i in an event so the
//  filler can read it and use it to claim WETH on Chain A (CrossChainReactor).
//
//  ONE SLOT'S LIFECYCLE
//  --------------------
//  1. Server assigns slot i (with H_i) to a filler.
//  2. Filler calls lock(H_i, swapper, USDC, amount, T2) here.
//     T2 = T1 - buffer (e.g. 50 blocks).  T2 < T1 is CRITICAL — it guarantees
//     the filler can refund on Chain B before the swapper reclaims on Chain A.
//  3. Server waits for enough block confirmations (avoids re-org risk), then
//     calls claim(lockId, S_i).
//     → USDC transferred to swapper on Chain B.
//     → Claimed(lockId, claimer, secret) event emitted with S_i in plaintext.
//  4. Filler's indexer sees Claimed event → reads S_i → calls
//     CrossChainReactor.claimSlot(orderHash, i, S_i, merkleProof) on Chain A.
//     → Filler receives WETH on Chain A.
//  5. If the server never reveals (e.g. it crashed, or the server is malicious
//     and decides not to), the filler calls refund(lockId) after T2 to get
//     their USDC back.  The swap for this slot then fails; the swapper reclaims
//     the WETH for this slot on Chain A after T1.
//
//  TRUST MODEL
//  -----------
//  The server is a trusted intermediary.  It can:
//    - Reveal S_i even if the lock amount was insufficient (cheating the swapper).
//    - Refuse to reveal S_i even if the lock is valid (cheating the filler).
//  In the current implementation these are mitigated by reputational/legal means
//  and the T2 safety valve.  For trustless operation, run the server inside a
//  TEE — see README_CROSSCHAIN_TEE.md.
//
//  ANYONE CAN CALL claim()
//  -----------------------
//  The function is permissionless: as long as you know S_i, you can call claim().
//  The funds always go to `lock.recipient` (the swapper), not to the caller.
//  This lets the swapper also act as a "backup revealer" if the server fails,
//  as long as they know S_i (which the server should share with them).

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract DestChainHTLC is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Lock struct ──────────────────────────────────────────────────────────
    struct Lock {
        address filler;    // who deposited the funds; gets them back on refund
        address recipient; // swapper's address on Chain B; gets funds on claim
        address token;     // e.g. USDC on Arbitrum
        uint256 amount;    // how much the filler locked
        bytes32 hashlock;  // H_i = keccak256(S_i); only someone who knows S_i can claim
        uint256 expiry;    // T2 block number; filler can refund after this
        bool    claimed;   // true once secret revealed and funds sent
        bool    refunded;  // true once filler retrieved funds after timeout
    }

    // lockId → Lock.  lockId is a hash — not sequential so it can't be guessed.
    mapping(bytes32 => Lock) private _locks;

    // Monotonically increasing nonce for unique lockId generation.
    uint256 private _nonce;

    // ─── Events ───────────────────────────────────────────────────────────────
    event Locked(
        bytes32 indexed lockId,
        address indexed filler,
        address indexed recipient,
        address         token,
        uint256         amount,
        bytes32         hashlock,
        uint256         expiry
    );

    // The secret S_i is emitted here in plaintext.
    // Filler monitors Chain B for this event to get S_i, then claims on Chain A.
    // Anyone can see it — that's fine: knowing S_i only lets you claim on Chain A
    // if you can also provide a valid Merkle proof for that slot.
    event Claimed(
        bytes32 indexed lockId,
        address indexed claimer, // who called claim() (usually server or swapper)
        bytes32         secret   // S_i — filler reads this and submits to CrossChainReactor
    );

    event Refunded(
        bytes32 indexed lockId,
        address indexed filler,
        uint256         amount
    );

    // ─── lock ─────────────────────────────────────────────────────────────────
    /**
     * Filler deposits output tokens for one slot.
     *
     * The server provides hashlock H_i when it assigns a slot to this filler.
     * The filler must lock at least minOutput/numSlots tokens; the server will
     * verify this before revealing S_i.
     *
     * @param hashlock   H_i = keccak256(S_i) — given by the server during slot assignment
     * @param recipient  Swapper's address on this chain (receives USDC on claim)
     * @param token      Output token address (e.g. USDC on Arbitrum)
     * @param amount     How much to lock (≥ minOutputPerSlot agreed off-chain)
     * @param expiry     T2: block number after which filler can refund if no reveal
     * @return lockId    Use this to call claim() or refund() later
     */
    function lock(
        bytes32 hashlock,
        address recipient,
        address token,
        uint256 amount,
        uint256 expiry
    ) external nonReentrant returns (bytes32 lockId) {
        require(recipient != address(0), "zero recipient");
        require(token     != address(0), "zero token");
        require(amount    >  0,          "zero amount");
        require(expiry    >  block.number, "expiry in past");
        require(hashlock  != bytes32(0), "zero hashlock");

        // Generate a unique lockId.  We hash nonce + caller + hashlock so that
        // even if the same filler locks the same hashlock twice, they get different lockIds.
        lockId = keccak256(abi.encodePacked(_nonce++, msg.sender, hashlock));

        // Defensive check — the hash space is 2^256 so collisions are impossible
        // in practice, but we guard anyway.
        require(_locks[lockId].filler == address(0), "lockId collision");

        _locks[lockId] = Lock({
            filler:    msg.sender,
            recipient: recipient,
            token:     token,
            amount:    amount,
            hashlock:  hashlock,
            expiry:    expiry,
            claimed:   false,
            refunded:  false
        });

        // Pull tokens from filler.  Filler must have approved this contract first.
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Locked(lockId, msg.sender, recipient, token, amount, hashlock, expiry);
    }

    // ─── claim ────────────────────────────────────────────────────────────────
    /**
     * Reveal S_i and send output tokens to the swapper.
     *
     * Called by: the KeyDistributor server (or the swapper directly if they know S_i).
     * The funds ALWAYS go to lock.recipient (the swapper) — not to msg.sender.
     *
     * After this call, S_i is public on-chain via the Claimed event.
     * The filler (or an off-chain indexer) reads it and calls
     * CrossChainReactor.claimSlot() on Chain A to receive their WETH.
     *
     * @param lockId  The lockId returned by lock()
     * @param secret  S_i — must satisfy keccak256(secret) == lock.hashlock
     */
    function claim(bytes32 lockId, bytes32 secret) external nonReentrant {
        Lock storage lk = _locks[lockId];
        require(lk.filler  != address(0), "lock not found");
        require(!lk.claimed,              "already claimed");
        require(!lk.refunded,             "already refunded");
        require(block.number <= lk.expiry, "lock expired");

        // Verify the secret.  This is the core HTLC check.
        require(keccak256(abi.encodePacked(secret)) == lk.hashlock, "wrong secret");

        lk.claimed = true;

        // Send output tokens to swapper (not to msg.sender — this prevents
        // the server from stealing by calling claim() and keeping the funds).
        IERC20(lk.token).safeTransfer(lk.recipient, lk.amount);

        // Emit secret in plaintext so filler can index it from Chain B events.
        emit Claimed(lockId, msg.sender, secret);
    }

    // ─── refund ───────────────────────────────────────────────────────────────
    /**
     * Filler retrieves their tokens after T2 expires without a claim.
     *
     * This is the safety valve ensuring fillers aren't stuck forever.
     * After refunding, this slot simply doesn't complete — the swapper will
     * reclaim the corresponding WETH slot on Chain A after T1.
     *
     * Why T2 < T1 matters:
     *   If T2 ≥ T1, the filler could refund on Chain B AFTER the swapper
     *   already reclaimed WETH on Chain A — leaving the system in a state where
     *   the filler refunded AND the swapper reclaimed, so neither side lost funds.
     *   That's fine for correctness, but the swap simply didn't happen.
     *   The gap (T1 - T2) should be large enough for chain re-org safety.
     */
    function refund(bytes32 lockId) external nonReentrant {
        Lock storage lk = _locks[lockId];
        require(lk.filler == msg.sender, "not filler");
        require(!lk.claimed,             "already claimed");
        require(!lk.refunded,            "already refunded");
        require(block.number > lk.expiry, "not yet expired");

        lk.refunded = true;

        IERC20(lk.token).safeTransfer(lk.filler, lk.amount);

        emit Refunded(lockId, lk.filler, lk.amount);
    }

    // ─── View ─────────────────────────────────────────────────────────────────

    function getLock(bytes32 lockId) external view returns (Lock memory) {
        return _locks[lockId];
    }
}
