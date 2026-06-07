// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
//  EscrowDstFactory  —  deploys isolated EscrowDst clones via EIP-1167 + CREATE2
// ─────────────────────────────────────────────────────────────────────────────
//
//  FILLER FLOW (no ERC-20 approval required)
//  ──────────────────────────────────────────
//  Step 1  off-chain:  escrowAddr = factory.computeAddress(H_i, filler)
//  Step 2  on-chain:   USDC.transfer(escrowAddr, amount)
//                        tokens land at the precomputed address before
//                        the clone contract exists there
//  Step 3  on-chain:   factory.deploy(H_i, swapper, USDC, amount, T2)
//                        deploys the clone, initialize() verifies balance
//
//  WHY CREATE2?
//  ────────────
//  CREATE2 makes the address deterministic from (implementation, salt).
//  salt = keccak256(H_i, filler) so:
//    • different fillers filling the same slot → different addresses
//    • same filler re-deploying the same hashlock → collision → reverts
//      (each slot should be filled exactly once)

import { Clones }    from "@openzeppelin/contracts/proxy/Clones.sol";
import { EscrowDst } from "./EscrowDst.sol";

contract EscrowDstFactory {

    address public immutable implementation; // EscrowDst logic contract

    event EscrowCreated(
        address indexed escrow,     // clone address (unique per fill)
        address indexed filler,     // who deployed (and funded) this escrow
        bytes32 indexed hashlock,   // H_i — links to the Merkle slot on Chain A
        address recipient,          // swapper — receives USDC when claimed
        address token,
        uint256 amount,
        uint256 expiry              // T2 block number
    );

    constructor(address _implementation) {
        require(_implementation != address(0), "zero impl");
        implementation = _implementation;
    }

    // ── deploy ──────────────────────────────────────────────────────────────────
    /**
     * Deploys an EscrowDst clone for slot fill i.
     * Filler must have already transferred `amount` tokens to computeAddress().
     *
     * @param hashlock   H_i from the order's Merkle tree leaf
     * @param recipient  Swapper address (receives output tokens when S_i is revealed)
     * @param token      Output token (e.g. USDC on Chain B)
     * @param amount     Must match ≥ minOutput / numSlots
     * @param expiry     T2 block — filler can refund() after this if no claim
     * @return escrow    Address of the newly deployed clone
     */
    function deploy(
        bytes32 hashlock,
        address recipient,
        address token,
        uint256 amount,
        uint256 expiry
    ) external returns (address escrow) {
        bytes32 salt = keccak256(abi.encodePacked(hashlock, msg.sender));
        escrow = Clones.cloneDeterministic(implementation, salt);

        // initialize() verifies the clone already holds `amount` tokens
        EscrowDst(escrow).initialize(hashlock, msg.sender, recipient, token, amount, expiry);

        emit EscrowCreated(escrow, msg.sender, hashlock, recipient, token, amount, expiry);
    }

    // ── computeAddress ──────────────────────────────────────────────────────────
    /**
     * Returns the address the clone WILL be deployed to.
     * Filler calls this off-chain, then sends tokens there before calling deploy().
     *
     * @param hashlock  H_i for the slot being filled
     * @param filler    Address that will call deploy() (msg.sender of that call)
     */
    function computeAddress(bytes32 hashlock, address filler)
        external view returns (address)
    {
        bytes32 salt = keccak256(abi.encodePacked(hashlock, filler));
        return Clones.predictDeterministicAddress(implementation, salt);
    }
}
