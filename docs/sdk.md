# VeilPay SDK Guide

This guide describes how to use the SDK primitives and how they map to the on‑chain programs. The SDK is intentionally low‑level; the app composes these pieces into end‑user flows.

## Contents

- Overview
- Environment requirements
- Key concepts
- Primitive APIs
- Example flows
- Proof account (two‑transaction) flow
- Scanning notes and identity registry
- Common pitfalls

## Overview

The SDK focuses on:

- Note creation and encryption (BabyJub ECIES)
- Merkle trees and paths for commitments
- PDA derivation
- Instruction builders for deposits/withdrawals
- Local note and commitment storage (browser)
- Log scanners for note outputs and identity registry

The SDK does **not**:

- Generate Groth16 proofs end‑to‑end
- Provide complete transfer flows (internal/external)
- Manage LUTs or relayer interactions

These are handled in the app and tests.

## Environment requirements

The SDK assumes:

- `localStorage` for note + commitment caching
- `crypto.getRandomValues` and `crypto.subtle` (WebCrypto)

For Node.js, supply polyfills or wrap the SDK.

## Key concepts

### Notes

A note is the private state being spent. Each note includes:

- amount
- randomness
- recipient tag hash
- sender secret
- commitment
- ECIES ciphertext (c1/c2)

The on‑chain program sees commitments and ciphertexts only.

### Commitments and Merkle roots

The SDK builds Poseidon‑based Merkle trees:

- `buildMerkleTree(leaves)` returns root and levels.
- `getMerklePath(leaves, index)` returns a path for proving inclusion.

### Nullifiers

Nullifiers prevent double spends:

- `computeNullifier(senderSecret, leafIndex)` in `prover.ts`.

### Proof accounts (two‑transaction flow)

Groth16 proofs are large; transfers use:

1) `store_proof` — uploads proof + public inputs to a PDA.
2) `*_transfer_with_proof` — consumes and closes the PDA.

Use `deriveProofAccount(programId, owner, nonce)` to compute the PDA address.

## Primitive APIs

### PDA helpers (`pda.ts`)

```ts
deriveConfig(programId)
deriveVault(programId, mint)
deriveShielded(programId, mint)
deriveIdentityRegistry(programId)
deriveIdentityMember(programId, owner)
deriveNullifierSet(programId, mint, chunkIndex)
deriveVerifierKey(verifierProgramId, keyId)
deriveProofAccount(programId, owner, nonce)
```

### Notes (`notes.ts`)

```ts
createNote({ mint, amount, recipientTagSecret, leafIndex })
deriveRecipientKeypair(secret)
eciesEncrypt({ recipientPubkey, amount, randomness })
eciesDecrypt({ recipientSecret, c1x, c1y, c2Amount, c2Randomness })
recipientTagHashFromSecret(secret)
```

### Note store (`noteStore.ts`)

Browser localStorage helpers:

```ts
loadNotes / saveNotes / replaceNotes
loadCommitments / saveCommitments / appendCommitmentIfComplete
listSpendableNotes / selectNotesForAmount / markNoteSpent
buildOutputCiphertexts(notes, outputEnabled)
```

### Merkle (`merkle.ts`)

```ts
buildMerkleTree(leaves, depth?)
getMerklePath(leaves, index, depth?)
```

### Prover helpers (`prover.ts`)

```ts
computeCommitment(amount, randomness, recipientTagHash)
computeNullifier(senderSecret, leafIndex)
computeIdentityCommitment(identitySecret)
bigIntToBytes32(value)
```

### Identity helpers (`identity.ts`)

```ts
getOrCreateIdentitySecret(owner, programId, signMessage?)
getIdentityCommitment(owner, programId, signMessage?)
getIdentityMerklePath(owner, programId, signMessage?)
```

### Scanners

```ts
rescanNotesForOwner(...)           // noteScanner.ts
rescanIdentityRegistry(...)        // identityScanner.ts
```

## Example flows

### Deposit (single‑tx)

1) Create a note and ciphertext.
2) Update the Merkle root locally.
3) Submit `deposit` with commitment + ciphertext + new root.

See `sdk/README.md` for a minimal snippet.

### Internal transfer (two‑tx proof)

1) Build proof inputs from local notes + Merkle path.
2) Upload proof via `store_proof`.
3) Call `internal_transfer_with_proof` with new root + output ciphertexts.

The SDK provides all primitives to compute commitments, paths, and output ciphertexts. The app demonstrates a full end‑to‑end flow in `app/src/lib/flows.ts`.

### External transfer (two‑tx proof)

Same as internal transfer, but:

- Transfers tokens to a public destination ATA.
- Uses `external_transfer_with_proof`.

## Proof account flow details

The proof PDA is derived as:

```
["proof", proof_owner, nonce]
```

The program validates:

- proof account owner
- mint
- (for external) recipient + destination ATA

The proof account is closed after use to reclaim rent.

## Common pitfalls

- Missing `crypto.subtle` or `crypto.getRandomValues` in Node.
- Note store out of sync with on‑chain `commitment_count`.
- External transfers are public by design (destination ATA is on‑chain).
- Nullifier chunk accounts may leak coarse metadata unless padding is used.

