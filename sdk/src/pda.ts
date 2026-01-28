import { PublicKey } from "@solana/web3.js";

export const seeds = {
  config: (programId: PublicKey) => [Buffer.from("config"), programId.toBuffer()],
  vkRegistry: () => [Buffer.from("vk_registry")],
  vault: (mint: PublicKey) => [Buffer.from("vault"), mint.toBuffer()],
  shielded: (mint: PublicKey) => [Buffer.from("shielded"), mint.toBuffer()],
  identityRegistry: () => [Buffer.from("identity_registry")],
  identityMember: (owner: PublicKey) => [Buffer.from("identity_member"), owner.toBuffer()],
  nullifierSet: (mint: PublicKey, chunkIndex: number) => [
    Buffer.from("nullifier_set"),
    mint.toBuffer(),
    Buffer.from(new Uint8Array(new Uint32Array([chunkIndex]).buffer)),
  ],
  verifierKey: (keyId: number) => [
    Buffer.from("verifier_key"),
    Buffer.from(new Uint8Array(new Uint32Array([keyId]).buffer)),
  ],
  proofAccount: (owner: PublicKey, nonce: bigint) => {
    const nonceBytes = Buffer.alloc(8);
    nonceBytes.writeBigUInt64LE(nonce);
    return [Buffer.from("proof"), owner.toBuffer(), nonceBytes];
  },
};

export function deriveConfig(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.config(programId), programId)[0];
}

export function deriveVkRegistry(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.vkRegistry(), programId)[0];
}

export function deriveVault(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.vault(mint), programId)[0];
}

export function deriveShielded(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.shielded(mint), programId)[0];
}

export function deriveIdentityRegistry(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.identityRegistry(), programId)[0];
}

export function deriveIdentityMember(programId: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.identityMember(owner), programId)[0];
}

export function deriveNullifierSet(programId: PublicKey, mint: PublicKey, chunkIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.nullifierSet(mint, chunkIndex), programId)[0];
}

export function deriveVerifierKey(verifierProgramId: PublicKey, keyId: number): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.verifierKey(keyId), verifierProgramId)[0];
}

export function deriveProofAccount(
  programId: PublicKey,
  owner: PublicKey,
  nonce: bigint
): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.proofAccount(owner, nonce), programId)[0];
}
