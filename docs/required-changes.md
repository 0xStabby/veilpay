# Required Changes for Privacy-Preserving Flows

This document captures the concrete changes needed for VeilPay to deliver sender/recipient unlinkability guarantees. It complements `docs/privacy.md`, which documents current gaps.

## Completed

1) **Real note commitments**
- Commitments are derived from note secrets.
- Deposits append a real commitment to the local Merkle tree and update on-chain root.

2) **Real Merkle roots**
- `newRoot` is computed from the commitment tree.
- Flows verify the on-chain root matches the local tree before proceeding.

3) **Recipient tags derived from secrets**
- `recipientTagHash` is derived from a local recipient tag secret, not from a public key.

4) **Proofs spend from real notes**
- Proof inputs reference a note in the local tree (with Merkle path).
- Withdraw/transfer flows use stored secrets, not random placeholders.

5) **Local note store**
- App maintains local notes and derives Merkle paths for proofs.

6) **Root history checks**
- Flows verify the current root against on-chain state before proving.

7) **Relayer policy toggle**
- `RELAYER_TRUSTED=true` allows submitting intents without payer identity.

## Remaining / partial

1) **ElGamal encryption**
- Ciphertexts are currently a symmetric stream derived from the recipient tag secret.
- Replace this with real ElGamal encryption and recipient key exchange for production privacy.

2) **Recipient secret exchange**
- Secrets are local; there is no out-of-band exchange for unrelated wallets.
- This needs a real key distribution mechanism for external recipients.

3) **Relayer anonymity vs chain visibility**
- Even in trusted relayer mode, the payer is still a signer on-chain.
- A full anonymity scheme would require a different protocol (not just relayer changes).

## External transfer disclosure

- External transfer destination ATA is public; this is a known limitation.
- The system should explicitly document that external transfers do not hide recipients.

## Desired end‑state (privacy properties)

- Observers cannot link deposits to withdrawals/transfers by tags or commitments.
- Relayer (if untrusted) cannot link payer to authorization intent.
- External recipients are public, but the source note is hidden.
