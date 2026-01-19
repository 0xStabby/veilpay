# VeilPay

VeilPay is a Solana privacy-preserving payments protocol that uses escrow vaults, nullifiers, and Groth16 proofs to enable unlinkable transfers. This repo contains the on-chain programs, relayer, SDK, circuits, and a web app for testing flows.

## What this repo includes

- `app/` - Vite web app for user flows and multi-wallet testing.
- `programs/` - Anchor programs (`veilpay`, `verifier`).
- `relayer/` - Node relayer that validates intents and submits transactions.
- `sdk/` - TypeScript client helpers and PDA derivations.
- `circuits/` - Groth16 circuits and artifacts.
- `scripts/` - Devnet setup, deployment, and maintenance scripts.
- `SPEC.md` - Protocol spec and on-chain state details.

## Quickstart (web app)

1) Install dependencies:
```
pnpm install
```

2) Configure app env (example in `app/.env.dev`):
```
VITE_RPC_ENDPOINT=...
VITE_RELAYER_URL=...
VITE_VEILPAY_PROGRAM_ID=...
VITE_VERIFIER_PROGRAM_ID=...
VITE_AIRDROP_URL=...   # optional, faucet link
```

3) Run the app:
```
pnpm --filter app dev --mode dev
```

## User guide (app)

The app has two primary areas:
- **User**: single-wallet deposit/withdraw/authorization/transfer flows (tabbed).
- **Multi-Wallet Test**: generates local wallets to test unlinkability end-to-end.

Recommended flow for users:
1) **Deposit**: moves WSOL from your wallet into the shielded pool.
2) **Withdraw**: pulls funds back to a public wallet address.
3) **Authorization**: create a claimable invoice and settle it.
4) **Transfers**: internal (VeilPay to VeilPay) or external (to any wallet).

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
- `POST /intent` for authorization submissions
- `GET /health` for health checks

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
