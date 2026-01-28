import { Buffer } from 'buffer';
import { BN, Program } from '@coral-xyz/anchor';
import type { AnchorProvider } from '@coral-xyz/anchor';
import {
    AddressLookupTableAccount,
    ComputeBudgetProgram,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    getAccount,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import {
    deriveConfig,
    deriveIdentityMember,
    deriveIdentityRegistry,
    deriveProofAccount,
    deriveShielded,
    deriveVault,
    deriveVerifierKey,
} from './pda';
import {
    computeNullifier,
    formatPublicSignals,
    generateProof,
    preflightVerify,
    bigIntToBytes32,
} from './prover';
import { ensureNullifierSets } from './nullifier';
import {
    NULLIFIER_PADDING_CHUNKS,
    RELAYER_FEE_BPS,
    RELAYER_PUBKEY,
    RELAYER_URL,
    VERIFIER_PROGRAM_ID,
    WSOL_MINT,
} from './config';
import { sendLutVersionedTransaction, getRequiredLookupTable } from './lut';
import { submitViaRelayerSigned } from './relayer';
import { checkVerifierKeyMatch } from './verifierKey';
import { formatTokenAmount, parseTokenAmount } from './amount';
import { buildMerkleTree, getMerklePath, MERKLE_DEPTH } from './merkle';
import {
    addNote,
    buildOutputCiphertexts,
    createNote,
    type NoteRecord,
    deriveViewKeypair,
    loadCommitments,
    loadNotes,
    listSpendableNotes,
    markNoteSpent,
    parseViewKey,
    replaceNotes,
    saveCommitments,
    saveNotes,
    selectNotesForAmount,
    sumSpendableNotes,
} from './notes';
import { rescanNotesForOwner } from './noteScanner';
import {
    buildIdentityRoot,
    getIdentityCommitment,
    getIdentityMerklePath,
    getOrCreateIdentitySecret,
    loadIdentityCommitments,
    saveIdentityCommitments,
    setIdentityLeafIndex,
} from './identity';
import { rescanIdentityRegistry } from './identityScanner';

type StatusHandler = (message: string) => void;

const MAX_INPUTS = 4;
const MAX_OUTPUTS = 2;
const ZERO_PATH_ELEMENTS = Array.from({ length: MERKLE_DEPTH }, () => '0');
const ZERO_PATH_INDEX = Array.from({ length: MERKLE_DEPTH }, () => 0);
const computeRelayerFee = (amount: bigint, feeBps: number) => {
    if (feeBps <= 0) {
        return 0n;
    }
    const fee = (amount * BigInt(feeBps)) / 10_000n;
    if (fee >= amount) {
        throw new Error('Relayer fee exceeds amount.');
    }
    return fee;
};

const generateProofNonce = () => {
    const cryptoObj = globalThis.crypto;
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
        throw new Error('Random nonce generation unavailable (missing crypto.getRandomValues).');
    }
    const bytes = new Uint8Array(8);
    cryptoObj.getRandomValues(bytes);
    let nonce = 0n;
    for (let i = 0; i < bytes.length; i += 1) {
        nonce |= BigInt(bytes[i]) << (8n * BigInt(i));
    }
    return nonce;
};


const getEnvLookupTable = async (
    provider: AnchorProvider,
    _addresses: PublicKey[]
): Promise<AddressLookupTableAccount> => {
    return await getRequiredLookupTable(provider.connection);
};

const getMissingLutAddresses = (lookupTable: AddressLookupTableAccount, addresses: PublicKey[]) => {
    const lutSet = new Set(lookupTable.state.addresses.map((addr) => addr.toBase58()));
    return addresses.filter((addr) => !lutSet.has(addr.toBase58()));
};

const getLutIndexViolations = (lookupTable: AddressLookupTableAccount, addresses: PublicKey[]) => {
    const indexByKey = new Map(
        lookupTable.state.addresses.map((addr, index) => [addr.toBase58(), index])
    );
    return addresses
        .map((addr) => ({ addr, index: indexByKey.get(addr.toBase58()) }))
        .filter((entry) => entry.index !== undefined && entry.index > 255)
        .map((entry) => ({
            address: entry.addr.toBase58(),
            index: entry.index as number,
        }));
};

const padArray = <T,>(values: T[], length: number, filler: T): T[] => {
    const out = values.slice(0, length);
    while (out.length < length) {
        out.push(filler);
    }
    return out;
};

const padMatrix = <T,>(rows: T[][], length: number, filler: T[]): T[][] => {
    const out = rows.slice(0, length);
    while (out.length < length) {
        out.push(filler.slice());
    }
    return out;
};

const ensureDummySignatures = (tx: VersionedTransaction) => {
    const required = tx.message.header.numRequiredSignatures;
    if (tx.signatures.length === required && required > 0) {
        return;
    }
    tx.signatures = Array.from({ length: required }, () => new Uint8Array(64));
};

const formatAmount = (amount: bigint, decimals: number) => formatTokenAmount(amount, decimals);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForShieldedStateUpdate = async (params: {
    program: Program;
    mint: PublicKey;
    expectedCommitments: bigint;
    expectedRoot?: Uint8Array;
    onStatus?: StatusHandler;
    minContextSlot?: number;
}) => {
    const { program, mint, expectedCommitments, expectedRoot, onStatus, minContextSlot } = params;
    const shieldedState = deriveShielded(program.programId, mint);
    for (let attempt = 0; attempt < 10; attempt += 1) {
        let commitmentCount: bigint;
        let rootBytes: Uint8Array;
        if (minContextSlot !== undefined) {
            const info = await program.provider.connection.getAccountInfo(shieldedState, {
                commitment: 'confirmed',
                minContextSlot,
            });
            if (!info) {
                throw new Error('Shielded state account not found on chain.');
            }
            const decoded = program.coder.accounts.decode('shieldedState', info.data);
            const rootField =
                (decoded.merkleRoot as number[] | undefined) ??
                (decoded.merkle_root as number[] | undefined) ??
                [];
            rootBytes = new Uint8Array(rootField);
            commitmentCount = BigInt(
                decoded.commitmentCount?.toString?.() ?? decoded.commitment_count?.toString?.() ?? 0
            );
        } else {
            ({ commitmentCount, rootBytes } = await fetchShieldedState(program, mint));
        }
        const countOk = commitmentCount >= expectedCommitments;
        const rootOk = expectedRoot ? bytesEqual(rootBytes, expectedRoot) : true;
        if (countOk && rootOk) {
            return { commitmentCount, rootBytes };
        }
        onStatus?.(
            `Waiting for shielded state update (attempt ${attempt + 1}/10). commitments=${commitmentCount.toString()} expected=${expectedCommitments.toString()}`
        );
        await sleep(250);
    }
    return null;
};

const logNoteOutputsForSignature = async (
    program: Program,
    signature: string,
    onStatus?: StatusHandler
) => {
    try {
        const tx = await program.provider.connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
        });
        if (!tx) {
            onStatus?.(`Relayer tx not found on app RPC for signature ${signature}`);
            return;
        }
        const logs = tx?.meta?.logMessages ?? [];
        let outputs: string[] = [];
        for (const line of logs) {
            if (!line.startsWith('Program data:')) continue;
            const data = line.slice('Program data:'.length).trim();
            try {
                const decoded = program.coder.events.decode(data);
                if (decoded?.name === 'NoteOutputEvent' || decoded?.name === 'noteOutputEvent') {
                    const leaf = decoded.data?.leafIndex ?? decoded.data?.leaf_index ?? 'unknown';
                    const kind = decoded.data?.kind ?? 'unknown';
                    outputs.push(`kind=${kind} leaf=${leaf}`);
                }
            } catch {
                // ignore non-event lines
            }
        }
        if (outputs.length > 0) {
            onStatus?.(`Relayer tx outputs: ${outputs.join(' | ')}`);
        }
    } catch {
        // ignore log fetch errors
    }
};

