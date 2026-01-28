# VeilPay SDK

Lightweight primitives for VeilPay notes, Merkle trees, PDAs, and on-chain instructions. This SDK is intentionally low-level; the app builds full flows on top of it.

## Install / use

This repo is a workspace. Import from `sdk/src` in local code, or wire it into your build as needed.

## Quick start (deposit)

```ts
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  VeilpayClient,
  createNote,
  buildMerkleTree,
  bigIntToBytes32,
  deriveConfig,
  deriveVault,
  deriveShielded,
} from "../sdk/src";

const program: Program = /* anchor program */;
const provider: AnchorProvider = /* anchor provider */;
const client = await VeilpayClient.fromAnchor(program, provider);

const mint = new PublicKey("So11111111111111111111111111111111111111112");
const amount = 1_000_000n;
const recipientTagSecret = crypto.getRandomValues(new Uint8Array(32));

// Create note + ciphertext.
const { note, plaintext } = await createNote({
  mint,
  amount,
  recipientTagSecret,
  leafIndex: 0,
});

// Compute new Merkle root.
const { root } = await buildMerkleTree([note.commitment]);

// Build deposit ix.
const ix = await client.buildDepositIx({
  amount,
  ciphertext: plaintext,
  commitment: bigIntToBytes32(note.commitment),
  newRoot: bigIntToBytes32(root),
  config: deriveConfig(program.programId),
  vault: deriveVault(program.programId, mint),
  vaultAta: /* vault ATA */,
  shieldedState: deriveShielded(program.programId, mint),
  userAta: /* user ATA */,
  mint,
});
```

## Proof account flow (two transactions)

Real Groth16 proofs are large; the app uses a two‑tx flow:

1) `store_proof` — upload proof + public inputs to a PDA.
2) `internal_transfer_with_proof` / `external_transfer_with_proof` — consume the PDA (closed to owner).

Use `deriveProofAccount(programId, owner, nonce)` to compute the PDA. The SDK does not currently expose a high‑level helper for this, but the PDA helper is available.

## Withdraw vs external transfer

The app treats “Withdraw” as an external transfer **to the current wallet**. If you want a single public “cash out” path, use `external_transfer_with_proof` with `recipient = owner`.

## Module overview

- `client.ts` — `VeilpayClient` for building deposit instructions.
- `pda.ts` — PDA helpers (config, vault, shielded, nullifier set, verifier key, proof account).
- `notes.ts` — note creation + ECIES encryption primitives.
- `noteStore.ts` — localStorage‑backed note/commitment cache (browser).
- `merkle.ts` — Poseidon‑based Merkle tree and path helpers.
- `prover.ts` — Poseidon + commitment + nullifier helpers.
- `identity.ts` — identity secret + commitment helpers (browser).
- `noteScanner.ts` / `identityScanner.ts` — parse on‑chain logs and reconstruct notes/identity state.

## Runtime assumptions

- Browser environment with `localStorage` and `crypto.getRandomValues`.
- For Node.js, provide WebCrypto and storage polyfills or wrap the SDK.
