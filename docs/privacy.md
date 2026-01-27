# VeilPay Privacy Analysis (App Flows)

This document explains what is (and is not) anonymous in the current app flows. It reflects the code in `app/src/lib/flows.ts` and the local note store in `app/src/lib/notes.ts`.

## TL;DR

- **Deposits/withdrawals/transfers now use real note data and Merkle paths**, so proofs are tied to actual notes.
- **Recipient tags are derived from public view keys** (Poseidon of the view pubkey coordinates).
- **External transfers are still public by design**, because the destination ATA is on‑chain.
- **Encrypted note outputs are emitted on-chain** to enable view‑key scanning and wallet recovery.
- **Ciphertexts use ECIES-style encryption on BabyJub** (DH shared secret + masking). Recipients need the private view key to decrypt.
- **Nullifier sets are stored in paged on-chain accounts**; the account list can reveal which nullifier chunk was touched unless padding is used.

## What the current flows do

### Deposit (`runDepositFlow`)

Key behaviors:
- Creates a real note (amount/randomness/recipient tag hash).
- Computes commitment and new Merkle root locally.
- Checks that the on‑chain root matches the local tree before updating.
- Encrypts note plaintext to a 64‑byte ciphertext blob.

Privacy impact:
- **Commitments are real** and tied to the recipient view public key hash.
- **Recipient tags are linkable per view key**; recipients can rotate view keys (index-based) to reduce linkability.

### Withdraw (`runWithdrawFlow`)

Key behaviors:
- Spends an existing local note.
- Builds a Merkle path for that note and proves membership.
- Verifies the on‑chain root matches the local tree.
- Uses real nullifier derived from sender secret + leaf index.

Privacy impact:
- **Source note is hidden** (membership proof with nullifier).
- **Recipient is public** (destination ATA is on‑chain).
- **Nullifier chunk accounts are visible** in the transaction; padding can reduce metadata leakage but increases size.

### Internal transfer (`runInternalTransferFlow`)

Key behaviors:
- Spends an existing note and creates a new note for the recipient.
- Computes path and new root locally, verifies on‑chain root.
- Adds the new note to local storage.

Privacy impact:
- **Source note is hidden** by proof.
- **Recipient tag is derived from the recipient view public key**.

### External transfer (`runExternalTransferFlow`)

Key behaviors:
- Proves spend from a real note.
- Sends tokens to the recipient ATA on‑chain.

Privacy impact:
- **Not anonymous**. Destination ATA is public.
 - **Nullifier chunk accounts are visible** (unless padded), which may leak coarse metadata about which nullifier bucket was touched.

## What is still not fully privacy‑preserving

- **Ciphertext scheme uses public view keys**. Senders must know a recipient’s public view key to encrypt.
- **View keys can be rotated** by using different indices (subaddresses).
- **No on‑chain commitment store**. The client maintains the note set locally and must stay in sync with `commitment_count` and `merkle_root`.

## External transfers: what can and cannot be hidden

Even with perfect private notes and proofs:
- **External transfers are still public** because the destination ATA is a public account and the token transfer is visible.
- The private portion can only hide the **source** (which note funded the transfer), not the destination.

## Summary

The flows now use real notes and Merkle proofs, which fixes the biggest privacy bugs. The remaining gaps are cryptographic (ElGamal), key exchange, and the inherent visibility of external recipients.
