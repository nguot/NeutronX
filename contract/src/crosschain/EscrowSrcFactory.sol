// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
//  EscrowSrcFactory  —  Chain A (SOURCE chain, where the swapper's tokens live)
// ─────────────────────────────────────────────────────────────────────────────
//
//  WHAT THIS CONTRACT DOES
//  -----------------------
//  Replaces CrossChainReactor. Instead of pulling the swapper's ENTIRE
//  inputAmount into a shared escrow up front, this factory deploys one
//  isolated EscrowSrc clone PER FILLED SLOT — mirroring how EscrowDstFactory
//  already works on Chain B. The swapper's tokens for slots that never get
//  filled are NEVER pulled out of their wallet in the first place.
//
//  HOW THE SWAPPER "LOCKS" FUNDS WITHOUT A SHARED ESCROW
//  ------------------------------------------------------
//  The swapper does ONE-TIME setup, identical UX to today:
//    1. ERC20.approve(Permit2, inputToken, type(uint256).max)  (once, ever)
//    2. Permit2.approve(address(this), inputToken, inputAmount, expiration)
//
//  Step 2 makes THIS FACTORY (a fixed, well-known address) an approved
//  Permit2 spender for the swapper. Permit2's AllowanceTransfer.transferFrom
//  lets an approved spender redirect funds to ANY `to` address — so at
//  fill-time we redirect straight into the freshly CREATE2'd EscrowSrc clone:
//
//      permit2.transferFrom(swapper, cloneAddr, slotAmount, inputToken)
//
//  No witness/permit signature is needed for this redirect — it's a plain
//  AllowanceTransfer pull, same primitive PartialFillReactor already uses.
//
//  WHY MERKLE TREE INSTEAD OF N SEPARATE HTLC CONTRACTS?
//  ------------------------------------------------------
//  Same rationale as the old CrossChainReactor: the KeyDistributor server
//  derives S_i = keccak256(M, i), H_i = keccak256(S_i), and builds an N-leaf
//  Merkle tree over leaf_i = keccak256(bytes.concat(keccak256(abi.encode(H_i,
//  slotIndex_i)))) (OZ double-hash format). Only the 32-byte root is signed
//  and stored on-chain.
//
//  TWO SIGNATURES PER ORDER
//  ------------------------
//  Because the swapper no longer calls a function themselves to "create" the
//  order (that happens lazily, inside the first fillSlot()), we now require
//  TWO EIP-712 signatures over the same OrderInfo struct hash:
//    • swapperSig  — proves the swapper authorized exactly this order
//                     (inputAmount, deadline, merkleRoot, ...)
//    • cosignerSig — proves the KeyDistributor server built this exact
//                     Merkle tree and holds secrets for every H_i in it
//                     (unchanged from CrossChainReactor's cosigner check)
//
//  FULL FLOW (one slot)
//  --------------------
//   1. Swapper signs an OrderInfo off-chain (gasless) and approves Permit2
//      → this factory for inputAmount, once.
//   2. Server assigns slot i to a filler and gives them H_i + merkleProof_i.
//   3. Filler calls fillSlot(info, swapperSig, cosignerSig, i, H_i, proof)
//      with msg.value = safety deposit.
//        - On the FIRST fillSlot() for this order: verifies both signatures,
//          stores OrderState.
//        - Verifies the Merkle proof for (H_i, i) BEFORE touching funds.
//        - Deploys an EscrowSrc clone, redirects slotAmount of inputToken
//          from swapper → clone via Permit2, initializes the clone with the
//          safety deposit.
//   4. Filler sends USDC to the precomputed EscrowDst clone address on
//      Chain B and calls EscrowDstFactory.deploy(H_i, swapper, USDC, amount, T2).
//   5. Server confirms the Chain B deposit, calls EscrowDst.claim(S_i)
//      → USDC sent to swapper, S_i emitted publicly on Chain B.
//   6. Anyone calls EscrowSrc(clone).withdraw(S_i) → WETH + safety deposit
//      sent to the filler on Chain A.
//   7. If S_i is never revealed before T1, anyone calls
//      EscrowSrc(clone).cancel() → WETH refunded to swapper, safety deposit
//      to the caller.
//
//  WHY NO reclaimExpired() AT THE ORDER LEVEL?
//  --------------------------------------------
//  Because funds for unfilled slots were never pulled, there's nothing to
//  reclaim at the order level. Funds for FILLED-but-stuck slots are returned
//  per-clone via EscrowSrc.cancel() (step 7 above).
//
//  SECURITY NOTES
//  --------------
//  • Merkle proof verification happens BEFORE the Permit2 redirect — a
//    filler cannot pick an arbitrary hashlock they know the secret to and
//    drain the swapper, because (hashlock, slotIndex) must be a leaf of the
//    swapper-and-cosigner-approved merkleRoot.
//  • "slot already filled" is enforced via a plain require/revert. A revert
//    atomically undoes the CREATE2 deployment, the Permit2 redirect, and any
//    msg.value sent — no funds can get stuck from a losing race between two
//    fillers for the same slot.
//  • outputToken / minOutput are NOT enforced on-chain here — see
//    CrossChainReactor's original notes (still applies): the cosigner only
//    reveals S_i once it confirms the filler locked enough on Chain B.

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Clones }          from "@openzeppelin/contracts/proxy/Clones.sol";
import { MerkleProof }      from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { ECDSA }            from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { IPermit2 }  from "../interfaces/IPermit2.sol";
import { SlotLib }   from "./libs/SlotLib.sol";
import { EscrowSrc } from "./EscrowSrc.sol";

