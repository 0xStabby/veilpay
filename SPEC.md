# VeilPay Protocol Spec (Unlinkable, Escrow-Based, ZK-Enabled)

Executive Summary
- VeilPay is a Solana escrow-based privacy-preserving payments protocol using SPL token vaults owned by PDAs.
- The protocol avoids any per-user on-chain state to prevent linkability across transfers.
- Amount privacy is achieved with ElGamal encryption; correctness is enforced with Groth16 proofs.
- A per-mint shielded state PDA maintains a global commitment tree and root history.
- Nullifiers prevent double spend via a chunked on-chain set.
- Verifying keys are stored in a dedicated verifier program account and versioned via a registry for upgrades.
- Relayers can submit gasless transactions while fees are enforced on-chain (amount split in-program).
- The SDK (TypeScript) orchestrates key management, proofs, and transaction construction.
- The MVP plan phases in encryption and proof verification to manage risk and performance.
- Note outputs are emitted as encrypted events to allow view-key scanning and wallet recovery.

Privacy Assumptions and Guarantees
- Recipient tags are derived from recipient view public keys (Poseidon of pubkey coordinates). Recipients can rotate view keys via indices to reduce linkability.
- Proofs are generated from real notes that exist in the commitment tree (valid Merkle paths).
- Merkle roots are computed from the note tree, not randomized.
- External transfers reveal the destination ATA on-chain; only the source note is hidden.

## Architecture

Text Diagram
- Client SDK (TypeScript)
  - Key management: note keys, ElGamal keypairs, signing keys
  - Local note DB: commitments, nullifiers, Merkle paths
  - Proof generation: Groth16 (WASM) or backend prover
  - Transaction builder (Anchor instructions and account metas)
    -> On-chain Program (Anchor)
      - Config/Vault/Shielded/Nullifier PDAs
      - Proof verification (direct or via verifier program)
      - SPL token vault transfers
        -> SPL Token Program
    -> Relayer/API (Node/TS)
      - Validates intent signatures and schema
      - Submits transactions, pays fees
      - Collects relayer fee on-chain
- Cryptography/Proof Layer
  - ElGamal encryption for amounts and optional tags/memos
  - Groth16 proof generation and verification
  - Proving keys in SDK or backend; verifying keys stored in verifier program PDAs

Component Responsibilities
- Client SDK
  - Generate encryption keys and note secrets.
  - Maintain a local commitment tree mirror for Merkle paths.
  - Create ciphertexts and Groth16 proofs.
  - Construct and sign transactions or relayer intents.
- On-chain Program (Anchor)
  - Enforce escrow, verify proofs, update nullifier set and root history.
  - Manage config, fee policy, and circuit/version registry.
- Relayer/API
  - Submit Solana transactions and collect on-chain relayer fees.
- Verifying Key Registry
  - Store VK references and hashes.
  - Allow multiple circuit versions concurrently.

## On-chain State

PDA Seeds are ASCII byte strings. No per-user PDAs are used.

1) Global Config PDA
- Seeds: ["config", program_id]
- Fields:
  - admin: Pubkey
  - fee_bps: u16
  - relayer_fee_bps_max: u16
  - mint_allowlist: Vec<Pubkey>
  - vk_registry: Pubkey
  - circuit_ids: Vec<u32>
  - paused: bool
  - version: u32

2) Vault/Escrow Pool PDA (per mint)
- Seeds: ["vault", mint_pubkey]
- Fields:
  - vault_pda: Pubkey
  - vault_ata: Pubkey
  - mint: Pubkey
  - total_deposited: u64
  - total_withdrawn: u64
  - nonce: u64

3) Shielded State PDA (per mint, global)
- Seeds: ["shielded", mint_pubkey]
- Fields:
  - mint: Pubkey
  - merkle_root: [u8; 32]
  - root_history: Vec<[u8; 32]> (bounded ring buffer)
  - commitment_count: u64
  - circuit_id: u32
  - version: u32

4) Note Output Events (on-chain logs)
- Emitted on deposit/internal/external when an output note is created.
- Fields: mint, leaf_index, commitment, ciphertext, kind.
- Enables view-key scanning for wallet recovery without a trusted indexer.

