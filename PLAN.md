# VeilPay Implementation Plan

Goal: Implement the unlinkable escrow-based privacy payments protocol end-to-end (programs, verifier, SDK, app, tests), with tests proving that the spec and desired functionality are complete and correct.

## Immediate Privacy Requirements (new)
- Replace all placeholder cryptography in app flows with real note commitments, real ciphertexts, and real Merkle roots.
- Ensure recipient tags derive from recipient secrets, not public keys.
- Ensure all proof inputs are tied to existing notes and valid Merkle paths.
- Clarify the privacy model for external transfers (recipient public).
- Add documentation: `docs/privacy.md`.

## Phase 1: Program Core (Anchor)
- Expand `programs/veilpay/src/lib.rs` into modules:
  - `state` (config, vault, shielded state, nullifier, vk registry)
  - `instructions` (initialize/configure/deposit/withdraw/etc.)
  - `errors` (protocol-level errors)
- Implement CPI token transfers for deposit/withdraw/settle flows.
- Add a two‑transaction proof account flow for external transfers (store_proof + external_transfer_with_proof) to avoid tx size limits and allow rent reclaim.
- Add PDA initialization helpers for vaults, shielded state, nullifier chunks, and VK registry.
- Enforce mint allowlist and fee constraints in all public instructions.
- Emit events for: deposit, withdraw, internal transfer.

## Phase 2: Verifier Interface (Stage 1 mock + Stage 2 real)
- Create separate `verifier` program with Groth16 verification using Solana bn254 syscalls.
- Store VK in `verifier_key` PDAs and reference via the registry.
- Add CPI calls to the verifier program from proof-verified instructions.
- Provide a fixture generator for deterministic Groth16 proof bytes.

## Phase 3: SDK (TypeScript)
- Create `sdk/` package:
  - key management (ElGamal keys + note secrets)
  - local Merkle tree mirroring and nullifier calc
  - ciphertext encoding/decoding
  - proof API (WASM/remote backends) with progress callbacks
  - transaction builders for all instructions (Anchor IDL)
  - intent signing for relayer (domain separation)
- Include deterministic fixtures for ciphertext and proof bytes.

## Phase 4: Relayer (Node/TS)
- Create `relayer/` service:
  - endpoints: /intent, /proof, /execute
  - validate signature + intent schema (domain separation)
  - submit transactions and enforce on-chain relayer fee split
  - If relayer is untrusted, support privacy-preserving intents (no payer pubkey disclosure).

## Phase 5: Tests (Must prove spec completeness)
- Anchor tests:
  - initialize/configure
  - deposit/withdraw with mock proofs
  - internal/external transfer
  - nullifier double-spend prevention
  - replay/expiry behavior
- SDK tests:
  - ciphertext roundtrip
  - nullifier calculation matches on-chain chunking
  - tx builder account metas
  - note storage + Merkle path correctness
- Relayer tests:
  - intent signature validation
  - fee enforcement in tx

## Validation Gates
- All tests green locally.
- Spec references match behavior implemented in code and tests.
- No per-user on-chain state; all linkability avoided at state level.