contract EscrowSrcFactory is ReentrancyGuard {

    // ─── Order data (signed by both the swapper and the cosigner) ─────────────
    struct OrderInfo {
        address swapper;
        address inputToken;   // token to sell on THIS chain (e.g. WETH)
        uint256 inputAmount;  // total amount to sell
        address outputToken;  // token wanted on DEST chain (e.g. USDC) — not enforced here
        uint256 minOutput;    // minimum total output expected — enforced by the server, not here
        uint256 deadline;     // T1 (block number): clones initialized after this revert
        uint256 nonce;        // anti-replay: must be unique per swapper
        bytes32 merkleRoot;   // root of the N-leaf tree built by the server
        uint8   numSlots;     // N — must be a power of 2 between 2 and 64
    }

    // ─── What we store per order, lazily populated on the first fillSlot() ────
    struct OrderState {
        address swapper;
        address inputToken;
        uint256 slotAmount;      // inputAmount / numSlots — what each regular slot pulls
        uint256 lastSlotAmount;  // slot (numSlots-1) gets the remainder from integer division
        uint256 deadline;
        bytes32 merkleRoot;
        uint8   numSlots;
        // Bitmap: bit i is set once slot i has been filled (its clone deployed).
        // uint64 has exactly 64 bits — one per slot at our max numSlots.
        uint64  filledBitmap;
    }

    // ─── EIP-712 setup ────────────────────────────────────────────────────────
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 public constant ORDER_TYPE_HASH = keccak256(
        "CrossChainOrder("
        "address swapper,address inputToken,uint256 inputAmount,"
        "address outputToken,uint256 minOutput,"
        "uint256 deadline,uint256 nonce,bytes32 merkleRoot,uint8 numSlots"
        ")"
    );

    // 3.7: griefing floor. A positive-but-dust safety deposit makes locking a
    // large slot into an unclaimable escrow nearly free (cost = gas + 1 wei).
    // Require a real minimum so abandoned fills are economically costly. Flat
    // rather than slot-proportional for simplicity — could be made a configurable
    // / value-scaled constructor parameter in a production deployment.
    uint256 public constant MIN_SAFETY_DEPOSIT = 0.001 ether;

    // ─── Immutables ───────────────────────────────────────────────────────────
    address  public immutable implementation; // EscrowSrc logic contract
    IPermit2 public immutable permit2;
    address  public immutable cosigner;        // server's signing key; set once at deploy

    // ─── State ────────────────────────────────────────────────────────────────
    mapping(bytes32 => OrderState) private _orders;
    mapping(bytes32 => bool)       private _created; // true once the first fillSlot() ran

    // M-3: bumped each time a slot is reopened after its escrow was cancelled.
    // Folded into the CREATE2 salt so a reopened slot deploys a FRESH clone at
    // a new address — the old (forever-stuck) clone is simply abandoned.
    // Trufy 3.8: attempt counter is uint32, not uint8 — a uint8 reverts on the
    // 256th cancel/reopen cycle (checked add at 255) and permanently bricks the
    // slot. uint32 puts that ceiling out of reach.
    mapping(bytes32 => mapping(uint8 => uint32)) private _attempt;

    // ─── Events ───────────────────────────────────────────────────────────────
    event OrderCreated(
        bytes32 indexed orderHash,
        address indexed swapper,
        address         inputToken,
        uint256         inputAmount,
        uint8           numSlots,
        uint256         deadline
    );

    event SlotFilled(
        bytes32 indexed orderHash,
        uint8   indexed slotIndex,
        address indexed filler,
        address         escrow,
        bytes32         hashlock,
        uint256         amount,
        uint256         safetyDeposit
    );

    // M-3: emitted when a permanently-stuck slot (its escrow was cancelled —
    // refunded to the swapper, with the safety deposit forfeited to whoever
    // cancelled it) is reopened for a fresh fillSlot() attempt.
    event SlotReopened(bytes32 indexed orderHash, uint8 indexed slotIndex, uint32 attempt);

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _implementation, address _permit2, address _cosigner) {
        require(_implementation != address(0), "zero impl");
        require(_permit2        != address(0), "zero permit2");
        require(_cosigner       != address(0), "zero cosigner");
        implementation = _implementation;
        permit2        = IPermit2(_permit2);
        cosigner       = _cosigner;

        // DOMAIN_SEPARATOR bakes in address(this) — mirrors CrossChainReactor.
        // The server must recompute this when building cosigner signatures,
        // and the swapper's wallet recomputes it when signing the order.
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
            keccak256("NeutronX CrossChain"),
            block.chainid,
            address(this)
        ));
    }

    // ─── fillSlot ─────────────────────────────────────────────────────────────
    /**
     * Filler calls this once per slot they win. msg.value is the filler's
     * safety deposit, forwarded to the new EscrowSrc clone.
     *
     * On the first call for a given order (identified by hash(info)), this
     * also lazily registers the order: validates `info`, verifies both the
     * swapper's and the cosigner's signatures over it, and stores OrderState.
     * Subsequent calls for the same order skip this — `info` hashes to the
     * same orderHash, so `_orders[orderHash]` already reflects it.
     *
     * @param info         Full order parameters, signed by swapper + cosigner
     * @param swapperSig   ECDSA signature by info.swapper over the EIP-712 order hash
     * @param cosignerSig  ECDSA signature by the server over the EIP-712 order hash
     * @param slotIndex    Which slot (0 .. numSlots-1) this filler is taking
     * @param hashlock     H_i for this slot, from the server
     * @param merkleProof  Sibling hashes from leaf_i to merkleRoot (log2(N) elements)
     * @return escrow      Address of the newly deployed EscrowSrc clone
     */
    function fillSlot(
        OrderInfo calldata info,
        bytes     calldata swapperSig,
        bytes     calldata cosignerSig,
        uint8              slotIndex,
        bytes32            hashlock,
        bytes32[] calldata merkleProof
    ) external payable nonReentrant returns (address escrow) {
        // 3.7: enforce the griefing floor before any state changes or fund pulls.
        require(msg.value >= MIN_SAFETY_DEPOSIT, "deposit below floor");

        bytes32 orderHash = _hashOrder(info);
        OrderState storage order = _orders[orderHash];

        if (!_created[orderHash]) {
            require(info.inputAmount >  0,                "zero amount");
            require(SlotLib.isPowerOfTwo(info.numSlots),  "numSlots not power of 2");
            require(info.deadline    >  block.number,     "deadline in past");
            require(info.merkleRoot  != bytes32(0),       "empty merkle root");

            _verifySig(orderHash, swapperSig,  info.swapper);
            _verifySig(orderHash, cosignerSig, cosigner);

            // Integer division truncates; the final slot absorbs the
            // remainder so that sum(slot amounts) == inputAmount exactly.
            uint256 slotAmount     = info.inputAmount / info.numSlots;
            // 3.8: reject orders where inputAmount < numSlots — every non-final
            // slot would round to zero and revert in EscrowSrc.initialize(),
            // leaving only the final slot fillable.
            require(slotAmount > 0, "slot amount zero");
            uint256 lastSlotAmount = info.inputAmount - slotAmount * (info.numSlots - 1);

            order.swapper        = info.swapper;
            order.inputToken     = info.inputToken;
            order.slotAmount     = slotAmount;
            order.lastSlotAmount = lastSlotAmount;
            order.deadline       = info.deadline;
            order.merkleRoot     = info.merkleRoot;
            order.numSlots       = info.numSlots;

            _created[orderHash] = true;
            emit OrderCreated(orderHash, info.swapper, info.inputToken, info.inputAmount, info.numSlots, info.deadline);
        }

        require(block.number <= order.deadline, "order expired");
        require(slotIndex    <  order.numSlots, "slot index out of range");

        // ── "slot already filled" — revert-based, atomically undoes
        //     everything below (CREATE2, Permit2 pull, msg.value).
        uint64 slotBit = uint64(1) << slotIndex;
        require(order.filledBitmap & slotBit == 0, "slot already filled");
        order.filledBitmap |= slotBit;

        // ── Verify (hashlock, slotIndex) is part of the approved tree
        //     BEFORE pulling any funds.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(hashlock, slotIndex))));
        require(MerkleProof.verify(merkleProof, order.merkleRoot, leaf), "invalid merkle proof");

        uint256 amount = (slotIndex == order.numSlots - 1)
            ? order.lastSlotAmount
            : order.slotAmount;

        // ── Deploy the per-fill clone and fund it ─────────────────────────────
        bytes32 salt = _salt(orderHash, slotIndex, _attempt[orderHash][slotIndex]);
        escrow = Clones.cloneDeterministic(implementation, salt);

        // Redirect the swapper's standing Permit2 allowance straight into the
        // new clone — same primitive PartialFillReactor uses, just a
        // different `to` address.
        permit2.transferFrom(order.swapper, escrow, uint160(amount), order.inputToken);

        EscrowSrc(escrow).initialize{value: msg.value}(
            hashlock, msg.sender, order.swapper, order.inputToken, amount, order.deadline
        );

        emit SlotFilled(orderHash, slotIndex, msg.sender, escrow, hashlock, amount, msg.value);
    }

    // ─── reopenSlot ───────────────────────────────────────────────────────────
    /**
     * M-3: a slot's escrow can become permanently stuck if it was filled by a
     * filler who can never produce the secret (e.g. someone who front-ran a
     * leaked (hashlock, slotIndex, proof) tuple without the corresponding
     * Chain-B leg). Once that escrow has expired and been cancelled — refunding
     * the swapper's input and forfeiting the filler's safety deposit to whoever
     * called cancel() — the slot's `filledBitmap` bit would otherwise stay set
     * forever, permanently burning the slot.
     *
     * This function is permissionless and callable by anyone once the CURRENT
     * clone for (orderHash, slotIndex) reports `cancelled() == true`. It clears
     * the slot's filled bit and bumps the attempt counter, so the next
     * fillSlot() for this slot deploys a brand-new clone at a fresh CREATE2
     * address (the old, cancelled clone is simply abandoned).
     */
    function reopenSlot(bytes32 orderHash, uint8 slotIndex) external nonReentrant {
        OrderState storage order = _orders[orderHash];
        require(_created[orderHash], "no such order");

        uint64 slotBit = uint64(1) << slotIndex;
        require(order.filledBitmap & slotBit != 0, "slot not filled");

        uint32 attempt = _attempt[orderHash][slotIndex];
        address escrow = Clones.predictDeterministicAddress(implementation, _salt(orderHash, slotIndex, attempt));
        require(EscrowSrc(escrow).cancelled(), "escrow not cancelled");

        order.filledBitmap &= ~slotBit;
        _attempt[orderHash][slotIndex] = attempt + 1;

        emit SlotReopened(orderHash, slotIndex, attempt + 1);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function getOrder(bytes32 orderHash) external view returns (OrderState memory) {
        return _orders[orderHash];
    }

    function isSlotFilled(bytes32 orderHash, uint8 slotIndex) external view returns (bool) {
        return (_orders[orderHash].filledBitmap & (uint64(1) << slotIndex)) != 0;
    }

    // M-3: how many times (orderHash, slotIndex) has been reopened via
    // reopenSlot(). 0 means the slot is on its original clone/salt.
    function attempt(bytes32 orderHash, uint8 slotIndex) external view returns (uint32) {
        return _attempt[orderHash][slotIndex];
    }

    function hashOrder(OrderInfo calldata info) external pure returns (bytes32) {
        return _hashOrder(info);
    }

    /**
     * Returns the address an EscrowSrc clone WILL be deployed to for
     * (orderHash, slotIndex), before fillSlot() is called. Reflects the
     * current attempt count, so it always points at the LIVE clone — even
     * after a reopenSlot() has moved the slot to a fresh address.
     */
    function computeAddress(bytes32 orderHash, uint8 slotIndex) external view returns (address) {
        bytes32 salt = _salt(orderHash, slotIndex, _attempt[orderHash][slotIndex]);
        return Clones.predictDeterministicAddress(implementation, salt);
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    // M-3: attempt 0 keeps the original (orderHash, slotIndex) salt — fully
    // backward compatible with addresses already computed/communicated
    // off-chain for first-attempt fills. Reopened slots (attempt > 0) fold the
    // attempt counter into the salt so they deploy to a fresh address.
    function _salt(bytes32 orderHash, uint8 slotIndex, uint32 attemptNum) internal pure returns (bytes32) {
        return attemptNum == 0
            ? keccak256(abi.encodePacked(orderHash, slotIndex))
            : keccak256(abi.encodePacked(orderHash, slotIndex, attemptNum));
    }

    function _hashOrder(OrderInfo calldata info) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            ORDER_TYPE_HASH,
            info.swapper,
            info.inputToken,
            info.inputAmount,
            info.outputToken,
            info.minOutput,
            info.deadline,
            info.nonce,
            info.merkleRoot,
            info.numSlots
        ));
    }

    function _verifySig(bytes32 orderHash, bytes calldata sig, address expectedSigner) internal view {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, orderHash));
        address signer = ECDSA.recover(digest, sig);
        require(signer != address(0) && signer == expectedSigner, "invalid signature");
    }
}
