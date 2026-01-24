import { Program } from '@coral-xyz/anchor';
import type { AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { deriveConfig, deriveNullifierSet } from './pda';
import { bigIntToBytes32 } from './prover';

export const nullifierChunkIndex = (nullifier: bigint): number => {
    const bytes = bigIntToBytes32(nullifier);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(0, true);
};

export const ensureNullifierSet = async (
    program: Program,
    mint: PublicKey,
    nullifier: bigint
): Promise<PublicKey> => {
    const provider = program.provider as AnchorProvider;
    if (!provider.wallet) {
        throw new Error('Connect a wallet to initialize nullifier chunks.');
    }
    const chunkIndex = nullifierChunkIndex(nullifier);
    const nullifierSet = deriveNullifierSet(program.programId, mint, chunkIndex);
    const info = await provider.connection.getAccountInfo(nullifierSet);
    if (info) {
        return nullifierSet;
    }
    await program.methods
        .initializeNullifierChunk(chunkIndex)
        .accounts({
            config: deriveConfig(program.programId),
            nullifierSet,
            payer: provider.wallet.publicKey,
            mint,
            systemProgram: SystemProgram.programId,
        })
        .rpc();
    return nullifierSet;
};

export const ensureNullifierSets = async (
    program: Program,
    mint: PublicKey,
    nullifiers: bigint[],
    paddingChunks = 0
): Promise<PublicKey[]> => {
    const chunkIndexes = new Set<number>();
    for (const nullifier of nullifiers) {
        if (nullifier === 0n) {
            continue;
        }
        chunkIndexes.add(nullifierChunkIndex(nullifier));
    }
    if (paddingChunks > 0) {
        for (let index = 0; index < paddingChunks; index += 1) {
            chunkIndexes.add(index);
        }
    }
    const sets: PublicKey[] = [];
    for (const chunkIndex of chunkIndexes) {
        const nullifierSet = deriveNullifierSet(program.programId, mint, chunkIndex);
        const info = await program.provider.connection.getAccountInfo(nullifierSet);
        if (!info) {
            await program.methods
                .initializeNullifierChunk(chunkIndex)
                .accounts({
                    config: deriveConfig(program.programId),
                    nullifierSet,
                    payer: (program.provider as AnchorProvider).wallet.publicKey,
                    mint,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
        }
        sets.push(nullifierSet);
    }
    return sets;
};
