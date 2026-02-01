# VeilPay

VeilPay is an escrow‑based privacy pool on Solana.

Users deposit SPL tokens into a per‑mint vault PDA and receive encrypted note outputs. Each note is committed into a global per‑mint shielded Merkle tree. Spends prove membership and prevent double‑spend via nullifiers stored on‑chain in chunked bitsets. Correctness and amount privacy use Groth16 proofs with ElGamal‑encrypted amounts.

Internal transfers create new encrypted notes without moving tokens, enabling unlinkable transfers similar to Monero’s view‑key model. View keys are used to derive recipient tags and decrypt note ciphertexts. External withdrawals reveal the destination ATA on‑chain but keep the source note private.

The system includes an on‑chain verifier key registry, a relayer for gasless submissions, a TypeScript SDK for key management/proof generation/transaction assembly, and a web app for end‑to‑end testing. No sponsor technologies were used.


## What this repo includes

- `app/` - Vite web app for user flows and multi-wallet testing.
- `programs/` - Anchor programs (`veilpay`, `verifier`).
- `relayer/` - Node relayer that validates intents and submits transactions.
- `sdk/` - TypeScript client helpers and PDA derivations.
- `sdk/README.md` - SDK quickstart and module overview.
- `circuits/` - Groth16 circuits and artifacts.
- `scripts/` - Devnet setup, deployment, and maintenance scripts.
- `SPEC.md` - Protocol spec and on-chain state details.
- `docs/sdk.md` - Detailed SDK guide and flow examples.

## Quickstart (web app)

1) Install dependencies:
```
pnpm install
```

2) Configure app env (example in `app/.env.devnet`):
```
VITE_RPC_ENDPOINT=...
VITE_RELAYER_URL=...
VITE_VEILPAY_PROGRAM_ID=...
VITE_VERIFIER_PROGRAM_ID=...
VITE_AIRDROP_URL=...   # optional, faucet link
VITE_NULLIFIER_PADDING_CHUNKS=0  # optional, number of decoy nullifier chunks to include
```

Notes:
- `VITE_NULLIFIER_PADDING_CHUNKS` controls how many nullifier chunk accounts are included as decoys in each spend. Higher values improve privacy but increase transaction size.
- Multi-input spends require the address lookup table (LUT) to include any nullifier chunk accounts referenced by the transaction. Use `scripts/admin-bootstrap.ts` to create the LUT and initialize the padding chunks.

Extending the LUT for new nullifier chunks:
```sh
pnpm exec ts-node scripts/extend-nullifier-lut.ts --env .env --start 0 --count 32
```

Relayer auto-extend (optional):
- Set `RELAYER_LUT_ADDRESS` to the LUT address.
- Set `RELAYER_LUT_AUTHORITY_KEYPAIR` (or reuse `RELAYER_KEYPAIR`) so the relayer can extend the LUT when a transaction is too large.

3) Run the app:
```
pnpm --filter app dev --mode devnet
```

## User guide (app)

The app has two primary areas:
- **User**: single-wallet deposit/transfer flows (tabbed).
- **Multi-Wallet Test**: generates local wallets to test unlinkability end-to-end.

Recommended flow for users:
1) **Deposit**: moves WSOL from your wallet into the shielded pool.
2) **Withdraw**: external transfer to your own wallet.
3) **Transfers**: internal (VeilPay to VeilPay) or external (to any wallet).

Notes:
- Proof generation runs in-browser and can take a few seconds.
- The multi-wallet tester uses local keypairs stored in localStorage.
- On devnet, keep your mint set to WSOL.

## Dev integration

### Programs
- Programs live in `programs/veilpay` and `programs/verifier`.
- IDLs are in `target/idl/` after building.
- The verifier key is stored on-chain via the `verifier` program.

### SDK (TypeScript)

The SDK lives in `sdk/` and provides PDA helpers plus instruction builders.

Example usage:
```ts
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { VeilpayClient, deriveConfig, deriveVault, deriveShielded } from './sdk/src';

const provider = AnchorProvider.env();
const program = new Program(idl, programId, provider);
const client = await VeilpayClient.fromAnchor(program, provider);

const config = deriveConfig(programId);
const vault = deriveVault(programId, mint);
const shielded = deriveShielded(programId, mint);

const ix = await client.buildDepositIx({
  amount,
  ciphertext,
  commitment,
  newRoot,
  config,
  vault,
  vaultAta,
  shieldedState: shielded,
  userAta,
  mint,
});
```

### Relayer

The relayer lives in `relayer/` and exposes:
- `GET /health` for health checks
- `POST /execute-relayed` for relayer-signed transaction execution
- `POST /proof` for proof generation

Deploy scripts:
- `./scripts/relayer-provision.sh`
- `./scripts/relayer-redeploy.sh`

## Devnet setup scripts

Common workflows:
```
./scripts/setup-devnet.sh --reset-keys
./scripts/deploy-all-devnet.sh
./scripts/update-all-devnet.sh
```

## Protocol details

See `SPEC.md` for architecture, PDA layout, and instruction APIs.
