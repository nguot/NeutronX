// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
//  EscrowSrc  —  Chain A escrow, one instance per filler slot fill
// ─────────────────────────────────────────────────────────────────────────────
//
//  MIRRORS EscrowDst, WITH TWO DIFFERENCES
//  ────────────────────────────────────────
//  1. Funding: EscrowDst is pre-funded by the filler sending tokens to the
//     precomputed clone address before deployment. EscrowSrc instead receives
//     its `amount` via EscrowSrcFactory redirecting the swapper's standing
//     Permit2 allowance straight into the freshly-deployed clone — the
//     swapper never approves anything beyond the one-time Permit2 allowance
//     to the factory.
//  2. Safety deposit: the filler posts a native-ETH deposit at initialize()
//     time (msg.value, forwarded by the factory). withdraw() returns it to
//     the filler alongside their payout. cancel() pays it to the SWAPPER after
//     expiry — compensation for the lock-up and a penalty on the filler, who
//     (unlike a msg.sender payout) cannot reclaim it by self-cancelling.
//
//  LIFECYCLE
//  ─────────
//  1. EscrowSrcFactory.fillSlot() verifies the Merkle proof for (hashlock,
//     slotIndex), deploys this clone via CREATE2, redirects `amount` of the
//     swapper's input token here via Permit2, then calls initialize() with
//     the filler's safety deposit attached as msg.value.
//  2. Filler completes their leg on Chain B (EscrowDstFactory.deploy()) and
//     the backend reveals S_i there via EscrowDst.claim(), emitting it
//     publicly.
//  3. Anyone (typically the filler or the backend) calls withdraw(S_i) here:
//     the input token amount AND the safety deposit go to the filler.
//  4. If S_i is never revealed before `expiry`, anyone can call cancel():
//     the input token amount AND the safety deposit are sent to the swapper —
//     refunding the stuck slot and compensating them for the lock-up.
//
//  NO MERKLE PROOF HERE
//  ────────────────────
//  The proof that (hashlock, slotIndex) belongs to the order's merkleRoot is
//  checked once, at fill-time, by EscrowSrcFactory — BEFORE this clone is
//  funded. By the time this contract exists, the hashlock is already trusted.
//
//  REENTRANCY NOTE
//  ───────────────
//  Same as EscrowDst: a minimal inline mutex (uint8, 0 = free / 1 = locked)
//  instead of OpenZeppelin's ReentrancyGuard, because clones skip
//  constructors and OZ's guard relies on constructor-time initialization.

