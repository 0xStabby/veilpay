import { Program } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { decode as bs58Decode } from '@coral-xyz/anchor/dist/esm/utils/bytes/bs58.js';
import { sha256 } from './crypto';
import { bytesToBigIntBE } from './crypto';
import { getIdentityCommitment, saveIdentityCommitments } from './identity';
import { buildMerkleTree } from './merkle';
import { bigIntToBytes32 } from './prover';

const toUint8Array = (value: unknown): Uint8Array | null => {
    if (value instanceof Uint8Array) {
        return value;
    }
    if (Buffer.isBuffer(value)) {
        return new Uint8Array(value);
    }
    if (Array.isArray(value)) {
        return new Uint8Array(value);
    }
    if (typeof value === 'string') {
        try {
            return new Uint8Array(bs58Decode(value));
        } catch {
            // ignore
        }
        try {
            return new Uint8Array(Buffer.from(value, 'base64'));
        } catch {
            // ignore
        }
        const hex = value.startsWith('0x') ? value.slice(2) : value;
        if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
            try {
                return new Uint8Array(Buffer.from(hex, 'hex'));
            } catch {
                // ignore
            }
        }
    }
    return null;
};

const toByteCandidates = (data: Uint8Array | string): Uint8Array[] => {
    if (typeof data !== 'string') {
        return [data instanceof Uint8Array ? data : new Uint8Array(data)];
    }
    const candidates: Uint8Array[] = [];
    try {
        candidates.push(new Uint8Array(bs58Decode(data)));
    } catch {
        // ignore
    }
    try {
        candidates.push(new Uint8Array(Buffer.from(data, 'base64')));
    } catch {
        // ignore
    }
    return candidates;
};

const extractByteCandidates = (data: unknown): Uint8Array[] => {
    if (typeof data === 'string' || data instanceof Uint8Array) {
        return toByteCandidates(data);
    }
    if (Buffer.isBuffer(data) || Array.isArray(data)) {
        return [new Uint8Array(data as any)];
    }
    if (data && typeof data === 'object') {
        const inner = (data as { data?: unknown }).data;
        if (typeof inner === 'string' || inner instanceof Uint8Array) {
            return toByteCandidates(inner);
        }
        if (Buffer.isBuffer(inner) || Array.isArray(inner)) {
            return [new Uint8Array(inner as any)];
        }
    }
    return [];
};

const decodeInstruction = (program: Program, bytes: Uint8Array) => {
    try {
        return program.coder.instruction.decode(Buffer.from(bytes)) ?? null;
    } catch {
        return null;
    }
};

