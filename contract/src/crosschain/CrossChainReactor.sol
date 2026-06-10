// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
//  CrossChainReactor  —  Chain A (SOURCE chain, where the swapper's tokens live)
// ─────────────────────────────────────────────────────────────────────────────
//
//  WHAT THIS CONTRACT DOES
//  -----------------------
//  It is the "escrow" for a cross-chain swap.  The swapper locks their input
//  tokens (e.g. WETH on Ethereum) here and specifies what they want in return
//  (e.g. USDC on Arbitrum).  Multiple fillers compete to satisfy slices of the
//  order on the destination chain.  When a filler proves they delivered on
//  Chain B, they receive their slice of WETH here.
//
//  WHY MERKLE TREE INSTEAD OF N SEPARATE HTLC CONTRACTS?
//  ------------------------------------------------------
//  Classic approach for N partial fills: deploy N individual HTLC contracts,
//  each holding (inputAmount / N) WETH with its own hashlock.
//  Problem: deploying N contracts costs O(N) gas and is complex to manage.
//
//  Better approach: build an off-chain Merkle tree where leaf_i commits to
//  the hashlock H_i for slot i.  Store only the 32-byte root on-chain.
//  A filler claims slot i by presenting (secret_i, Merkle proof for leaf_i).
//  The contract verifies the proof in O(log N) hashes — one cheap operation
//  instead of N contract deployments.
//
//  THE SECRETS
//  -----------
//  The KeyDistributor server (see key_distributor/ folder) holds a master
//  secret M.  It derives child secrets deterministically:
//
//      S_i = keccak256(abi.encodePacked(M, slotIndex_i))
//      H_i = keccak256(abi.encodePacked(S_i))   ← the "hashlock"
//
//  It builds the Merkle tree from leaves:
//      leaf_i = keccak256(bytes.concat(keccak256(abi.encode(H_i, slotIndex_i))))
//              (OZ double-hash format — prevents second-preimage attacks)
//
//  The server only reveals S_i after confirming that a filler has locked
//  sufficient output tokens on Chain B.  That reveal happens in DestChainHTLC.
//
//  FULL FLOW (one slot)
//  --------------------
//   1. Swapper calls createOrder() → WETH locked here via Permit2.
//   2. Server assigns slot i to a filler and gives them H_i.
//   3. Filler calls DestChainHTLC.lock(H_i, swapper, USDC, amount, T2) on Chain B.
//   4. Server confirms the lock is deep enough, calls DestChainHTLC.claim(lockId, S_i).
//      → USDC sent to swapper on Chain B.
//      → S_i emitted in a Claimed event on Chain B.
//   5. Filler reads S_i from Chain B events, calls claimSlot(orderHash, i, S_i, proof).
//      → WETH for slot i sent to filler on Chain A.
//   6. After deadline T1, swapper calls reclaimExpired() for any unfilled slots.
//
//  SECURITY NOTES
//  --------------
//  • Chain A cannot verify Chain B state — trust rests with the KeyDistributor
//    server.  See README_CROSSCHAIN_TEE.md for the TEE hardening path.
//  • outputToken / minOutput are NOT enforced on-chain here.  They are signed
//    by the cosigner so the server commits to only revealing S_i when the filler
//    locked ≥ (minOutput / numSlots) USDC on Chain B.
//  • T2 (Chain B lock expiry) MUST be < T1 (this contract's deadline) so that
//    a filler who refunds on Chain B cannot simultaneously claim on Chain A.

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { IPermit2 } from "../interfaces/IPermit2.sol";
import { SlotLib } from "./libs/SlotLib.sol";