5) Nullifier Set PDA (per mint, chunked)
- Seeds: ["nullifier_set", mint_pubkey, chunk_index_u32_le]
- Fields:
  - chunk_index: u32
  - bitset: [u8; 1024] (8192 nullifiers per chunk)
  - count: u32
- Strategy: hash nullifier to (chunk_index, bit_index). Clients include the required chunk accounts when spending notes and may include additional chunk accounts as decoys (padding) to reduce metadata leakage.

6) Verifying Key Registry PDA
- Seeds: ["vk_registry"]
- Fields:
  - entries: Vec<VkEntry>
- VkEntry:
  - circuit_id: u32
  - vk_account: Pubkey
  - vk_hash: [u8; 32]
  - status: u8 (0=active,1=deprecated)

7) Verifier Key PDA (verifier program)
- Program: verifier (separate program ID)
- Seeds: ["verifier_key", key_id_u32_le]
- Fields:
  - alpha_g1: [u8; 64]
  - beta_g2: [u8; 128]
  - gamma_g2: [u8; 128]
  - delta_g2: [u8; 128]
  - public_inputs_len: u32
  - gamma_abc: Vec<[u8; 64]>
  - mock: bool (test-only bypass when syscalls are unavailable)

## Instruction APIs

All account metas specify signer/writable. PDA derivations are checked in-program.

1) initialize_config(admin, fee_bps, relayer_fee_bps_max, vk_registry, allowlist)
- Accounts:
  - config_pda (writable)
  - admin (signer)
  - system_program

2) initialize_vk_registry()
- Accounts:
  - vk_registry_pda (writable)
  - admin (signer)
  - system_program

3) register_mint(mint)
- Accounts:
  - config_pda (writable)
  - admin (signer)

4) initialize_mint_state(mint, vault_ata, chunk_index)
- Accounts:
  - config_pda (read)
  - vault_pda (writable)
  - vault_ata (writable)
  - shielded_state_pda (writable)
  - nullifier_set_pda (writable)
  - admin (signer)
  - mint (read)
  - system_program

5) configure_fees(fee_bps, relayer_fee_bps_max)
- Accounts:
  - config_pda (writable)
  - admin (signer)

6) deposit(amount, ciphertext, commitment)
- Accounts:
  - config_pda (read)
  - vault_pda (writable)
  - vault_ata (writable)
  - shielded_state_pda (writable)
  - user (signer)
  - user_ata (writable)
  - mint (read)
  - token_program
- Behavior: transfer amount to vault ATA; append commitment/ciphertext; update root history.

7) store_proof(nonce, recipient, destination_ata, mint, proof, public_inputs)
- Accounts:
  - proof_account_pda (init, writable; seeds: ["proof", mint, nonce])
  - payer (signer, writable)
  - mint (read)
  - system_program
- Behavior: stores proof + public inputs for two‑tx flows (internal or external).

8) internal_transfer_with_proof(new_root, output_ciphertexts)
- Accounts:
  - config_pda (read)
  - payer (signer, writable)
  - shielded_state_pda (writable)
  - nullifier_set_pda (writable)
  - proof_account_pda (writable, closed to payer)
  - verifier_program (read)
  - verifier_key_pda (read)
  - mint (read)
- Behavior: consumes a note and creates a new commitment; no token movement.

9) external_transfer_with_proof(amount, relayer_fee_bps, new_root, output_ciphertexts, deliver_sol)
- Accounts:
  - config_pda (read)
  - payer (signer, writable)
  - vault_pda (writable)
  - vault_ata (writable)
  - shielded_state_pda (read)
  - nullifier_set_pda (writable)
  - proof_account_pda (writable, closed to payer)
  - destination_ata (writable)
  - recipient (writable)
  - relayer_fee_ata (writable, optional)
  - verifier_program (read)
  - verifier_key_pda (read)
  - mint (read)
  - token_program
- Behavior: amount visible; sender unlinkability preserved via proof. Proof account must match recipient/destination/mint; account is closed after use (rent reclaimed).

10) external_transfer(proof, public_inputs, nullifier, root, amount, relayer_fee_bps, destination_ata)
- Legacy single‑tx variant retained for compatibility; may exceed transaction size limits with real proofs.

12) verifier.initialize_verifier_key(key_id, vk_components)
- Accounts:
  - verifier_key_pda (writable)
  - admin (signer)
  - system_program
