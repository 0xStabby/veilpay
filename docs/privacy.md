# VeilPay Privacy Analysis (App Flows)

This document explains what is (and is not) anonymous in the current app flows. It is based on the implementations in `app/src/lib/flows.ts` and is intentionally explicit about privacy gaps.

## TL;DR

- **Today’s app flows are not fully privacy‑preserving.** Several values are generated with random bytes, and some tags are derived directly from public keys, which makes transactions linkable.
- **External transfers are not anonymous by design**, because the destination associated token account (ATA) is a public on‑chain address.
- **Authorizations are not anonymous for the relayer**, because the intent includes the payer’s public key and a wallet signature.

If you need strong privacy guarantees, the flows must be adjusted to use real note commitments, real Merkle roots, and recipient tags derived from secrets rather than public keys.

## What the current flows do

### Deposit (`runDepositFlow`)

Key behaviors:
- Uses `randomBytes(64)` for ciphertext (not real encrypted amounts).
- Sets `newRoot` as random bytes (not a computed Merkle root).
- `recipientTagHash` is computed from `sha256(publicKey)` (public info).

Privacy impact:
- **Linkable recipient tag**: hashing a public key does not hide the recipient from anyone who can compute the same hash. If a watcher knows the wallet, they can match the tag.
- **No real note tracking**: the commitment is not tied to a user secret or on‑chain note set; it is a random value plus public tag.

### Withdraw (`runWithdrawFlow`)

Key behaviors:
- Creates a new random note (secret/randomness) at withdrawal time.
- The destination ATA is on‑chain and public.

Privacy impact:
- **Recipient is public** (destination ATA is a public address).
- **No linkage to an actual deposited note** because the proof inputs use random secrets and a random commitment instead of a note derived from a prior deposit.

### Internal transfer (`runInternalTransferFlow`)

Key behaviors:
- Transfer amount is hardcoded to `0n`.
- Commitment and nullifier use random values at transfer time.
- `recipientTagHash` is derived from the recipient’s public key.

Privacy impact:
- **Recipient tag is linkable** (hash of public key).
- **No spend from a real note** (random commitment instead of a stored note).

### External transfer (`runExternalTransferFlow`)

Key behaviors:
- Creates destination ATA for the recipient.
- The destination ATA is explicitly included in the on‑chain instruction.

Privacy impact:
- **Not anonymous**. The recipient’s ATA is on‑chain, so the recipient is visible.

### Authorization create / settle

Key behaviors:
- `intentHash` includes `mint`, `payeeTagHash`, `amountCiphertext`, and `expirySlot`.
- The **relayer intent includes the payer public key and wallet signature**.
- `payeeTagHash` is computed from the payee’s public key.

Privacy impact:
- **Relayer sees payer identity** (payer public key + signature).
- **Payee tag is linkable** (hash of payee public key).
- Settlement uses the payee’s ATA on‑chain, so the recipient is visible in the settle transaction.

## Why this is not “provably anonymous” today

The current app flows use random values instead of a persistent note set and do not use a private, recipient‑specific tag. As a result:

- A watcher can associate deposits/transfers to recipients by recomputing tags from public keys.
- Withdrawals/external transfers reveal the recipient’s ATA on‑chain.
- Proofs are not connected to a real deposited note; they demonstrate internal consistency but not membership in the actual note set.

These properties mean it is **not valid** to claim sender‑recipient unlinkability for these flows as‑implemented.

## What would be required for strong privacy

At a minimum:

- **Recipient tags must derive from recipient secrets**, not public keys (e.g., `H(recipient_secret)`).
- **Ciphertexts must be real ElGamal encryptions** of amount and tag data, not random bytes.
- **Commitments must be computed from actual note data** and appended to the Merkle tree.
- **Proofs must spend from a real note** that is in the Merkle tree, not from random values.
- **Roots must be computed** from the commitment tree state, not random.
- **Authorization intent should avoid revealing payer identity** if the relayer is untrusted, e.g., using anonymous signatures or a separate intent system.

## External transfers: what can and cannot be hidden

Even with perfect private notes and proofs:
- **External transfers are still public** because the destination ATA is a public account and the token transfer is visible.
- The private portion can only hide the **source** (which note funded the transfer), not the destination.

## Summary

The current UI flows are great for testing the on‑chain paths and relayer logic, but they are not yet privacy‑preserving. If you need “impossible to tell who is sending to who,” the app needs the privacy fixes above before that claim is valid.
