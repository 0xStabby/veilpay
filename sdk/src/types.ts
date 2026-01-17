import { PublicKey } from "@solana/web3.js";

export type Ciphertext = Uint8Array;
export type Commitment = Uint8Array;
export type Nullifier = Uint8Array;
export type MerkleRoot = Uint8Array;

export interface Intent {
  intentHash: Uint8Array;
  mint: PublicKey;
  payeeTagHash: Uint8Array;
  amountCiphertext: Uint8Array;
  expirySlot: bigint;
  circuitId: number;
  proofHash: Uint8Array;
  relayerPubkey?: PublicKey;
}

export interface ProofBundle {
  proof: Uint8Array;
  publicInputs: Uint8Array;
}

export interface TransferArgs {
  amount: bigint;
  proof: Uint8Array;
  publicInputs: Uint8Array;
  nullifier: Nullifier;
  root: MerkleRoot;
  relayerFeeBps: number;
}