- Behavior: stores Groth16 verifying key in EIP-197 byte layout.

Two-step external flow (preferred)
- store_proof(...) -> creates proof_pda
- external_transfer_with_proof(...) -> consumes proof_pda and closes it

## Cryptography

ElGamal Encryption
- Encrypts: amount (u64), optional memo/tag hash.
- Ciphertext format: [u8; 32] R || [u8; 32] C (compressed points).
- Byte order: big-endian for scalars and compressed points.

Commitments and Roots
- Commitment = Poseidon(amount, randomness, recipient_view_pubkey_hash).
- Merkle root stored in [u8; 32] big-endian.
- Root history stored as a bounded ring buffer.
- Instruction args carry byte arrays; the program enforces exact lengths (32/64) before storing fixed-size arrays on-chain.

Groth16 Circuit Statement
- Public inputs:
  - root
  - nullifier
  - recipient_tag_hash or destination_pubkey_hash
  - ciphertext_commitment (hash of ciphertext)
  - fee_params (fee_bps, relayer_fee_bps)
  - circuit_id
- Private inputs:
  - amount
  - randomness
  - sender_secret
  - merkle_path
  - ciphertext

Proof Encoding
- proof = G1(A) || G2(B) || G1(C) (256 bytes total).
- G1 encoding: x(32) || y(32) big-endian.
- G2 encoding: x_im(32) || x_re(32) || y_im(32) || y_re(32) big-endian (EIP-197 layout).
- public_inputs = concat of 32-byte big-endian scalars in circuit order.

Constraints
- amount in [0, 10^decimals * max] within u64.
- fee calculation fits u64, no overflow.
- nullifier = H(note_secret, merkle_leaf_index).
- ciphertext matches ElGamal(amount, recipient_key).

Verifying Key Management
- VKs stored in verifier program `verifier_key` PDAs; registry entries point to key accounts + hash.
- circuit_id selects VK via registry entry in config.
- Upgrade: add new circuit ID and keep old VKs active for existing notes.
- Deprecation: mark circuit deprecated; allow spends but disallow new deposits.

## Threat Model

Privacy Provided
- Amount hiding for internal transfers.
- Sender unlinkability for external transfers via nullifier/proof.
- Recipient privacy for internal transfers only.

Not Provided
- On-chain metadata privacy (accounts, program IDs).

Replay Protection
- Nullifier set ensures single spend.

Double-spend Prevention
- Nullifier stored in chunked bitset or sparse map.
- Check + write in same instruction.

Relayer Trust Assumptions
- Relayer fee enforced on-chain via amount split and max fee bps; relayer fee ATA required when fee > 0.

Key Management
- Users hold encryption keys and note secrets off-chain.
- Rotation creates new notes; old notes remain spendable.
- Circuit upgrades via registry with multiple active circuits.

## MVP Plan

Stage 0: Escrow (plaintext)
- Implement vaults and external transfers with plaintext amounts.
- Tests: Anchor program tests for accounting invariants.

Stage 1: Add ElGamal + mock verifier
- Store ciphertexts and commitments.
- Mock verifier accepts precomputed proofs.
- Deterministic fixtures for ciphertext/proof bytes.

Stage 2: Real Groth16 verification
- Integrate Groth16 verifier program using Solana bn254 syscalls (`solana-bn254`).
- Store VK in `verifier_key` PDAs and pass them into proof-verified instructions.
- Track compute budget and proof size constraints.
- Use circuit IDs and VK registry for upgrades.
- Tests may set `verifier_key.mock=true` when syscalls are unavailable in local validators.

Stage 3: SDK proof generation
- Browser WASM prover path with progress callbacks.
- Optional backend prover with caching of proving keys.
- Cancellation and caching support in SDK.

## Relayer Outline

Endpoints
- POST /proof: upload proof bytes.
- POST /execute: submit tx, charge relayer fee.

On-chain Fee Enforcement
- Relayer fee is capped on-chain and the vault transfer is split into fee + net.
- Relayer fee recipient ATA is required when fee_bps > 0.

## Test Strategy

- Anchor local validator tests for each instruction.
- Deterministic fixtures for ciphertext and proofs.
- Mock verifier for Stage 1; real verifier integration for Stage 2.