class NoteStoreOutOfSyncError extends Error {
    local: number;
    expected: number;
    constructor(local: number, expected: number) {
        super(`Local note store is out of sync with on-chain commitment count (local=${local}, on-chain=${expected}).`);
        this.name = 'NoteStoreOutOfSyncError';
        this.local = local;
        this.expected = expected;
    }
}

const isNoteStoreOutOfSyncError = (error: unknown): error is NoteStoreOutOfSyncError =>
    error instanceof NoteStoreOutOfSyncError || (error as { name?: string } | null)?.name === 'NoteStoreOutOfSyncError';

const getCommitmentsWithSync = (
    mint: PublicKey,
    owner: PublicKey,
    commitmentCount: bigint,
    onStatus?: StatusHandler
): bigint[] => {
    const expected = Number(commitmentCount);
    const commitmentCache = loadCommitments(mint, owner);
    if (commitmentCache.commitments.length > 0) {
        if (commitmentCache.commitments.length > expected) {
            onStatus?.('Local commitment cache ahead of chain. Trimming to on-chain commitment count.');
            const trimmed = commitmentCache.commitments.slice(0, expected);
            saveCommitments(mint, owner, trimmed, commitmentCache.complete);
            const notes = loadNotes(mint, owner).sort((a, b) => a.leafIndex - b.leafIndex);
            if (notes.length > expected) {
                const trimmedNotes = notes.slice(0, expected);
                replaceNotes(mint, owner, trimmedNotes);
            }
            return trimmed;
        }
        if (commitmentCache.complete && commitmentCache.commitments.length === expected) {
            return commitmentCache.commitments;
        }
    }
    const notes = loadNotes(mint, owner).sort((a, b) => a.leafIndex - b.leafIndex);
    if (notes.length > expected) {
        onStatus?.('Local note store ahead of chain. Trimming to on-chain commitment count.');
        const trimmed = notes.slice(0, expected);
        saveNotes(mint, owner, trimmed);
        const commitments = trimmed.map((note) => BigInt(note.commitment));
        saveCommitments(mint, owner, commitments, true);
        return commitments;
    }
    if (notes.length !== expected) {
        throw new NoteStoreOutOfSyncError(notes.length, expected);
    }
    const commitments = notes.map((note) => BigInt(note.commitment));
    saveCommitments(mint, owner, commitments, true);
    return commitments;
};

const rescanNotesWithFallback = async (params: {
    program: Program;
    mint: PublicKey;
    owner: PublicKey;
    commitmentCount: bigint;
    onStatus: StatusHandler;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
    rescanNotes?: () => Promise<void>;
}): Promise<bigint[]> => {
    const { program, mint, owner, commitmentCount, onStatus, signMessage, rescanNotes } = params;
    onStatus('Local note store out of sync. Attempting rescan...');
    if (rescanNotes) {
        await rescanNotes();
    } else if (signMessage) {
        await rescanNotesForOwner({
            program,
            mint,
            owner,
            onStatus,
            signMessage,
        });
    } else {
        throw new Error('Unable to rescan notes without a message signature.');
    }
    return getCommitmentsWithSync(mint, owner, commitmentCount, onStatus);
};

const getProvider = (program: Program): AnchorProvider => {
    const provider = program.provider as AnchorProvider;
    if (!provider.wallet) {
        throw new Error('Connect a wallet to continue.');
    }
    return provider;
};

