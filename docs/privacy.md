# VeilPay Privacy Analysis (App Flows)

This document explains what is (and is not) anonymous in the current app flows. It reflects the code in `app/src/lib/flows.ts` and the local note store in `app/src/lib/notes.ts`.

## TL;DR

- **Deposits/withdrawals/transfers now use real note data and Merkle paths**, so proofs are tied to actual notes.
- **Recipient tags are derived from secrets**, not public keys.
- **External transfers are still public by design**, because the destination ATA is on‑chain.
- **Ciphertext encryption is still a lightweight symmetric scheme**, not full ElGamal, so the cryptographic privacy story is incomplete.

## What the current flows do

### Deposit (`runDepositFlow`)

Key behaviors:
- Creates a real note (amount/randomness/recipient tag secret).
- Computes commitment and new Merkle root locally.
- Checks that the on‑chain root matches the local tree before updating.
- Encrypts note plaintext to a 64‑byte ciphertext blob.

Privacy impact:
- **Commitments are real** and tied to a private tag secret.
- **Recipient tags are not linkable** by public key hashing.

### Withdraw (`runWithdrawFlow`)

Key behaviors:
- Spends an existing local note.
- Builds a Merkle path for that note and proves membership.
- Verifies the on‑chain root matches the local tree.
- Uses real nullifier derived from sender secret + leaf index.

Privacy impact:
- **Source note is hidden** (membership proof with nullifier).
- **Recipient is public** (destination ATA is on‑chain).

### Internal transfer (`runInternalTransferFlow`)

Key behaviors:
- Spends an existing note and creates a new note for the recipient.
- Computes path and new root locally, verifies on‑chain root.
- Adds the new note to local storage.

Privacy impact:
- **Source note is hidden** by proof.
- **Recipient tag is secret‑derived**.

### External transfer (`runExternalTransferFlow`)

Key behaviors:
- Proves spend from a real note.
- Sends tokens to the recipient ATA on‑chain.

Privacy impact:
- **Not anonymous**. Destination ATA is public.

## What is still not fully privacy‑preserving

- **Ciphertext scheme is not ElGamal**. It is a symmetric stream derived from the recipient tag secret. This is not the same privacy guarantee as ElGamal and does not interoperate with external wallets.
- **Recipient tag secrets are local**. There is no secure exchange of secrets between unrelated wallets.
- **No on‑chain commitment store**. The client maintains the note set locally and must stay in sync with `commitment_count` and `merkle_root`.

## External transfers: what can and cannot be hidden

Even with perfect private notes and proofs:
- **External transfers are still public** because the destination ATA is a public account and the token transfer is visible.
- The private portion can only hide the **source** (which note funded the transfer), not the destination.

## Summary

The flows now use real notes and Merkle proofs, which fixes the biggest privacy bugs. The remaining gaps are cryptographic (ElGamal), key exchange, and the inherent visibility of external recipients.
