import { PublicKey } from '@solana/web3.js';

export const seeds = {
    config: (programId: PublicKey) => [Buffer.from('config'), programId.toBuffer()],
    vkRegistry: () => [Buffer.from('vk_registry')],
    vault: (mint: PublicKey) => [Buffer.from('vault'), mint.toBuffer()],
    shielded: (mint: PublicKey) => [Buffer.from('shielded'), mint.toBuffer()],
    nullifierSet: (mint: PublicKey, chunkIndex: number) => [
        Buffer.from('nullifier_set'),
        mint.toBuffer(),
        Buffer.from(new Uint8Array(new Uint32Array([chunkIndex]).buffer)),
    ],
    authorization: (intentHash: Uint8Array) => [Buffer.from('auth'), Buffer.from(intentHash)],
    verifierKey: (keyId: number) => [
        Buffer.from('verifier_key'),
        Buffer.from(new Uint8Array(new Uint32Array([keyId]).buffer)),
    ],
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

export function deriveNullifierSet(programId: PublicKey, mint: PublicKey, chunkIndex: number): PublicKey {
    return PublicKey.findProgramAddressSync(seeds.nullifierSet(mint, chunkIndex), programId)[0];
}

export function deriveAuthorization(programId: PublicKey, intentHash: Uint8Array): PublicKey {
    return PublicKey.findProgramAddressSync(seeds.authorization(intentHash), programId)[0];
}

export function deriveVerifierKey(verifierProgramId: PublicKey, keyId: number): PublicKey {
    return PublicKey.findProgramAddressSync(seeds.verifierKey(keyId), verifierProgramId)[0];
}
