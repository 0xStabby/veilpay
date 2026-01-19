# Required Changes for Privacy-Preserving Flows

This document captures the concrete changes needed for VeilPay to deliver sender/recipient unlinkability guarantees. It complements `docs/privacy.md`, which documents current gaps.

## Critical (must‑fix)

1) **Real note commitments**
- Commitments must be derived from note secrets, not random placeholders.
- Each deposit appends a real commitment to the shielded state tree.

2) **Real Merkle roots**
- `newRoot` must be computed from the commitment tree.
- No random root generation in client flows.

3) **Recipient tags derived from secrets**
- `recipientTagHash` must be derived from a recipient secret, not the public key.
- This prevents trivial linkage by hashing known wallet addresses.

4) **Proofs must spend from real notes**
- Proof inputs must reference a note that exists in the current tree (via Merkle path).
- Random `sender_secret`, `randomness`, and `commitment` in withdraw/transfer flows are invalid for privacy.

5) **Encrypted amounts**
- Ciphertexts must be actual ElGamal encryptions of the amount/tag payload.
- Random bytes are not an acceptable placeholder for privacy claims.

6) **Authorization privacy**
- The relayer intent currently includes `payer` pubkey and signature.
- If the relayer is untrusted, replace this with a privacy-preserving intent scheme (e.g., anonymous signature or a blinded intent relay).

## Important (strongly recommended)

1) **Local note store**
- SDK should maintain local note storage with Merkle paths and nullifier state.
- App should read notes from this store rather than generating fresh secrets per operation.

2) **Root history sync**
- Client must verify that the used root is in on-chain root history.
- Prevents stale or invalid roots from being accepted.

3) **External transfer disclosure**
- External transfer destination ATA is public; this is a known limitation.
- The system should explicitly document that external transfers do not hide recipients.

4) **Relayer policy**
- If relayer is used, define whether it is trusted with payer identity.
- If not trusted, change protocol to avoid revealing payer identity to the relayer.

## Where changes are needed (current app)

- `app/src/lib/flows.ts`
  - `runDepositFlow`: replace random ciphertext/root with real encrypted note + computed root.
  - `runWithdrawFlow`: use real note secrets and merkle proof; avoid random secrets.
  - `runInternalTransferFlow`: real note spend and new commitment; not amount=0 placeholder.
  - `runExternalTransferFlow`: real note spend; still public recipient.
  - `runCreateAuthorizationFlow`: avoid payer identity disclosure if relayer is untrusted.
  - `runSettleAuthorizationFlow`: real note spend and proof.

## Desired end‑state (privacy properties)

- Observers cannot link deposits to withdrawals/transfers by tags or commitments.
- Relayer (if untrusted) cannot link payer to authorization intent.
- External recipients are public, but the source note is hidden.