const getAccountKeys = (message: any, meta: any) => {
    if (message && typeof message.getAccountKeys === 'function') {
        try {
            const loaded = meta?.loadedAddresses;
            if (loaded?.writable || loaded?.readonly) {
                return message.getAccountKeys({ accountKeysFromLookups: loaded });
            }
            return message.getAccountKeys();
        } catch {
            // ignore
        }
    }
    const staticKeys = message?.staticAccountKeys ?? message?.accountKeys ?? [];
    const loaded = meta?.loadedAddresses;
    if (loaded?.writable || loaded?.readonly) {
        return [...staticKeys, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
    }
    return staticKeys;
};

const resolveAccountKey = (keys: any, index: number) => {
    if (!keys) return undefined;
    if (typeof keys.get === 'function') {
        try {
            return keys.get(index);
        } catch {
            return undefined;
        }
    }
    return keys[index];
};

const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const getRegisterDiscriminators = async () => {
    const registerIdentityHash = await sha256(new TextEncoder().encode('global:registerIdentity'));
    const register_identityHash = await sha256(new TextEncoder().encode('global:register_identity'));
    const registerIdentity = new Uint8Array(registerIdentityHash.slice(0, 8));
    const register_identity = new Uint8Array(register_identityHash.slice(0, 8));
    return { registerIdentity, register_identity };
};

const parseRegisterIdentityArgs = (
    bytes: Uint8Array,
    discriminators: { registerIdentity: Uint8Array; register_identity: Uint8Array }
): { commitment: Uint8Array; newRoot: Uint8Array } | null => {
    const { registerIdentity, register_identity } = discriminators;
    const disc = bytes.slice(0, 8);
    if (!bytesEqual(disc, registerIdentity) && !bytesEqual(disc, register_identity)) {
        return null;
    }
    let offset = 8;
    if (bytes.length < offset + 4) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const commitmentLen = view.getUint32(offset, true);
    offset += 4;
    if (bytes.length < offset + commitmentLen) return null;
    const commitment = bytes.slice(offset, offset + commitmentLen);
    offset += commitmentLen;
    if (bytes.length < offset + 4) return null;
    const newRootLen = view.getUint32(offset, true);
    offset += 4;
    if (bytes.length < offset + newRootLen) return null;
    const newRoot = bytes.slice(offset, offset + newRootLen);
    return { commitment, newRoot };
};


export async function rescanIdentityRegistry(params: {
    program: Program;
    onStatus?: (message: string) => void;
    maxSignatures?: number;
    owner?: PublicKey;
    connectionOverride?: Connection;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}) {
    const { program, onStatus, maxSignatures, owner, connectionOverride, signMessage } = params;
    const connection = connectionOverride ?? program.provider.connection;
    const identityRegistryPda = PublicKey.findProgramAddressSync(
        [Buffer.from('identity_registry')],
        program.programId
    )[0];
    const identityRegistry = await program.account.identityRegistry.fetch(identityRegistryPda);
    const count = Number(identityRegistry.commitmentCount?.toString?.() ?? identityRegistry.commitment_count?.toString?.() ?? 0);
    const rootField =
        (identityRegistry.merkleRoot as number[] | undefined) ??
        (identityRegistry.merkle_root as number[] | undefined) ??
        [];
    const onChainRoot = new Uint8Array(rootField);

    onStatus?.('Rescanning identity registry...');
    onStatus?.(`Identity registry on-chain count: ${count}.`);
    const discriminators = await getRegisterDiscriminators();
    const signatures = new Map<string, number>();
    const rawCommitment =
        (program.provider as any)?.opts?.commitment ||
        (program.provider as any)?.connection?.commitment ||
        'confirmed';
    const signatureCommitment = rawCommitment === 'processed' ? 'confirmed' : rawCommitment;
    let before: string | undefined;
    let remaining = maxSignatures ?? Number.POSITIVE_INFINITY;
    while (remaining > 0) {
        const batch = await connection.getSignaturesForAddress(identityRegistryPda, {
            before,
            limit: Math.min(1000, remaining),
            commitment: signatureCommitment,
        });
        if (batch.length === 0) break;
        remaining -= batch.length;
        before = batch[batch.length - 1]?.signature;
        batch.forEach((entry) => signatures.set(entry.signature, entry.slot ?? 0));
    }
    before = undefined;
    remaining = maxSignatures ?? Number.POSITIVE_INFINITY;
    while (remaining > 0) {
        const batch = await connection.getSignaturesForAddress(program.programId, {
            before,
            limit: Math.min(1000, remaining),
            commitment: signatureCommitment,
        });
        if (batch.length === 0) break;
        remaining -= batch.length;
        before = batch[batch.length - 1]?.signature;
        batch.forEach((entry) => signatures.set(entry.signature, entry.slot ?? 0));
    }
    if (owner) {
        before = undefined;
        remaining = maxSignatures ?? Number.POSITIVE_INFINITY;
        while (remaining > 0) {
            const batch = await connection.getSignaturesForAddress(owner, {
                before,
                limit: Math.min(1000, remaining),
                commitment: signatureCommitment,
            });
            if (batch.length === 0) break;
            remaining -= batch.length;
            before = batch[batch.length - 1]?.signature;
            batch.forEach((entry) => signatures.set(entry.signature, entry.slot ?? 0));
        }
    }
    const orderedSignatures = Array.from(signatures.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([sig]) => sig);
    onStatus?.(`Identity registry scan: signatures=${orderedSignatures.length}.`);

    const commitments: bigint[] = [];
    let decodedCount = 0;
    let seenRegisters = 0;
    let decodedCommitmentHex: string | null = null;
    let decodedNewRootHex: string | null = null;
    let matchedCommitment: bigint | null = null;
    let matchedCommitmentHex: string | null = null;
    let matchedNewRootHex: string | null = null;
    for (const sig of orderedSignatures) {
        if (count > 1 && commitments.length >= count) break;
        if (count === 1 && matchedCommitment !== null) break;
        const tx = await connection.getTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
        });
        if (tx?.meta?.err) {
            continue;
        }
        const message = tx?.transaction.message as any;
        if (!message) continue;

        const legacyInstructions = message.instructions ?? [];
        const compiled = message.compiledInstructions ?? [];
        const keys = getAccountKeys(message, tx?.meta);

        const instructions = legacyInstructions.length > 0 ? legacyInstructions : compiled;
        for (const ix of instructions) {
            const programId = ix.programId ?? resolveAccountKey(keys, ix.programIdIndex);
            const isTargetProgram =
                !!programId && new PublicKey(programId).equals(program.programId);
            let handled = false;
            for (const candidate of extractByteCandidates(ix.data)) {
                if (isTargetProgram) {
                    const decoded = decodeInstruction(program, candidate);
                    if (decoded) {
                        if (
                            decoded.name !== 'registerIdentity' &&
                            decoded.name !== 'register_identity'
                        ) {
                            continue;
                        }
                        seenRegisters += 1;
                        const payload = (decoded.data as any) ?? {};
                        const payloadArgs = payload.args ?? payload;
                        const commitmentBytes = toUint8Array(payloadArgs.commitment);
                        if (!commitmentBytes || commitmentBytes.length !== 32) {
                            const reportedLength = commitmentBytes?.length ?? -1;
                            const discriminatorHex = Buffer.from(candidate.slice(0, 8)).toString('hex');
                            const payloadKeys = Object.keys(payload ?? {});
                            onStatus?.(
                                `Decoded register_identity with unexpected commitment length=${reportedLength} discriminator=${discriminatorHex} keys=${payloadKeys.join(',')}.`
                            );
                            continue;
                        }
                        const newRootBytes = toUint8Array(payloadArgs.newRoot ?? payloadArgs.new_root);
                        if (!decodedCommitmentHex) {
                            decodedCommitmentHex = Buffer.from(commitmentBytes).toString('hex');
                            if (newRootBytes && newRootBytes.length === 32) {
                                decodedNewRootHex = Buffer.from(newRootBytes).toString('hex');
                            }
                        }
                        const commitmentValue = bytesToBigIntBE(commitmentBytes);
                        if (count === 1) {
                            if (
                                newRootBytes &&
                                newRootBytes.length === 32 &&
                                bytesEqual(newRootBytes, onChainRoot)
                            ) {
                                matchedCommitment = commitmentValue;
                                matchedCommitmentHex = Buffer.from(commitmentBytes).toString('hex');
                                matchedNewRootHex = Buffer.from(newRootBytes).toString('hex');
                            } else {
                                const { root } = await buildMerkleTree([commitmentValue]);
                                const rootBytes = bigIntToBytes32(root);
                                if (bytesEqual(rootBytes, onChainRoot)) {
                                    matchedCommitment = commitmentValue;
                                    matchedCommitmentHex = Buffer.from(commitmentBytes).toString('hex');
                                    matchedNewRootHex = Buffer.from(rootBytes).toString('hex');
                                }
                            }
                        } else {
                            commitments.push(commitmentValue);
                        }
                        decodedCount += 1;
                        handled = true;
                        break;
                    }
                }
                const parsedArgs = parseRegisterIdentityArgs(candidate, discriminators);
                if (!parsedArgs || parsedArgs.commitment.length !== 32) continue;
                seenRegisters += 1;
                const commitmentValue = bytesToBigIntBE(parsedArgs.commitment);
                if (count === 1) {
                    if (parsedArgs.newRoot.length === 32 && bytesEqual(parsedArgs.newRoot, onChainRoot)) {
                        matchedCommitment = commitmentValue;
                        matchedCommitmentHex = Buffer.from(parsedArgs.commitment).toString('hex');
                        matchedNewRootHex = Buffer.from(parsedArgs.newRoot).toString('hex');
                    } else {
                        const { root } = await buildMerkleTree([commitmentValue]);
                        const rootBytes = bigIntToBytes32(root);
                        if (bytesEqual(rootBytes, onChainRoot)) {
                            matchedCommitment = commitmentValue;
                            matchedCommitmentHex = Buffer.from(parsedArgs.commitment).toString('hex');
                            matchedNewRootHex = Buffer.from(rootBytes).toString('hex');
                        }
                    }
                } else {
                    commitments.push(commitmentValue);
                }
                decodedCount += 1;
                handled = true;
                break;
            }
            if (handled) {
                continue;
            }
        }
    }

    if (count === 1) {
        if (matchedCommitment !== null) {
            commitments.length = 0;
            commitments.push(matchedCommitment);
            decodedCommitmentHex = matchedCommitmentHex ?? decodedCommitmentHex;
            decodedNewRootHex = matchedNewRootHex ?? decodedNewRootHex;
        }
    }

    if (count === 1 && commitments.length === 0 && owner && signMessage) {
        const commitment = await getIdentityCommitment(owner, program.programId, signMessage);
        const { root } = await buildMerkleTree([commitment]);
        const rootBytes = bigIntToBytes32(root);
        if (bytesEqual(rootBytes, onChainRoot)) {
            commitments.push(commitment);
            decodedCommitmentHex = Buffer.from(bigIntToBytes32(commitment)).toString('hex');
            decodedNewRootHex = Buffer.from(rootBytes).toString('hex');
            onStatus?.('Recovered identity commitment from signature.');
        } else {
            onStatus?.(
                `Signature-derived root mismatch local=${Buffer.from(rootBytes).toString('hex')} onchain=${Buffer.from(
                    onChainRoot
                ).toString('hex')}`
            );
        }
    }

    saveIdentityCommitments(program.programId, commitments);
    onStatus?.(
        `Identity registry rescan complete. Found ${commitments.length} registrations (decoded ${decodedCount}, seen ${seenRegisters}).`
    );
    if (decodedCommitmentHex) {
        onStatus?.(`Latest decoded commitment=${decodedCommitmentHex}`);
    }
    if (decodedNewRootHex) {
        onStatus?.(`Latest decoded new_root=${decodedNewRootHex}`);
    }
    if (matchedCommitmentHex) {
        onStatus?.(`Matched commitment=${matchedCommitmentHex}`);
    }
    if (matchedNewRootHex) {
        onStatus?.(`Matched new_root=${matchedNewRootHex}`);
    }

    if (onChainRoot.length === 32 && commitments.length > 0) {
        const { root } = await buildMerkleTree(commitments);
        const localRoot = bigIntToBytes32(root);
        const matches =
            localRoot.length === onChainRoot.length &&
            localRoot.every((value, index) => value === onChainRoot[index]);
        if (!matches) {
            onStatus?.('Identity registry root mismatch after rescan. You may need to rescan again.');
            onStatus?.(
                `Identity root local=${Buffer.from(localRoot).toString('hex')} onchain=${Buffer.from(onChainRoot).toString('hex')}`
            );
            if (decodedNewRootHex) {
                const onChainHex = Buffer.from(onChainRoot).toString('hex');
                const label = decodedNewRootHex === onChainHex ? 'matches' : 'differs';
                onStatus?.(`Latest decoded new_root ${label} on-chain root.`);
            }
        }
    }
    return commitments;
}