async function ensureAta(
    provider: AnchorProvider,
    mint: PublicKey,
    owner: PublicKey
): Promise<PublicKey> {
    const ata = await getAssociatedTokenAddress(mint, owner);
    try {
        await getAccount(provider.connection, ata);
    } catch {
        const ix = createAssociatedTokenAccountInstruction(provider.wallet.publicKey, ata, owner, mint);
        await sendLutVersionedTransaction({
            connection: provider.connection,
            payer: provider.wallet.publicKey,
            instructions: [ix],
            signTransaction: provider.wallet.signTransaction.bind(provider.wallet),
        });
    }
    return ata;
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

const assertCiphertextFields = (note: {
    c1x?: string;
    c1y?: string;
    c2Amount?: string;
    c2Randomness?: string;
    encRandomness?: string;
}) => {
    if (!note.c1x || !note.c1y || !note.c2Amount || !note.c2Randomness || !note.encRandomness) {
        throw new Error('Note is missing ECIES fields. Re-deposit to refresh note data.');
    }
};

async function fetchShieldedState(program: Program, mint: PublicKey) {
    const shieldedState = deriveShielded(program.programId, mint);
    const account = await (program.account as any).shieldedState.fetch(shieldedState, 'confirmed');
    const rootField =
        (account.merkleRoot as number[] | undefined) ??
        (account.merkle_root as number[] | undefined) ??
        [];
    const rootBytes = new Uint8Array(rootField);
    const commitmentCount = BigInt(account.commitmentCount?.toString?.() ?? account.commitment_count?.toString?.() ?? 0);
    return { shieldedState, rootBytes, commitmentCount };
}

async function fetchIdentityRegistry(program: Program) {
    const identityRegistry = deriveIdentityRegistry(program.programId);
    const account = await (program.account as any).identityRegistry.fetch(identityRegistry, 'confirmed');
    const rootField =
        (account.merkleRoot as number[] | undefined) ??
        (account.merkle_root as number[] | undefined) ??
        [];
    const rootBytes = new Uint8Array(rootField);
    const commitmentCount = BigInt(
        account.commitmentCount?.toString?.() ?? account.commitment_count?.toString?.() ?? 0
    );
    return { identityRegistry, rootBytes, commitmentCount };
}

async function ensureIdentityRegistered(
    program: Program,
    owner: PublicKey,
    onStatus?: StatusHandler,
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>
) {
    const provider = getProvider(program);
    const { identityRegistry, rootBytes, commitmentCount } = await fetchIdentityRegistry(program);
    let localCommitments = loadIdentityCommitments(program.programId);
    if (localCommitments.length !== Number(commitmentCount)) {
        await rescanIdentityRegistry({ program, onStatus, owner, signMessage });
        localCommitments = loadIdentityCommitments(program.programId);
    }
    if (localCommitments.length !== Number(commitmentCount)) {
        throw new Error('Local identity registry is out of sync with on-chain root.');
    }
    if (localCommitments.length > 0) {
        const localRoot = await buildIdentityRoot(program.programId);
        const localRootBytes = bigIntToBytes32(localRoot);
        if (!bytesEqual(rootBytes, localRootBytes)) {
            if (!signMessage) {
                throw new Error('Local identity registry root does not match on-chain root.');
            }
            onStatus?.('Identity registry mismatch. Registering fresh identity.');
            const commitment = await getIdentityCommitment(owner, program.programId, signMessage);
            const { root } = await buildMerkleTree([commitment]);
            const newRoot = bigIntToBytes32(root);
            const ix = await program.methods
                .registerIdentity({
                    commitment: Buffer.from(bigIntToBytes32(commitment)),
                    newRoot: Buffer.from(newRoot),
                })
                .accounts({
                    identityRegistry,
                    identityMember: deriveIdentityMember(program.programId, owner),
                    payer: owner,
                    user: owner,
                    systemProgram: SystemProgram.programId,
                })
                .instruction();
            await sendLutVersionedTransaction({
                connection: provider.connection,
                payer: owner,
                instructions: [ix],
                signTransaction: provider.wallet.signTransaction.bind(provider.wallet),
            });
            saveIdentityCommitments(program.programId, [commitment]);
            setIdentityLeafIndex(owner, program.programId, 0);
            return { identityRegistry, rootBytes: newRoot };
        }
    }
    const commitment = await getIdentityCommitment(owner, program.programId, signMessage);
    let index = localCommitments.findIndex((entry) => entry === commitment);
    if (index === -1) {
        const newCommitments = [...localCommitments, commitment];
        const { root } = await buildMerkleTree(newCommitments);
        const newRoot = bigIntToBytes32(root);
        onStatus?.('Registering identity...');
        const ix = await program.methods
            .registerIdentity({
                commitment: Buffer.from(bigIntToBytes32(commitment)),
                newRoot: Buffer.from(newRoot),
            })
            .accounts({
                identityRegistry,
                identityMember: deriveIdentityMember(program.programId, owner),
                payer: owner,
                user: owner,
                systemProgram: SystemProgram.programId,
            })
            .instruction();
        await sendLutVersionedTransaction({
            connection: provider.connection,
            payer: owner,
            instructions: [ix],
            signTransaction: provider.wallet.signTransaction.bind(provider.wallet),
        });
        saveIdentityCommitments(program.programId, newCommitments);
        index = newCommitments.length - 1;
        setIdentityLeafIndex(owner, program.programId, index);
        return { identityRegistry, rootBytes: newRoot };
    }
    setIdentityLeafIndex(owner, program.programId, index);
    return { identityRegistry, rootBytes };
}

export async function registerIdentityFlow(params: {
    program: Program;
    owner?: PublicKey;
    onStatus?: StatusHandler;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}): Promise<void> {
    const { program, owner, onStatus, signMessage } = params;
    const provider = getProvider(program);
    const actualOwner = owner ?? provider.wallet.publicKey;
    if (!signMessage) {
        throw new Error('Wallet must support message signing to register identity.');
    }
    await ensureIdentityRegistered(program, actualOwner, onStatus, signMessage);
}

async function buildSpendProofInput(params: {
    program: Program;
    mint: PublicKey;
    owner: PublicKey;
    inputNotes: NoteRecord[];
    outputNotes: Array<NoteRecord | null>;
    outputEnabled: number[];
    amountOut: bigint;
    feeAmount: bigint;
    commitments: bigint[];
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}) {
    const { program, mint, owner, inputNotes, outputNotes, outputEnabled, amountOut, feeAmount, commitments, signMessage } =
        params;
    const { root: derivedRoot } = await buildMerkleTree(commitments);
    const derivedRootBytes = bigIntToBytes32(derivedRoot);

    const inputEnabled = padArray(
        inputNotes.map(() => 1),
        MAX_INPUTS,
        0
    );
    const inputAmounts = padArray(
        inputNotes.map((note) => note.amount),
        MAX_INPUTS,
        '0'
    );
    const inputRandomness = padArray(
        inputNotes.map((note) => note.randomness),
        MAX_INPUTS,
        '0'
    );
    const inputSenderSecret = padArray(
        inputNotes.map((note) => note.senderSecret),
        MAX_INPUTS,
        '0'
    );
    const inputLeafIndex = padArray(
        inputNotes.map((note) => note.leafIndex.toString()),
        MAX_INPUTS,
        '0'
    );
    const inputRecipientTagHash = padArray(
        inputNotes.map((note) => note.recipientTagHash),
        MAX_INPUTS,
        '0'
    );

    const pathElementsRows: string[][] = [];
    const pathIndexRows: number[][] = [];
    const nullifierValues: bigint[] = [];
    for (const note of inputNotes) {
        const { pathElements, pathIndices } = await getMerklePath(commitments, note.leafIndex);
        pathElementsRows.push(pathElements.map((value) => value.toString()));
        pathIndexRows.push(pathIndices);
        const nullifierValue = await computeNullifier(BigInt(note.senderSecret), BigInt(note.leafIndex));
        nullifierValues.push(nullifierValue);
    }
    const inputPathElements = padMatrix(pathElementsRows, MAX_INPUTS, ZERO_PATH_ELEMENTS);
    const inputPathIndex = padMatrix(pathIndexRows, MAX_INPUTS, ZERO_PATH_INDEX);

    const nullifierInputs = padArray(
        nullifierValues.map((value) => value.toString()),
        MAX_INPUTS,
        '0'
    );
    if (!signMessage) {
        throw new Error('Wallet must support message signing to derive view keys.');
    }
    const fallbackRecipient = await deriveViewKeypair({ owner, signMessage, index: 0 });
    const fallbackRecipientX = fallbackRecipient.pubkey[0].toString();
    const fallbackRecipientY = fallbackRecipient.pubkey[1].toString();

    const outputCommitments = padArray(
        outputNotes.map((note, index) => {
            if (!note || !outputEnabled[index]) {
                return '0';
            }
            if (!note.recipientPubkeyX || !note.recipientPubkeyY) {
                throw new Error('Output note is missing recipient pubkey.');
            }
            return note.commitment;
        }),
        MAX_OUTPUTS,
        '0'
    );

    const outputAmount = padArray(
        outputNotes.map((note) => (note ? note.amount : '0')),
        MAX_OUTPUTS,
        '0'
    );
    const outputRandomness = padArray(
        outputNotes.map((note) => (note ? note.randomness : '0')),
        MAX_OUTPUTS,
        '0'
    );
    const outputRecipientTagHash = padArray(
        outputNotes.map((note) => (note ? note.recipientTagHash : '0')),
        MAX_OUTPUTS,
        '0'
    );
    const outputRecipientPubkeyX = padArray(
        outputNotes.map((note) => (note?.recipientPubkeyX ? note.recipientPubkeyX : fallbackRecipientX)),
        MAX_OUTPUTS,
        fallbackRecipientX
    );
    const outputRecipientPubkeyY = padArray(
        outputNotes.map((note) => (note?.recipientPubkeyY ? note.recipientPubkeyY : fallbackRecipientY)),
        MAX_OUTPUTS,
        fallbackRecipientY
    );
    const outputEncRandomness = padArray(
        outputNotes.map((note) => (note?.encRandomness ? note.encRandomness : '0')),
        MAX_OUTPUTS,
        '0'
    );
    const outputC1x = padArray(
        outputNotes.map((note) => (note?.c1x ? note.c1x : '0')),
        MAX_OUTPUTS,
        '0'
    );
    const outputC1y = padArray(
        outputNotes.map((note) => (note?.c1y ? note.c1y : '0')),
        MAX_OUTPUTS,
        '0'
    );
    const outputC2Amount = padArray(
        outputNotes.map((note) => (note?.c2Amount ? note.c2Amount : '0')),
        MAX_OUTPUTS,
        '0'
    );
    const outputC2Randomness = padArray(
        outputNotes.map((note) => (note?.c2Randomness ? note.c2Randomness : '0')),
        MAX_OUTPUTS,
        '0'
    );

    const { root: identityRoot, pathElements: identityPathElements, pathIndices: identityPathIndices } =
        await getIdentityMerklePath(owner, program.programId, signMessage);
    const identitySecret = await getOrCreateIdentitySecret(owner, program.programId, signMessage);

    const input = {
        root: derivedRoot.toString(),
        identity_root: identityRoot.toString(),
        nullifier: nullifierInputs,
        output_commitment: outputCommitments,
        output_enabled: padArray(outputEnabled, MAX_OUTPUTS, 0),
        amount_out: amountOut.toString(),
        fee_amount: feeAmount.toString(),
        circuit_id: '0',
        input_enabled: inputEnabled,
        input_amount: inputAmounts,
        input_randomness: inputRandomness,
        input_sender_secret: inputSenderSecret,
        input_leaf_index: inputLeafIndex,
        input_recipient_tag_hash: inputRecipientTagHash,
        input_path_elements: inputPathElements,
        input_path_index: inputPathIndex,
        identity_secret: identitySecret.toString(),
        identity_path_elements: identityPathElements.map((value) => value.toString()),
        identity_path_index: identityPathIndices,
        output_amount: outputAmount,
        output_randomness: outputRandomness,
        output_recipient_tag_hash: outputRecipientTagHash,
        output_recipient_pubkey_x: outputRecipientPubkeyX,
        output_recipient_pubkey_y: outputRecipientPubkeyY,
        output_enc_randomness: outputEncRandomness,
        output_c1x: outputC1x,
        output_c1y: outputC1y,
        output_c2_amount: outputC2Amount,
        output_c2_randomness: outputC2Randomness,
    };

    return {
        input,
        derivedRootBytes,
        nullifierValues,
        outputCommitments,
    };
}

export async function runDepositFlow(params: {
    program: Program;
    mint: PublicKey;
    amount: string;
    mintDecimals: number;
    depositAsset?: 'sol' | 'wsol';
    onStatus: StatusHandler;
    onRootChange: (next: Uint8Array) => void;
    onCredit: (amount: bigint) => void;
    rescanNotes?: () => Promise<void>;
    ensureRecipientSecret?: () => Promise<void>;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}): Promise<{ signature: string; amountBaseUnits: bigint; newRoot: Uint8Array }> {
    const {
        program,
        mint,
        amount,
        mintDecimals,
        depositAsset = 'sol',
        onStatus,
        onRootChange,
        onCredit,
        rescanNotes,
        ensureRecipientSecret,
        signMessage,
    } = params;
    const provider = getProvider(program);
    const owner = provider.wallet.publicKey;
    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const wantsSol = depositAsset === 'sol';
    if (wantsSol && !mint.equals(WSOL_MINT)) {
        throw new Error('SOL deposits are only supported for the WSOL mint.');
    }
    onStatus(
        `Depositing into VeilPay vault (amount=${formatTokenAmount(baseUnits, mintDecimals)} mint=${mint.toBase58()})...`
    );
    const config = deriveConfig(program.programId);
    const vault = deriveVault(program.programId, mint);
    const { shieldedState, rootBytes, commitmentCount } = await fetchShieldedState(program, mint);
    onStatus(
        `Shielded state: commitments=${commitmentCount.toString()} root=${Buffer.from(rootBytes).toString('hex').slice(0, 16)}...`
    );
    const identityMember = deriveIdentityMember(program.programId, owner);
    const memberInfo = await provider.connection.getAccountInfo(identityMember);
    if (!memberInfo) {
        await ensureIdentityRegistered(program, owner, onStatus, signMessage);
    }
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const userAta = await getAssociatedTokenAddress(mint, owner);
    const instructions: TransactionInstruction[] = [];
    const userAtaInfo = await provider.connection.getAccountInfo(userAta);
    if (!userAtaInfo) {
        instructions.push(createAssociatedTokenAccountInstruction(owner, userAta, owner, mint));
    }

    let commitments: bigint[];
    try {
        commitments = getCommitmentsWithSync(mint, owner, commitmentCount, onStatus);
    } catch (error) {
        if (isNoteStoreOutOfSyncError(error) && rescanNotes) {
            onStatus('Local note store missing notes. Attempting rescan before deposit...');
            await rescanNotes();
            commitments = getCommitmentsWithSync(mint, owner, commitmentCount, onStatus);
        } else {
            throw error;
        }
    }
    const leafIndex = Number(commitmentCount);
    const { root: currentRoot } = await buildMerkleTree(commitments);
    const currentRootBytes = bigIntToBytes32(currentRoot);
    if (!bytesEqual(rootBytes, currentRootBytes)) {
        throw new Error('On-chain root does not match local note store.');
    }
    if (!signMessage) {
        throw new Error('Wallet must support message signing to derive view keys.');
    }
    if (ensureRecipientSecret) {
        await ensureRecipientSecret();
    }
    const ownerViewKey = await deriveViewKeypair({
        owner,
        signMessage,
        index: 0,
    });
    const { note, plaintext: ciphertext } = await createNote({
        mint,
        amount: baseUnits,
        recipientViewKey: ownerViewKey.pubkey,
        leafIndex,
    });
    onStatus(
        `Prepared deposit note: amount=${formatTokenAmount(baseUnits, mintDecimals)} leafIndex=${leafIndex} commitment=${note.commitment.slice(0, 10)}...`
    );
    const commitmentValue = BigInt(note.commitment);
    commitments.push(commitmentValue);
    const { root } = await buildMerkleTree(commitments);
    const newRoot = bigIntToBytes32(root);

    if (wantsSol) {
        onStatus('Wrapping SOL into WSOL for deposit...');
        if (baseUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('Deposit amount is too large to wrap into WSOL.');
        }
        instructions.push(
            SystemProgram.transfer({
                fromPubkey: owner,
                toPubkey: userAta,
                lamports: Number(baseUnits),
            })
        );
        instructions.push(createSyncNativeInstruction(userAta));
    }

    const ix = await program.methods
        .deposit({
            amount: new BN(baseUnits.toString()),
            ciphertext: Buffer.from(ciphertext),
            commitment: Buffer.from(bigIntToBytes32(commitmentValue)),
            newRoot: Buffer.from(newRoot),
        })
        .accounts({
            config,
            vault,
            vaultAta,
            shieldedState,
            user: owner,
            identityMember,
            userAta,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
    instructions.push(ix);
    const signature = await sendLutVersionedTransaction({
        connection: provider.connection,
        payer: owner,
        instructions,
        signTransaction: provider.wallet.signTransaction.bind(provider.wallet),
    });

    addNote(mint, owner, note);
    saveCommitments(mint, owner, commitments, true);
    onRootChange(newRoot);
    onCredit(baseUnits);
    onStatus(
        `Deposit complete (amount=${formatTokenAmount(baseUnits, mintDecimals)} leafIndex=${leafIndex} commitments=${commitments.length} newRoot=${Buffer.from(newRoot).toString('hex').slice(0, 16)}...)`
    );
    return { signature, amountBaseUnits: baseUnits, newRoot };
}

export async function runInternalTransferFlow(params: {
    program: Program;
    verifierProgram: Program | null;
    mint: PublicKey;
    recipientViewKey: string;
    amount?: string;
    mintDecimals?: number;
    root: Uint8Array;
    nextNullifier: () => number;
    onStatus: StatusHandler;
    onRootChange: (next: Uint8Array) => void;
    ensureRecipientSecret?: () => Promise<void>;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
    rescanNotes?: () => Promise<void>;
}): Promise<{ signature: string; nullifier: bigint; newRoot: Uint8Array }> {
    const {
        program,
        verifierProgram,
        mint,
        recipientViewKey,
        amount,
        mintDecimals,
        root,
        nextNullifier: _nextNullifier,
        onStatus,
        onRootChange,
        ensureRecipientSecret,
        signMessage,
        rescanNotes,
    } = params;
    const provider = getProvider(program);
    const owner = provider.wallet.publicKey;
    const parsedRecipientViewKey = parseViewKey(recipientViewKey);
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const { shieldedState, rootBytes, commitmentCount } = await fetchShieldedState(program, mint);
    await ensureIdentityRegistered(program, owner, onStatus, signMessage);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);
    let commitments: bigint[];
    try {
        commitments = getCommitmentsWithSync(mint, owner, commitmentCount, onStatus);
    } catch (error) {
        if (isNoteStoreOutOfSyncError(error)) {
            onStatus('Local note store missing notes. Attempting rescan before transfer...');
            if (rescanNotes) {
                await rescanNotes();
            } else if (signMessage) {
                await rescanNotesForOwner({
                    program,
                    mint,
                    owner,
                    onStatus,
                    signMessage,
                });
            } else {
                throw error;
            }
            commitments = getCommitmentsWithSync(mint, owner, commitmentCount, onStatus);
        } else {
            throw error;
        }
    }
    let { root: derivedRoot } = await buildMerkleTree(commitments);
    let derivedRootBytes = bigIntToBytes32(derivedRoot);
    if (!bytesEqual(root, derivedRootBytes)) {
        onStatus('Provided root does not match local notes; using on-chain root.');
        onRootChange?.(derivedRootBytes);
    }
    if (!bytesEqual(rootBytes, derivedRootBytes)) {
        commitments = await rescanNotesWithFallback({
            program,
            mint,
            owner,
            commitmentCount,
            onStatus,
            signMessage,
            rescanNotes,
        });
        ({ root: derivedRoot } = await buildMerkleTree(commitments));
        derivedRootBytes = bigIntToBytes32(derivedRoot);
        if (!bytesEqual(root, derivedRootBytes)) {
            onStatus('Provided root does not match local notes; using on-chain root.');
            onRootChange?.(derivedRootBytes);
        }
        if (!bytesEqual(rootBytes, derivedRootBytes)) {
            throw new Error('On-chain root does not match local note store.');
        }
    }

    const availableNotes = listSpendableNotes(mint, owner);
    const targetAmount =
        amount && mintDecimals !== undefined ? parseTokenAmount(amount, mintDecimals) : null;
    let inputNotes: NoteRecord[] = [];
    let total = 0n;
    if (targetAmount !== null) {
        const selection = selectNotesForAmount(mint, owner, targetAmount, MAX_INPUTS);
        inputNotes = selection.notes;
        total = selection.total;
    } else {
        inputNotes = availableNotes.slice(0, 1);
        total = inputNotes[0] ? BigInt(inputNotes[0].amount) : 0n;
    }
    if (inputNotes.length === 0) {
        throw new Error('No spendable note found for internal transfer.');
    }
    const transferAmount = targetAmount ?? BigInt(inputNotes[0].amount);
    onStatus(
        `Internal transfer selection: requested=${formatAmount(transferAmount, mintDecimals ?? 0)} selectedNotes=${inputNotes.length} total=${formatAmount(total, mintDecimals ?? 0)}`
    );
    inputNotes.forEach(assertCiphertextFields);
    if (total < transferAmount) {
        throw new Error('Insufficient shielded balance for that amount.');
    }

    const outputNotes: Array<NoteRecord | null> = [null, null];
    const outputEnabled = [1, 0];
    let nextIndex = commitments.length;
    if (ensureRecipientSecret) {
        await ensureRecipientSecret();
    }
    const { note: recipientNote } = await createNote({
        mint,
        amount: transferAmount,
        recipientViewKey: parsedRecipientViewKey,
        leafIndex: nextIndex,
    });
    outputNotes[0] = recipientNote;
    nextIndex += 1;
    const changeAmount = total - transferAmount;
    onStatus(
        `Internal transfer amounts: send=${formatAmount(transferAmount, mintDecimals ?? 0)} change=${formatAmount(changeAmount, mintDecimals ?? 0)}`
    );
    if (changeAmount > 0n) {
        if (!signMessage) {
            throw new Error('Wallet must support message signing to derive view keys.');
        }
        const { note: changeNote } = await createNote({
            mint,
            amount: changeAmount,
            recipientViewKey: (await deriveViewKeypair({
                owner,
                signMessage,
                index: 0,
            })).pubkey,
            leafIndex: nextIndex,
        });
        outputNotes[1] = changeNote;
        outputEnabled[1] = 1;
        nextIndex += 1;
    }

    const updatedCommitments = commitments.slice();
    outputNotes.forEach((note, index) => {
        if (note && outputEnabled[index]) {
            updatedCommitments.push(BigInt(note.commitment));
        }
    });
    const { root: nextRoot } = await buildMerkleTree(updatedCommitments);
    const newRoot = bigIntToBytes32(nextRoot);
    const outputCiphertexts = buildOutputCiphertexts(outputNotes, outputEnabled);

    const built = await buildSpendProofInput({
        program,
        mint,
        owner,
        inputNotes,
        outputNotes,
        outputEnabled,
        amountOut: 0n,
        feeAmount: 0n,
        commitments,
        signMessage,
    });
    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof(built.input);
    onStatus(`Public signals: ${formatPublicSignals(publicSignals)}`);
    onStatus(
        `Output commitments: [${built.outputCommitments
            .map((value) => Buffer.from(value).toString('hex').slice(0, 8))
            .join(', ')}] outputEnabled=${outputEnabled.join(',')}`
    );
    const nullifierSets = await ensureNullifierSets(
        program,
        mint,
        built.nullifierValues,
        NULLIFIER_PADDING_CHUNKS
    );

    onStatus('Preflight verifying proof (no wallet approval needed)...');
    const verified = await preflightVerify(proof, publicSignals);
    if (!verified) {
        throw new Error(`Preflight verify failed. ${formatPublicSignals(publicSignals)}`);
    }
    onStatus('Preflight verified. Uploading proof to chain...');
    const proofNonce = generateProofNonce();
    const proofAccount = deriveProofAccount(program.programId, owner, proofNonce);
    const storeIx = await program.methods
        .storeProof({
            nonce: new BN(proofNonce.toString()),
            recipient: owner,
            destinationAta: owner,
            mint,
            proof: Buffer.from(proofBytes),
            publicInputs: Buffer.from(publicInputsBytes),
        })
        .accounts({
            proofAccount,
            proofOwner: owner,
            systemProgram: SystemProgram.programId,
        })
        .instruction();
    const storeTx = new Transaction().add(storeIx);
    const { blockhash: storeBlockhash, lastValidBlockHeight: storeLastValid } =
        await provider.connection.getLatestBlockhash();
    storeTx.feePayer = owner;
    storeTx.recentBlockhash = storeBlockhash;
    const signedStoreTx = await provider.wallet.signTransaction(storeTx);
    const storeSig = await provider.connection.sendRawTransaction(signedStoreTx.serialize());
    await provider.connection.confirmTransaction(
        { signature: storeSig, blockhash: storeBlockhash, lastValidBlockHeight: storeLastValid },
        'confirmed'
    );
    onStatus('Proof uploaded. Preparing transaction...');

    if (verifierProgram) {
        onStatus('Checking verifier key consistency...');
        const vkCheck = await checkVerifierKeyMatch(verifierProgram);
        if (!vkCheck.ok) {
            throw new Error(`Verifier key mismatch on-chain: ${vkCheck.mismatch}`);
        }
    }
    onStatus('Verifier key matches. Submitting transaction...');

    const ix = await program.methods
        .internalTransferWithProof({
            newRoot: Buffer.from(newRoot),
            outputCiphertexts: Buffer.from(outputCiphertexts),
        })
        .accounts({
            config,
            shieldedState,
            identityRegistry: deriveIdentityRegistry(program.programId),
            nullifierSet: nullifierSets[0],
            proofAccount,
            proofOwner: owner,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
        })
        .remainingAccounts(
            nullifierSets.slice(1).map((account) => ({
                pubkey: account,
                isWritable: true,
                isSigner: false,
            }))
        )
        .instruction();

    const lookupTableAddresses = [
        config,
        shieldedState,
        deriveIdentityRegistry(program.programId),
        verifierKey,
        VERIFIER_PROGRAM_ID,
        mint,
        ...nullifierSets,
    ];
    const lookupTable = await getEnvLookupTable(provider, lookupTableAddresses);
    const lutViolations = getLutIndexViolations(lookupTable, lookupTableAddresses);
    if (lutViolations.length > 0) {
        const sample = lutViolations[0];
        onStatus(
            `Lookup table index too large for v0: ${sample.address} at index ${sample.index}. Recreate LUT with required addresses in first 256 entries.`
        );
        throw new Error('Lookup table indices exceed u8 range (index > 255).');
    }
    const lookupTableAddressList = lookupTable.state.addresses.map((addr) => addr.toBase58());
    if (inputNotes.length > 1) {
        const missing = getMissingLutAddresses(lookupTable, lookupTableAddresses);
        if (missing.length > 0) {
            onStatus(
                `LUT missing ${missing.length} addresses for internal transfer (may still fit). Proceeding so relayer can auto-extend.`
            );
        }
    }

    let signature: string;
    if (RELAYER_PUBKEY) {
        onStatus('Preparing relayer transaction...');
        const { blockhash } = await provider.connection.getLatestBlockhash();
        const computeIxs = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
        ];
        const message = new TransactionMessage({
            payerKey: RELAYER_PUBKEY,
            recentBlockhash: blockhash,
            instructions: [...computeIxs, ix],
        }).compileToV0Message([lookupTable]);
        const tx = new VersionedTransaction(message);
        const relayerResult = await submitViaRelayerSigned(
            provider,
            tx,
            provider.wallet.publicKey,
            signMessage,
            lookupTableAddressList
        );
        signature = relayerResult.signature;
        onStatus(`Relayer submitted tx: ${signature}`);
        await provider.connection.confirmTransaction(signature, 'confirmed');
    } else {
        const { blockhash } = await provider.connection.getLatestBlockhash();
        const computeIxs = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
        ];
        const message = new TransactionMessage({
            payerKey: provider.wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: [...computeIxs, ix],
        }).compileToV0Message([lookupTable]);
        const tx = new VersionedTransaction(message);
        const signed = await provider.wallet.signTransaction(tx);
        signature = await provider.connection.sendRawTransaction(signed.serialize());
        await provider.connection.confirmTransaction(signature, 'confirmed');
    }
 
    inputNotes.forEach((note) => markNoteSpent(mint, owner, note.id));
    outputNotes.forEach((note, index) => {
        if (note && outputEnabled[index]) {
            addNote(mint, owner, note);
        }
    });
    saveCommitments(mint, owner, updatedCommitments, true);
    onRootChange(newRoot);
    onStatus('Internal transfer complete.');
    return { signature, nullifier: built.nullifierValues[0] ?? 0n, newRoot };
}

