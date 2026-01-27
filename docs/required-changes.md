# Required Changes for Privacy-Preserving Flows

This document captures the concrete changes needed for VeilPay to deliver sender/recipient unlinkability guarantees. It complements `docs/privacy.md`, which documents current gaps.

## Completed

1) **Real note commitments**
- Commitments are derived from note secrets.
- Deposits append a real commitment to the local Merkle tree and update on-chain root.

2) **Real Merkle roots**
- `newRoot` is computed from the commitment tree.
- Flows verify the on-chain root matches the local tree before proceeding.

3) **Recipient tags derived from view public keys**
- `recipientTagHash` is derived from the recipient view public key (Poseidon of pubkey coords).

4) **Proofs spend from real notes**
- Proof inputs reference a note in the local tree (with Merkle path).
- Withdraw/transfer flows use stored secrets, not random placeholders.

5) **Local note store**
- App maintains local notes and derives Merkle paths for proofs.

6) **Root history checks**
- Flows verify the current root against on-chain state before proving.


## Remaining / partial

1) **View key distribution**
- Senders must know a recipient’s public view key to encrypt internal transfers.
- Provide UX / directory for sharing public view keys (optional on-chain registry or off-chain exchange).


## External transfer disclosure

- External transfer destination ATA is public; this is a known limitation.
- The system should explicitly document that external transfers do not hide recipients.

## Desired end‑state (privacy properties)

- Observers cannot link deposits to withdrawals/transfers by tags or commitments.
- External recipients are public, but the source note is hidden.