import { IERC20 }    from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract EscrowSrc {
    using SafeERC20 for IERC20;

    // ── State (zero-initialised in each fresh clone) ───────────────────────────
    bytes32 public hashlock;       // H_i = keccak256(S_i) — the secret commitment
    address public filler;         // msg.sender of fillSlot() — receives input token + deposit
    address public swapper;        // order owner — refunded on cancel()
    address public token;          // input token (e.g. WETH)
    uint256 public amount;         // slot amount locked here
    uint256 public safetyDeposit;  // native ETH posted by the filler at initialize()
    uint256 public expiry;         // T1: block number after which anyone may cancel()

    bool    public claimed;    // true after withdraw()
    bool    public cancelled;  // true after cancel()

    bool    private _initialized;
    uint8   private _mutex;    // reentrancy guard: 0 = free, 1 = locked

    // Trufy 3.3: pull-payment fallback for the native-ETH safety deposit. If a
    // push to filler/swapper fails (recipient is a contract that rejects ETH),
    // the amount is credited here instead of reverting, so token settlement and
    // cancellation can NEVER be bricked by a non-payable recipient. The owed
    // party withdraws it later via claimEth().
    mapping(address => uint256) public pendingEth;

    // ── Events ─────────────────────────────────────────────────────────────────
    event Withdrawn(address indexed filler, bytes32 secret);
    event Cancelled(address indexed swapper, uint256 amount, address indexed canceller, uint256 safetyDeposit);
    event EthCredited(address indexed owed, uint256 amount);
    event EthClaimed(address indexed owed, address indexed to, uint256 amount);

    // ── Modifiers ──────────────────────────────────────────────────────────────
    modifier nonReentrant() {
        require(_mutex == 0, "reentrant");
        _mutex = 1;
        _;
        _mutex = 0;
    }

    // ── Initialize (called by factory right after clone deployment) ────────────
    /**
     * Sets up the escrow. Called atomically by EscrowSrcFactory.fillSlot(),
     * which redirects `_amount` of `_token` from the swapper into this clone
     * via Permit2 BEFORE calling initialize(), and forwards the filler's
     * safety deposit as msg.value.
     */
    function initialize(
        bytes32 _hashlock,
        address _filler,
        address _swapper,
        address _token,
        uint256 _amount,
        uint256 _expiry
    ) external payable {
        require(!_initialized,                                       "already init");
        require(_swapper  != address(0),                            "zero swapper");
        require(_filler   != address(0),                            "zero filler");
        require(_amount   >  0,                                      "zero amount");
        require(_expiry   >  block.number,                          "expiry in past");
        require(_hashlock != bytes32(0),                            "zero hashlock");
        // M-3: a zero safety deposit makes grief-filling a slot (taking the
        // swapper's funds into an escrow the griefer can never unlock) free
        // beyond gas. Require the filler to put real value at risk.
        require(msg.value  >  0,                                     "zero safety deposit");
        require(IERC20(_token).balanceOf(address(this)) >= _amount, "underfunded");

        _initialized  = true;
        hashlock      = _hashlock;
        filler        = _filler;
        swapper       = _swapper;
        token         = _token;
        amount        = _amount;
        expiry        = _expiry;
        safetyDeposit = msg.value;
    }

    // ── withdraw ───────────────────────────────────────────────────────────────
    /**
     * Callable by anyone once S_i is public (revealed via EscrowDst.claim()
     * on Chain B). Funds always go to `filler`, so there is no incentive to
     * front-run — whoever submits first just saves the filler some gas.
     *
     * @param secret  S_i — preimage of H_i (hashlock)
     */
    function withdraw(bytes32 secret) external nonReentrant {
        require(_initialized,                                     "not init");
        require(!claimed && !cancelled,                           "settled");
        require(block.number <= expiry,                           "expired");
        require(keccak256(abi.encodePacked(secret)) == hashlock,  "wrong secret");

        claimed = true;
        IERC20(token).safeTransfer(filler, amount);
        if (safetyDeposit > 0) _payEth(filler, safetyDeposit);
        emit Withdrawn(filler, secret);
    }

    // ── cancel ─────────────────────────────────────────────────────────────────
    /**
     * Safety valve: if S_i is never revealed before `expiry`, anyone can call
     * this. The swapper's input token is refunded AND the filler's safety
     * deposit is paid to the swapper — a penalty on the filler for not
     * delivering on Chain B that the filler cannot dodge by self-cancelling.
     */
    function cancel() external nonReentrant {
        require(_initialized,           "not init");
        require(!claimed && !cancelled, "settled");
        require(block.number > expiry,  "not expired");

        cancelled = true;
        IERC20(token).safeTransfer(swapper, amount);
        if (safetyDeposit > 0) {
            // The safety deposit goes to the SWAPPER (the griefed party), not the
            // caller. Paying msg.sender let a griefer self-cancel their own stuck
            // escrow and reclaim the deposit — making slot grief-jamming cost only
            // gas. Routing it to the swapper removes that reclaim loophole and
            // compensates the swapper for the capital lock-up.
            // Trufy 3.3: pull-payment so a swapper that rejects ETH can't make
            // cancel() (and thus the slot) permanently stuck.
            _payEth(swapper, safetyDeposit);
        }
        emit Cancelled(swapper, amount, msg.sender, safetyDeposit);
    }

    // ── ETH payout (pull-payment) ───────────────────────────────────────────────
    /**
     * Trufy 3.3: try to push `amt` to `to`; if the send fails (non-payable
     * recipient), credit it as a claimable balance instead of reverting. Called
     * only from within the nonReentrant withdraw()/cancel(), so the mutex is held
     * during the external call.
     */
    function _payEth(address to, uint256 amt) private {
        (bool ok, ) = to.call{value: amt}("");
        if (!ok) {
            pendingEth[to] += amt;
            emit EthCredited(to, amt);
        }
    }

    /**
     * Withdraw any ETH credited to msg.sender by a failed safety-deposit push
     * (Trufy 3.3). Optionally routes to a different payable `to`, so a contract
     * that can't receive ETH directly can still recover the funds.
     */
    function claimEth(address to) external nonReentrant {
        require(to != address(0), "zero to");
        uint256 amt = pendingEth[msg.sender];
        require(amt > 0, "nothing to claim");
        pendingEth[msg.sender] = 0;
        (bool ok, ) = to.call{value: amt}("");
        require(ok, "eth claim failed");
        emit EthClaimed(msg.sender, to, amt);
    }

    // ── status ─────────────────────────────────────────────────────────────────
    function status() external view returns (string memory) {
        if (!_initialized)         return "uninitialized";
        if (claimed)               return "withdrawn";
        if (cancelled)             return "cancelled";
        if (block.number > expiry) return "expired";
        return "active";
    }
}