export async function runExternalTransferFlow(params: {
    program: Program;
    verifierProgram: Program | null;
    mint: PublicKey;
    recipient: PublicKey;
    amount: string;
    mintDecimals: number;
    deliverAsset?: 'sol' | 'wsol';
    root: Uint8Array;
    nextNullifier: () => number;
    onStatus: StatusHandler;
    onDebit: (amount: bigint) => void;
    onRootChange?: (next: Uint8Array) => void;
    ensureRecipientSecret?: () => Promise<void>;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
    rescanNotes?: () => Promise<void>;
}): Promise<{ signature: string; amountBaseUnits: bigint; nullifier: bigint }> {
    const {
        program,
        verifierProgram,
        mint,
        recipient,
        amount,
        mintDecimals,
        deliverAsset = 'sol',
        root,
        nextNullifier: _nextNullifier,
        onStatus,
        onDebit,
        onRootChange,
        ensureRecipientSecret,
        signMessage,
        rescanNotes,
    } = params;
    const provider = getProvider(program);
    const owner = provider.wallet.publicKey;
    const wantsSol = deliverAsset === 'sol';
    if (wantsSol && !mint.equals(WSOL_MINT)) {
        throw new Error('SOL transfers are only supported for the WSOL mint.');
    }
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const vault = deriveVault(program.programId, mint);
    const { shieldedState, rootBytes, commitmentCount } = await fetchShieldedState(program, mint);
    await ensureIdentityRegistered(program, owner, onStatus, signMessage);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const destinationAta =
        wantsSol && mint.equals(WSOL_MINT)
            ? await getAssociatedTokenAddress(mint, recipient)
            : await ensureAta(provider, mint, recipient);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);
    const vaultAccount = await program.account.vaultPool.fetch(vault);
    const vaultNonce = new BN(
        vaultAccount.nonce?.toString?.() ?? vaultAccount.nonce ?? '0'
    );
    const [tempAuthority] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('temp_wsol'),
            recipient.toBuffer(),
            vaultNonce.toArrayLike(Buffer, 'le', 8),
        ],
        program.programId
    );
    const tempWsolAta = await getAssociatedTokenAddress(mint, tempAuthority, true);

    let baseUnits = parseTokenAmount(amount, mintDecimals);
    let inputNotes: NoteRecord[] = [];
    let total = 0n;
    let commitments: bigint[];
    try {
        commitments = getCommitmentsWithSync(mint, owner, commitmentCount, onStatus);
    } catch (error) {
        if (isNoteStoreOutOfSyncError(error)) {
            onStatus('Local note store missing notes. Attempting rescan before transfer...');
            if (rescanNotes) {
                await rescanNotes();
            } else if (signMessage) {
                await rescanNotesForOwner({
                    program,
                    mint,
                    owner,
                    onStatus,
                    signMessage,
                });
            } else {
                throw error;
            }
            commitments = getCommitmentsWithSync(mint, owner, commitmentCount, onStatus);
        } else {
            throw error;
        }
    }
    let { root: derivedRoot } = await buildMerkleTree(commitments);
    let derivedRootBytes = bigIntToBytes32(derivedRoot);
    if (!bytesEqual(root, derivedRootBytes)) {
        onStatus('Provided root does not match local notes; using on-chain root.');
        onRootChange?.(derivedRootBytes);
    }
    if (!bytesEqual(rootBytes, derivedRootBytes)) {
        commitments = await rescanNotesWithFallback({
            program,
            mint,
            owner,
            commitmentCount,
            onStatus,
            signMessage,
            rescanNotes,
        });
        ({ root: derivedRoot } = await buildMerkleTree(commitments));
        derivedRootBytes = bigIntToBytes32(derivedRoot);
        if (!bytesEqual(root, derivedRootBytes)) {
            onStatus('Provided root does not match local notes; using on-chain root.');
            onRootChange?.(derivedRootBytes);
        }
        if (!bytesEqual(rootBytes, derivedRootBytes)) {
            throw new Error('On-chain root does not match local note store.');
        }
    }

    const spendableNotes = listSpendableNotes(mint, owner);
    const spendableTotal = sumSpendableNotes(mint, owner);
    onStatus(
        `External transfer inputs: requested=${formatAmount(baseUnits, mintDecimals)} feeBps=${RELAYER_FEE_BPS} commitments=${commitments.length}/${commitmentCount.toString()} notes=${spendableNotes.length} spendable=${formatAmount(spendableTotal, mintDecimals)}`
    );
    if (spendableNotes.length > 0 && spendableNotes.length <= 6) {
        onStatus(
            `Spendable notes: ${spendableNotes
                .map((note) => formatAmount(BigInt(note.amount), mintDecimals))
                .join(', ')}`
        );
    }

    if (!RELAYER_PUBKEY) {
        throw new Error('Missing relayer public key for relayed external transfers.');
    }
    const relayerFeeBps = RELAYER_FEE_BPS;
    if (!Number.isInteger(relayerFeeBps) || relayerFeeBps < 0 || relayerFeeBps > 10_000) {
        throw new Error('Invalid relayer fee bps.');
    }
    let selectionTarget = baseUnits + computeRelayerFee(baseUnits, relayerFeeBps);
    ({ notes: inputNotes, total } = selectNotesForAmount(mint, owner, selectionTarget, MAX_INPUTS));
    onStatus(
        `Selection target=${formatAmount(selectionTarget, mintDecimals)} selectedNotes=${inputNotes.length} total=${formatAmount(total, mintDecimals)}`
    );
    if (inputNotes.length === 0) {
        throw new Error('Insufficient shielded balance for that amount.');
    }
    if (total < selectionTarget) {
        const maxAmount = (total * 10_000n) / (10_000n + BigInt(relayerFeeBps));
        if (maxAmount <= 0n) {
            throw new Error('Insufficient shielded balance for fee.');
        }
        if (maxAmount < baseUnits) {
            onStatus(
                `Reducing external transfer amount to ${formatTokenAmount(maxAmount, mintDecimals)} to cover relayer fee.`
            );
            baseUnits = maxAmount;
        }
        selectionTarget = baseUnits + computeRelayerFee(baseUnits, relayerFeeBps);
        ({ notes: inputNotes, total } = selectNotesForAmount(mint, owner, selectionTarget, MAX_INPUTS));
        onStatus(
            `Selection target=${formatAmount(selectionTarget, mintDecimals)} selectedNotes=${inputNotes.length} total=${formatAmount(total, mintDecimals)}`
        );
    }
    if (total < selectionTarget) {
        throw new Error('Insufficient shielded balance for fee.');
    }
    inputNotes.forEach(assertCiphertextFields);
    const feeAmount = computeRelayerFee(baseUnits, relayerFeeBps);
    const changeAmount = total - baseUnits - feeAmount;
    if (changeAmount < 0n) {
        throw new Error('Insufficient shielded balance for fee.');
    }
    onStatus(
        `External transfer amounts: send=${formatAmount(baseUnits, mintDecimals)} fee=${formatAmount(feeAmount, mintDecimals)} change=${formatAmount(changeAmount, mintDecimals)}`
    );

    const outputNotes: Array<NoteRecord | null> = [null, null];
    const outputEnabled = [0, 0];
    let nextIndex = commitments.length;
    if (changeAmount > 0n) {
        if (!signMessage) {
            throw new Error('Wallet must support message signing to derive view keys.');
        }
        if (ensureRecipientSecret) {
            await ensureRecipientSecret();
        }
        const ownerViewKey = await deriveViewKeypair({
            owner,
            signMessage,
            index: 0,
        });
        const { note: changeNote } = await createNote({
            mint,
            amount: changeAmount,
            recipientViewKey: ownerViewKey.pubkey,
            leafIndex: nextIndex,
        });
        outputNotes[1] = changeNote;
        outputEnabled[1] = 1;
        nextIndex += 1;
    }

    const updatedCommitments = commitments.slice();
    outputNotes.forEach((note, index) => {
        if (note && outputEnabled[index]) {
            updatedCommitments.push(BigInt(note.commitment));
        }
    });
    const { root: newRoot } = await buildMerkleTree(updatedCommitments);
    const newRootBytes = bigIntToBytes32(newRoot);
    const outputCiphertexts = buildOutputCiphertexts(outputNotes, outputEnabled);

    const built = await buildSpendProofInput({
        program,
        mint,
        owner,
        inputNotes,
        outputNotes,
        outputEnabled,
        amountOut: baseUnits,
        feeAmount,
        commitments,
        signMessage,
    });
    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof(built.input);
    onStatus(`Public signals: ${formatPublicSignals(publicSignals)}`);
    onStatus(
        `Output commitments: [${built.outputCommitments
            .map((value) => Buffer.from(value).toString('hex').slice(0, 8))
            .join(', ')}] outputEnabled=${outputEnabled.join(',')}`
    );
    const nullifierSets = await ensureNullifierSets(
        program,
        mint,
        built.nullifierValues,
        NULLIFIER_PADDING_CHUNKS
    );

    onStatus('Preflight verifying proof (no wallet approval needed)...');
    const verified = await preflightVerify(proof, publicSignals);
    if (!verified) {
        throw new Error(`Preflight verify failed. ${formatPublicSignals(publicSignals)}`);
    }
    onStatus('Preflight verified. Uploading proof to chain...');
    const proofNonce = generateProofNonce();
    const proofAccount = deriveProofAccount(program.programId, owner, proofNonce);
    const storeIx = await program.methods
        .storeProof({
            nonce: new BN(proofNonce.toString()),
            recipient,
            destinationAta,
            mint,
            proof: Buffer.from(proofBytes),
            publicInputs: Buffer.from(publicInputsBytes),
        })
        .accounts({
            proofAccount,
            proofOwner: owner,
            systemProgram: SystemProgram.programId,
        })
        .instruction();
    const storeTx = new Transaction().add(storeIx);
    const { blockhash: storeBlockhash, lastValidBlockHeight: storeLastValid } =
        await provider.connection.getLatestBlockhash();
    storeTx.feePayer = owner;
    storeTx.recentBlockhash = storeBlockhash;
    const signedStoreTx = await provider.wallet.signTransaction(storeTx);
    const storeSig = await provider.connection.sendRawTransaction(signedStoreTx.serialize());
    await provider.connection.confirmTransaction(
        { signature: storeSig, blockhash: storeBlockhash, lastValidBlockHeight: storeLastValid },
        'confirmed'
    );
    onStatus('Proof uploaded. Preparing relayer transaction...');

    if (verifierProgram) {
        onStatus('Checking verifier key consistency...');
        const vkCheck = await checkVerifierKeyMatch(verifierProgram);
        if (!vkCheck.ok) {
            throw new Error(`Verifier key mismatch on-chain: ${vkCheck.mismatch}`);
        }
    }
    onStatus('Verifier key matches. Submitting to relayer...');

    const relayerFeeAta = relayerFeeBps > 0 ? await getAssociatedTokenAddress(mint, RELAYER_PUBKEY) : null;
    if (relayerFeeAta) {
        const relayerFeeAccount = await provider.connection.getAccountInfo(relayerFeeAta);
        if (!relayerFeeAccount) {
            throw new Error('Relayer fee ATA missing on-chain.');
        }
    }

    const ix = await program.methods
        .externalTransferWithProof({
            amount: new BN(baseUnits.toString()),
            relayerFeeBps,
            newRoot: Buffer.from(newRootBytes),
            outputCiphertexts,
            deliverSol: wantsSol && mint.equals(WSOL_MINT),
        })
        .accounts({
            config,
            payer: RELAYER_PUBKEY,
            vault,
            vaultAta,
            shieldedState,
            identityRegistry: deriveIdentityRegistry(program.programId),
            nullifierSet: nullifierSets[0],
            proofAccount,
            proofOwner: owner,
            destinationAta,
            recipient,
            tempAuthority,
            tempWsolAta,
            relayerFeeAta,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts(
            nullifierSets.slice(1).map((account) => ({
                pubkey: account,
                isWritable: true,
                isSigner: false,
            }))
        )
        .instruction();

    const lookupTableAddresses = [
        config,
        RELAYER_PUBKEY,
        vault,
        vaultAta,
        shieldedState,
        deriveIdentityRegistry(program.programId),
        destinationAta,
        recipient,
        tempAuthority,
        tempWsolAta,
        verifierKey,
        VERIFIER_PROGRAM_ID,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        SystemProgram.programId,
        ...nullifierSets,
    ];
    if (relayerFeeAta) {
        lookupTableAddresses.push(relayerFeeAta);
    }
    if (NULLIFIER_PADDING_CHUNKS > 0) {
        onStatus(
            `Nullifier padding: ${NULLIFIER_PADDING_CHUNKS} chunk(s) (including decoy sets for privacy).`
        );
    }
    const lookupTable = await getEnvLookupTable(provider, lookupTableAddresses);
    const lutViolations = getLutIndexViolations(lookupTable, lookupTableAddresses);
    if (lutViolations.length > 0) {
        const sample = lutViolations[0];
        onStatus(
            `Lookup table index too large for v0: ${sample.address} at index ${sample.index}. Recreate LUT with required addresses in first 256 entries.`
        );
        throw new Error('Lookup table indices exceed u8 range (index > 255).');
    }
    if (inputNotes.length > 1) {
        const missing = getMissingLutAddresses(lookupTable, lookupTableAddresses);
        if (missing.length > 0) {
            onStatus(
                `LUT missing ${missing.length} addresses. Proceeding so relayer can auto-extend.`
            );
        }
    }
    const lookupTableAddressList = lookupTable.state.addresses.map((addr) => addr.toBase58());
    const { blockhash } = await provider.connection.getLatestBlockhash();
    let lookupStats = 'lutStats=unknown';
    const computeIxs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    ];
    const message = new TransactionMessage({
        payerKey: RELAYER_PUBKEY,
        recentBlockhash: blockhash,
        instructions: [...computeIxs, ix],
    }).compileToV0Message([lookupTable]);
    const lookup = message.addressTableLookups?.[0];
    const maxWritable = lookup?.writableIndexes?.reduce((max, value) => Math.max(max, value), -1) ?? -1;
    const maxReadonly = lookup?.readonlyIndexes?.reduce((max, value) => Math.max(max, value), -1) ?? -1;
    const maxIndex = Math.max(maxWritable, maxReadonly);
    lookupStats = `lutCount=${lookupTable.state.addresses.length} maxIndex=${maxIndex} writable=${lookup?.writableIndexes.length ?? 0} readonly=${lookup?.readonlyIndexes.length ?? 0}`;
    onStatus(`Relayer LUT stats: ${lookupStats}`);
    if (lookup && maxIndex > 255) {
        onStatus('Lookup index exceeds u8 range (index > 255). Recreate LUT with fewer entries.');
        throw new Error('Lookup index exceeds u8 range (index > 255).');
    }
    onStatus(
        `Relayer ix meta: keys=${ix.keys.length} dataLen=${ix.data.length ?? 'unknown'} dataByteLen=${
            (ix.data as Uint8Array | undefined)?.byteLength ?? 'unknown'
        } dataType=${ix.data?.constructor?.name ?? 'unknown'}`
    );
    onStatus(
        `Relayer message meta: staticKeys=${message.staticAccountKeys.length} instructions=${message.compiledInstructions.length}`
    );
    if (message.addressTableLookups && message.addressTableLookups.length > 0) {
        const firstLookup = message.addressTableLookups[0];
        onStatus(
            `Relayer message lookup meta: writable=${firstLookup.writableIndexes.length} readonly=${firstLookup.readonlyIndexes.length}`
        );
    }
    const compiled = message.compiledInstructions;
    if (compiled.length > 0) {
        const maxProgram = Math.max(...compiled.map((ix) => ix.programIdIndex));
        const maxAccount = Math.max(...compiled.flatMap((ix) => Array.from(ix.accountKeyIndexes)));
        onStatus(`Relayer ix indexes: maxProgram=${maxProgram} maxAccount=${maxAccount}`);
        const dataSizes = compiled.map((ix) => ix.data.length);
        onStatus(`Relayer ix data sizes: ${dataSizes.join(',')}`);
    }
    let tx = new VersionedTransaction(message);
    ensureDummySignatures(tx);
    onStatus(
        `Relayer tx meta: requiredSignatures=${tx.message.header.numRequiredSignatures} signatures=${tx.signatures.length} staticKeys=${tx.message.staticAccountKeys.length}`
    );
    try {
        const msgBytes = message.serialize();
        onStatus(`Relayer message bytes: len=${msgBytes.length}`);
        if (lookup) {
            const maxWritableIndex =
                lookup.writableIndexes.length > 0 ? Math.max(...lookup.writableIndexes) : -1;
            const maxReadonlyIndex =
                lookup.readonlyIndexes.length > 0 ? Math.max(...lookup.readonlyIndexes) : -1;
            onStatus(
                `Relayer lookup indexes: writableMax=${maxWritableIndex} readonlyMax=${maxReadonlyIndex}`
            );
        }
    } catch (error) {
        onStatus(
            `Relayer message serialize failed: ${error instanceof Error ? error.message : 'unknown error'} (${lookupStats})`
        );
        try {
            const fallback = new TransactionMessage({
                payerKey: RELAYER_PUBKEY,
                recentBlockhash: blockhash,
                instructions: [ix],
            }).compileToV0Message([]);
            const fallbackBytes = fallback.serialize();
            onStatus(`Relayer fallback message bytes: len=${fallbackBytes.length}`);
        } catch (fallbackError) {
            onStatus(
                `Relayer fallback serialize failed: ${
                    fallbackError instanceof Error ? fallbackError.message : 'unknown error'
                }`
            );
        }
        throw error;
    }
    let relayerBytes: Uint8Array;
    try {
        relayerBytes = tx.serialize();
    } catch (error) {
        onStatus(
            `Relayer tx serialize failed: ${error instanceof Error ? error.message : 'unknown error'} (${lookupStats})`
        );
        throw error;
    }
    onStatus(
        `Relayer tx bytes: len=${relayerBytes.length} firstByte=${relayerBytes[0]} (signature count byte)`
    );
    onStatus(`Relayer url: ${RELAYER_URL}`);
    const relayerResult = await submitViaRelayerSigned(
        provider,
        tx,
        provider.wallet.publicKey,
        signMessage,
        lookupTableAddressList
    );
        onStatus(`Relayer submitted tx: ${relayerResult.signature}`);
        await logNoteOutputsForSignature(program, relayerResult.signature, onStatus);
        let didRescan = false;
        const relayerTx = await program.provider.connection.getTransaction(relayerResult.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
        });
        const minContextSlot = relayerTx?.slot;
        const expectedCommitments = commitmentCount + BigInt(outputEnabled[0] + outputEnabled[1]);
        const expectedRoot = outputEnabled[1] ? newRootBytes : undefined;
        const synced = await waitForShieldedStateUpdate({
            program,
            mint,
            expectedCommitments,
            expectedRoot,
            onStatus,
            minContextSlot,
        });
        if (!synced) {
            onStatus('Relayed transfer not yet reflected on current RPC. Rescanning notes...');
            if (signMessage) {
                await rescanNotesForOwner({
                    program,
                    mint,
                    owner: provider.wallet.publicKey,
                    onStatus,
                    signMessage,
                });
                didRescan = true;
                const verified = await waitForShieldedStateUpdate({
                    program,
                    mint,
                    expectedCommitments,
                    expectedRoot,
                    onStatus,
                    minContextSlot,
                });
                if (!verified) {
                    throw new Error('Relayed transfer not reflected on chain after rescan.');
                }
            } else {
                throw new Error('Relayed transfer not yet reflected on current RPC. Connect a wallet to rescan.');
            }
        } else {
            onStatus(
                `Shielded state synced: commitments=${synced.commitmentCount.toString()} root=${Buffer.from(synced.rootBytes)
                    .toString('hex')
                    .slice(0, 16)}...`
            );
        }
        if (!didRescan) {
            inputNotes.forEach((note) => markNoteSpent(mint, owner, note.id));
            outputNotes.forEach((note, index) => {
                if (note && outputEnabled[index]) {
                    addNote(mint, owner, note);
                }
            });
            saveCommitments(mint, owner, updatedCommitments, true);
        }
        if (outputEnabled.some((flag) => flag === 1)) {
            onRootChange?.(newRootBytes);
        }
    onDebit(baseUnits);
    onStatus('External transfer complete.');
    return {
        signature: relayerResult.signature,
        amountBaseUnits: baseUnits,
        nullifier: built.nullifierValues[0] ?? 0n,
    };
}