contract CrossChainReactor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Order data (supplied by the swapper when creating an order) ──────────
    struct OrderInfo {
        address swapper;
        address inputToken;   // token to sell on THIS chain (e.g. WETH)
        uint256 inputAmount;  // total amount to sell
        address outputToken;  // token wanted on DEST chain (e.g. USDC) — not enforced here
        uint256 minOutput;    // minimum total output expected — enforced by the server, not here
        uint256 deadline;     // T1 (block number): after this, swapper reclaims unclaimed slots
        uint256 nonce;        // anti-replay: must be unique per swapper
        bytes32 merkleRoot;   // root of the N-leaf tree built by the server
        uint8   numSlots;     // N — must be a power of 2 between 2 and 64
    }

    // ─── What we store per order (only the minimum needed for claims) ─────────
    struct OrderState {
        address  swapper;
        address  inputToken;
        uint256  slotAmount;      // inputAmount / numSlots — what each regular slot pays out
        uint256  lastSlotAmount;  // slot (numSlots-1) gets the remainder from integer division
        uint256  deadline;
        bytes32  merkleRoot;
        uint8    numSlots;
        uint64   claimedCount;   // number of slots claimed so far
        // Bitmap: bit i is set when slot i has been claimed.
        // uint64 has exactly 64 bits — one per slot at our max numSlots.
        uint64   claimedBitmap;
    }

    // ─── EIP-712 setup ────────────────────────────────────────────────────────
    // The cosigner (KeyDistributor server's key) must sign every order.
    // This prevents spam and ensures the server has built the Merkle tree.
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 public constant ORDER_TYPE_HASH = keccak256(
        "CrossChainOrder("
        "address swapper,address inputToken,uint256 inputAmount,"
        "address outputToken,uint256 minOutput,"
        "uint256 deadline,uint256 nonce,bytes32 merkleRoot,uint8 numSlots"
        ")"
    );

    // ─── Immutables ───────────────────────────────────────────────────────────
    IPermit2 public immutable permit2;
    address  public immutable cosigner; // server's signing key; set once at deploy

    // ─── State ────────────────────────────────────────────────────────────────
    mapping(bytes32 => OrderState) private _orders;
    mapping(bytes32 => bool)       private _created; // prevents replay of the same orderHash

    // Tracks which filler has reserved each slot.
    // Set by registerFiller() before the filler deploys on Chain B.
    // Only the registered filler may call claimSlot() — prevents front-running
    // where an MEV bot reads the revealed secret from the mempool and steals the payout.
    mapping(bytes32 => mapping(uint8 => address)) public slotFiller;

    // ─── Events ───────────────────────────────────────────────────────────────
    event OrderCreated(
        bytes32 indexed orderHash,
        address indexed swapper,
        address         inputToken,
        uint256         inputAmount,
        uint8           numSlots,
        uint256         deadline
    );

    // Filler reserves a slot before locking tokens on Chain B.
    event FillerRegistered(
        bytes32 indexed orderHash,
        uint8   indexed slotIndex,
        address indexed filler
    );

    // Emitted when a filler claims their slot.
    // Off-chain indexers use this to confirm partial fills.
    event SlotClaimed(
        bytes32 indexed orderHash,
        uint8   indexed slotIndex,
        address indexed filler,
        uint256         amount
    );

    // Emitted when swapper reclaims WETH from unfilled slots after T1.
    event ExpiredReclaimed(
        bytes32 indexed orderHash,
        address indexed swapper,
        uint256         amount
    );

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _permit2, address _cosigner) {
        require(_permit2  != address(0), "zero permit2");
        require(_cosigner != address(0), "zero cosigner");
        permit2  = IPermit2(_permit2);
        cosigner = _cosigner;

        // DOMAIN_SEPARATOR bakes in address(this) — mirrors how PartialFillReactor does it.
        // The server must recompute this when building cosigner signatures.
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
            keccak256("NeutronX CrossChain"),
            block.chainid,
            address(this)
        ));
    }

    // ─── createOrder ──────────────────────────────────────────────────────────
    /**
     * Swapper calls this to lock their input tokens and register the order.
     *
     * Prerequisites:
     *   - swapper has approved Permit2 to spend inputToken (ERC20 approve)
     *   - Permit2 has been given an allowance for this contract (permit2.approve())
     *   - server has signed the order (cosignerSig) after building the Merkle tree
     *
     * @param info          Full order parameters (see OrderInfo)
     * @param cosignerSig   ECDSA signature by the server over the EIP-712 order hash
     * @return orderHash    Identifies this order in claimSlot / reclaimExpired
     */
    function createOrder(
        OrderInfo calldata info,
        bytes     calldata cosignerSig
    ) external nonReentrant returns (bytes32 orderHash) {
        // ── Basic sanity checks ───────────────────────────────────────────────
        require(info.swapper     == msg.sender,               "not swapper");
        require(info.inputAmount >  0,                        "zero amount");
        require(SlotLib.isPowerOfTwo(info.numSlots),          "numSlots not power of 2");
        require(info.numSlots    <= 64,                       "numSlots too large");
        require(info.deadline    >  block.number,             "deadline in past");
        require(info.merkleRoot  != bytes32(0),               "empty merkle root");

        // ── Cosigner signature check ──────────────────────────────────────────
        // Ensures the server approved this exact order AND built the Merkle tree
        // with this exact root.  Without this, anyone could post a fake root.
        orderHash = _hashOrder(info);
        require(!_created[orderHash], "order already exists");
        _verifyCosignerSig(orderHash, cosignerSig);
        _created[orderHash] = true;

        // ── Precompute slot amounts ───────────────────────────────────────────
        // Integer division truncates; the final slot absorbs the remainder so
        // that sum(slotAmounts) == inputAmount exactly.
        uint256 slotAmount     = info.inputAmount / info.numSlots;
        uint256 lastSlotAmount = info.inputAmount - slotAmount * (info.numSlots - 1);

        // ── Persist order state ───────────────────────────────────────────────
        _orders[orderHash] = OrderState({
            swapper:        info.swapper,
            inputToken:     info.inputToken,
            slotAmount:     slotAmount,
            lastSlotAmount: lastSlotAmount,
            deadline:       info.deadline,
            merkleRoot:     info.merkleRoot,
            numSlots:       info.numSlots,
            claimedCount:   0,
            claimedBitmap:  0
        });

        // ── Pull tokens from swapper via Permit2 ──────────────────────────────
        // Same pattern as PartialFillReactor: swapper pre-approves Permit2, then
        // Permit2.transferFrom pulls the tokens into this contract atomically.
        permit2.transferFrom(
            info.swapper,
            address(this),
            uint160(info.inputAmount),
            info.inputToken
        );

        emit OrderCreated(orderHash, info.swapper, info.inputToken, info.inputAmount, info.numSlots, info.deadline);
    }

    // ─── registerFiller ───────────────────────────────────────────────────────
    /**
     * Filler calls this on Chain A BEFORE deploying their escrow on Chain B.
     *
     * Why this order matters:
     *   When the secret S_i is eventually revealed on Chain B (via escrow.claim()),
     *   it becomes visible in the public mempool before it mines.  Without this
     *   reservation, any MEV bot that sees S_i in the pending reveal tx could
     *   immediately call claimSlot() with higher gas and steal the WETH payout.
     *
     *   By registering first, only this address can call claimSlot() for this slot,
     *   making the front-running attack impossible.
     *
     * Slot reservation is first-come-first-served and cannot be overwritten.
     * If a filler registers but never locks on Chain B, the slot stays reserved
     * until the order deadline — the swapper can reclaim it via reclaimExpired().
     */
    function registerFiller(bytes32 orderHash, uint8 slotIndex) external {
        OrderState storage order = _orders[orderHash];
        require(order.swapper != address(0),         "order not found");
        require(block.number  <= order.deadline,     "order expired");
        require(slotIndex     <  order.numSlots,     "slot index out of range");

        uint64 slotBit = uint64(1) << slotIndex;
        require(order.claimedBitmap & slotBit == 0,  "slot already claimed");
        require(slotFiller[orderHash][slotIndex] == address(0), "slot already registered");

        slotFiller[orderHash][slotIndex] = msg.sender;
        emit FillerRegistered(orderHash, slotIndex, msg.sender);
    }

    // ─── claimSlot ────────────────────────────────────────────────────────────
    /**
     * Filler calls this AFTER the server reveals S_i on Chain B.
     *
     * How the filler gets S_i:
     *   - Watch DestChainHTLC.Claimed events on Chain B for their lockId.
     *   - The Claimed event contains the `secret` field (= S_i) in plaintext.
     *   - Submit that secret here along with the Merkle proof.
     *
     * Leaf format (must match what the server builds off-chain):
     *   hashlock = keccak256(abi.encodePacked(secret))
     *   leaf     = keccak256(bytes.concat(keccak256(abi.encode(hashlock, slotIndex))))
     *
     * The OZ MerkleProof library uses this double-hash format to prevent
     * second-preimage attacks where an attacker could forge a leaf by crafting
     * two adjacent 32-byte nodes that hash to a valid intermediate node.
     *
     * @param orderHash   Returned by createOrder()
     * @param slotIndex   Which slot (0 .. numSlots-1) this filler is claiming
     * @param secret      S_i — the preimage of H_i revealed by the server
     * @param merkleProof Sibling hashes from leaf to root (log2(N) elements)
     */
    function claimSlot(
        bytes32            orderHash,
        uint8              slotIndex,
        bytes32            secret,
        bytes32[] calldata merkleProof
    ) external nonReentrant {
        OrderState storage order = _orders[orderHash];
        require(order.swapper != address(0), "order not found");
        require(block.number  <= order.deadline, "order expired");
        require(slotIndex     <  order.numSlots, "slot index out of range");

        // ── Only the registered filler may claim ──────────────────────────────
        // Prevents MEV bots from front-running the secret reveal on Chain B.
        require(slotFiller[orderHash][slotIndex] == msg.sender, "not registered filler");

        // ── Check the slot hasn't already been claimed ────────────────────────
        // We use a bitmap: bit i of claimedBitmap is 1 iff slot i is claimed.
        // This is O(1) and costs one SLOAD instead of a separate mapping.
        uint64 slotBit = uint64(1) << slotIndex;
        require(order.claimedBitmap & slotBit == 0, "slot already claimed");

        // ── Reconstruct the Merkle leaf and verify the proof ─────────────────
        // Step 1: derive H_i from the secret the filler provided.
        bytes32 hashlock = keccak256(abi.encodePacked(secret));
        // Step 2: build the leaf exactly as the server did off-chain.
        //         The double-hash matches OpenZeppelin's MerkleProof convention.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(hashlock, slotIndex))));
        // Step 3: check the proof against the stored root.
        require(
            MerkleProof.verify(merkleProof, order.merkleRoot, leaf),
            "invalid merkle proof"
        );

        // ── Mark slot as claimed ──────────────────────────────────────────────
        order.claimedBitmap |= slotBit;
        order.claimedCount  += 1;

        // ── Pay the filler ────────────────────────────────────────────────────
        // Last slot gets a slightly different amount due to integer division rounding.
        uint256 amount = (slotIndex == order.numSlots - 1)
            ? order.lastSlotAmount
            : order.slotAmount;

        IERC20(order.inputToken).safeTransfer(msg.sender, amount);

        emit SlotClaimed(orderHash, slotIndex, msg.sender, amount);
    }

    // ─── reclaimExpired ───────────────────────────────────────────────────────
    /**
     * Safety valve: after T1 the swapper reclaims WETH for any slots that were
     * never filled (e.g. the server stalled, or fillers failed to deliver).
     *
     * Can only be called once per order (we mark all slots claimed so a second
     * call finds claimedCount == numSlots and reverts).
     */
    function reclaimExpired(bytes32 orderHash) external nonReentrant {
        OrderState storage order = _orders[orderHash];
        require(order.swapper != address(0), "order not found");
        require(msg.sender    == order.swapper, "not swapper");
        require(block.number  >  order.deadline, "deadline not passed");

        uint64 unclaimed = uint64(order.numSlots) - order.claimedCount;
        require(unclaimed > 0, "all slots already claimed");

        // ── Calculate how much WETH to return ─────────────────────────────────
        // The last slot has lastSlotAmount which may differ from slotAmount.
        // Check whether it was claimed (bit numSlots-1 in the bitmap).
        bool lastClaimed = (order.claimedBitmap & (uint64(1) << (order.numSlots - 1))) != 0;

        // Start with: unclaimed * slotAmount (treating every slot as a regular slot)
        uint256 reclaimAmount = unclaimed * order.slotAmount;

        // If the last slot is one of the unclaimed ones, swap in the correct amount.
        if (!lastClaimed) {
            // Replace the regular slot amount we counted for the last slot with the real amount.
            reclaimAmount = reclaimAmount - order.slotAmount + order.lastSlotAmount;
        }

        // ── Prevent double-reclaim ────────────────────────────────────────────
        // Set all bits so any subsequent call sees claimedCount == numSlots.
        order.claimedBitmap = type(uint64).max;
        order.claimedCount  = uint64(order.numSlots);

        IERC20(order.inputToken).safeTransfer(order.swapper, reclaimAmount);

        emit ExpiredReclaimed(orderHash, order.swapper, reclaimAmount);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function getOrder(bytes32 orderHash) external view returns (OrderState memory) {
        return _orders[orderHash];
    }

    function isSlotClaimed(bytes32 orderHash, uint8 slotIndex) external view returns (bool) {
        OrderState storage order = _orders[orderHash];
        return (order.claimedBitmap & (uint64(1) << slotIndex)) != 0;
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _hashOrder(OrderInfo calldata info) internal pure returns (bytes32) {
        // EIP-712 struct hash — must include every field so the signature covers
        // the full order (especially merkleRoot, which the server constructed).
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

    function _verifyCosignerSig(bytes32 orderHash, bytes calldata sig) internal view {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, orderHash));
        address signer = ECDSA.recover(digest, sig);
        require(signer != address(0) && signer == cosigner, "invalid cosigner sig");
    }
}
