import { Buffer } from 'buffer';
import { BN, Program } from '@coral-xyz/anchor';
import type { AnchorProvider } from '@coral-xyz/anchor';
import {
    AddressLookupTableAccount,
    PublicKey,
    Transaction,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    getAccount,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import {
    deriveAuthorization,
    deriveConfig,
    deriveIdentityRegistry,
    deriveShielded,
    deriveVault,
    deriveVerifierKey,
} from './pda';
import { concatBytes, randomBytes, sha256 } from './crypto';
import {
    computeNullifier,
    formatPublicSignals,
    generateProof,
    preflightVerify,
    bigIntToBytes32,
} from './prover';
import { ensureNullifierSets } from './nullifier';
import { LUT_ADDRESS, RELAYER_TRUSTED, RELAYER_URL, VERIFIER_PROGRAM_ID } from './config';
import { submitViaRelayer } from './relayer';
import { checkVerifierKeyMatch } from './verifierKey';
import { parseTokenAmount } from './amount';
import { buildMerkleTree, getMerklePath, MERKLE_DEPTH } from './merkle';
import {
    addNote,
    buildAmountCiphertext,
    createNote,
    type NoteRecord,
    getRecipientKeypair,
    loadNotes,
    listSpendableNotes,
    markNoteSpent,
    saveNotes,
    recipientTagHash,
    selectNotesForAmount,
} from './notes';
import {
    buildIdentityRoot,
    getIdentityCommitment,
    getIdentityMerklePath,
    getOrCreateIdentitySecret,
    loadIdentityCommitments,
    saveIdentityCommitments,
    setIdentityLeafIndex,
} from './identity';

type StatusHandler = (message: string) => void;

const MAX_INPUTS = 4;
const MAX_OUTPUTS = 2;
const ZERO_PATH_ELEMENTS = Array.from({ length: MERKLE_DEPTH }, () => '0');
const ZERO_PATH_INDEX = Array.from({ length: MERKLE_DEPTH }, () => 0);

const getEnvLookupTable = async (
    provider: AnchorProvider,
    _addresses: PublicKey[]
): Promise<AddressLookupTableAccount | null> => {
    if (!LUT_ADDRESS) {
        return null;
    }
    const existing = await provider.connection.getAddressLookupTable(new PublicKey(LUT_ADDRESS));
    if (!existing.value) {
        throw new Error('Lookup table not found for LUT_ADDRESS.');
    }
    return existing.value;
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

const getCommitmentsWithSync = (
    mint: PublicKey,
    commitmentCount: bigint,
    onStatus?: StatusHandler
): bigint[] => {
    const expected = Number(commitmentCount);
    const notes = loadNotes(mint).sort((a, b) => a.leafIndex - b.leafIndex);
    if (notes.length > expected) {
        onStatus?.('Local note store ahead of chain. Trimming to on-chain commitment count.');
        const trimmed = notes.slice(0, expected);
        saveNotes(mint, trimmed);
        return trimmed.map((note) => BigInt(note.commitment));
    }
    if (notes.length !== expected) {
        throw new Error(
            `Local note store is out of sync with on-chain commitment count (local=${notes.length}, on-chain=${expected}).`
        );
    }
    return notes.map((note) => BigInt(note.commitment));
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
        await provider.sendAndConfirm(new Transaction().add(ix));
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
    const account = await program.account.shieldedState.fetch(shieldedState);
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
    const account = await program.account.identityRegistry.fetch(identityRegistry);
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

async function ensureIdentityRegistered(program: Program, owner: PublicKey, onStatus?: StatusHandler) {
    const provider = getProvider(program);
    const { identityRegistry, rootBytes, commitmentCount } = await fetchIdentityRegistry(program);
    const localCommitments = loadIdentityCommitments(program.programId);
    if (localCommitments.length !== Number(commitmentCount)) {
        throw new Error('Local identity registry is out of sync with on-chain root.');
    }
    if (localCommitments.length > 0) {
        const localRoot = await buildIdentityRoot(program.programId);
        const localRootBytes = bigIntToBytes32(localRoot);
        if (!bytesEqual(rootBytes, localRootBytes)) {
            throw new Error('Local identity registry root does not match on-chain root.');
        }
    }
    const commitment = await getIdentityCommitment(owner, program.programId);
    let index = localCommitments.findIndex((entry) => entry === commitment);
    if (index === -1) {
        const newCommitments = [...localCommitments, commitment];
        const { root } = await buildMerkleTree(newCommitments);
        const newRoot = bigIntToBytes32(root);
        onStatus?.('Registering identity...');
        await program.methods
            .registerIdentity({
                commitment: Buffer.from(bigIntToBytes32(commitment)),
                newRoot: Buffer.from(newRoot),
            })
            .accounts({
                identityRegistry,
                payer: owner,
            })
            .rpc();
        saveIdentityCommitments(program.programId, newCommitments);
        index = newCommitments.length - 1;
        setIdentityLeafIndex(owner, program.programId, index);
        return { identityRegistry, rootBytes: newRoot };
    }
    setIdentityLeafIndex(owner, program.programId, index);
    return { identityRegistry, rootBytes };
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
}) {
    const { program, mint, owner, inputNotes, outputNotes, outputEnabled, amountOut, feeAmount, commitments } = params;
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
    const fallbackRecipient = await getRecipientKeypair(owner);
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
        await getIdentityMerklePath(owner, program.programId);
    const identitySecret = await getOrCreateIdentitySecret(owner, program.programId);

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
    onStatus: StatusHandler;
    onRootChange: (next: Uint8Array) => void;
    onCredit: (amount: bigint) => void;
}): Promise<{ signature: string; amountBaseUnits: bigint; newRoot: Uint8Array }> {
    const { program, mint, amount, mintDecimals, onStatus, onRootChange, onCredit } = params;
    const provider = getProvider(program);
    onStatus('Depositing into VeilPay vault...');
    const config = deriveConfig(program.programId);
    const vault = deriveVault(program.programId, mint);
    const { shieldedState, rootBytes, commitmentCount } = await fetchShieldedState(program, mint);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const userAta = await getAssociatedTokenAddress(mint, provider.wallet.publicKey);

    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const commitments = getCommitmentsWithSync(mint, commitmentCount, onStatus);
    const leafIndex = Number(commitmentCount);
    const { root: currentRoot } = await buildMerkleTree(commitments);
    const currentRootBytes = bigIntToBytes32(currentRoot);
    if (!bytesEqual(rootBytes, currentRootBytes)) {
        throw new Error('On-chain root does not match local note store.');
    }
    const { note, plaintext: ciphertext } = await createNote({
        mint,
        amount: baseUnits,
        recipient: provider.wallet.publicKey,
        leafIndex,
    });
    const commitmentValue = BigInt(note.commitment);
    commitments.push(commitmentValue);
    const { root } = await buildMerkleTree(commitments);
    const newRoot = bigIntToBytes32(root);

    const signature = await program.methods
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
            user: provider.wallet.publicKey,
            userAta,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

    addNote(mint, note);
    onRootChange(newRoot);
    onCredit(baseUnits);
    onStatus('Deposit complete.');
    return { signature, amountBaseUnits: baseUnits, newRoot };
}

export async function runWithdrawFlow(params: {
    program: Program;
    verifierProgram: Program | null;
    mint: PublicKey;
    recipient: PublicKey;
    amount: string;
    mintDecimals: number;
    root: Uint8Array;
    nextNullifier: () => number;
    onStatus: StatusHandler;
    onDebit: (amount: bigint) => void;
    onRootChange?: (next: Uint8Array) => void;
}): Promise<{ signature: string; amountBaseUnits: bigint; nullifier: bigint }> {
    const {
        program,
        verifierProgram,
        mint,
        recipient,
        amount,
        mintDecimals,
        root,
        nextNullifier: _nextNullifier,
        onStatus,
        onDebit,
        onRootChange,
    } = params;
    const provider = getProvider(program);
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const vault = deriveVault(program.programId, mint);
    const { shieldedState, rootBytes, commitmentCount } = await fetchShieldedState(program, mint);
    await ensureIdentityRegistered(program, provider.wallet.publicKey, onStatus);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const recipientAta = await ensureAta(provider, mint, recipient);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const { notes: inputNotes, total } = selectNotesForAmount(mint, baseUnits, MAX_INPUTS);
    if (inputNotes.length === 0 || total < baseUnits) {
        throw new Error('Insufficient shielded balance for that amount.');
    }
    inputNotes.forEach(assertCiphertextFields);
    const commitments = getCommitmentsWithSync(mint, commitmentCount, onStatus);
    const { root: derivedRoot } = await buildMerkleTree(commitments);
    const derivedRootBytes = bigIntToBytes32(derivedRoot);
    if (!bytesEqual(root, derivedRootBytes)) {
        onStatus('Provided root does not match local notes; using on-chain root.');
        onRootChange?.(derivedRootBytes);
    }
    if (!bytesEqual(rootBytes, derivedRootBytes)) {
        throw new Error('On-chain root does not match local note store.');
    }

    const feeAmount = 0n;
    const changeAmount = total - baseUnits - feeAmount;
    if (changeAmount < 0n) {
        throw new Error('Insufficient shielded balance for fee.');
    }

    const outputNotes: Array<NoteRecord | null> = [null, null];
    const outputEnabled = [0, 0];
    let nextIndex = commitments.length;
    if (changeAmount > 0n) {
        const { note: changeNote } = await createNote({
            mint,
            amount: changeAmount,
            recipient: provider.wallet.publicKey,
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

    const built = await buildSpendProofInput({
        program,
        mint,
        owner: provider.wallet.publicKey,
        inputNotes,
        outputNotes,
        outputEnabled,
        amountOut: baseUnits,
        feeAmount,
        commitments,
    });
    const { proofBytes: proofBytesOut, publicInputsBytes: publicInputsBytesOut, publicSignals: publicSignalsOut, proof: proofOut } =
        await generateProof(built.input);

    const nullifierSets = await ensureNullifierSets(program, mint, built.nullifierValues);

    onStatus('Preflight verifying proof (no wallet approval needed)...');
    const verified = await preflightVerify(proofOut, publicSignalsOut);
    if (!verified) {
        throw new Error(`Preflight verify failed. ${formatPublicSignals(publicSignalsOut)}`);
    }
    onStatus('Preflight verified. Preparing relayer transaction...');

    if (verifierProgram) {
        onStatus('Checking verifier key consistency...');
        const vkCheck = await checkVerifierKeyMatch(verifierProgram);
        if (!vkCheck.ok) {
            throw new Error(`Verifier key mismatch on-chain: ${vkCheck.mismatch}`);
        }
    }
    onStatus('Verifier key matches. Submitting to relayer...');

    const ix = await program.methods
        .withdraw({
            amount: new BN(baseUnits.toString()),
            proof: Buffer.from(proofBytesOut),
            publicInputs: Buffer.from(publicInputsBytesOut),
            relayerFeeBps: 0,
            newRoot: Buffer.from(newRootBytes),
        })
        .accounts({
            config,
            vault,
            vaultAta,
            shieldedState,
            identityRegistry: deriveIdentityRegistry(program.programId),
            nullifierSet: nullifierSets[0],
            recipientAta,
            relayerFeeAta: recipientAta,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .remainingAccounts(
            nullifierSets.slice(1).map((account) => ({
                pubkey: account,
                isWritable: true,
                isSigner: false,
            }))
        )
        .instruction();

    const lookupTable = await getEnvLookupTable(provider, [
        config,
        vault,
        vaultAta,
        shieldedState,
        deriveIdentityRegistry(program.programId),
        nullifierSets[0],
        recipientAta,
        verifierKey,
        VERIFIER_PROGRAM_ID,
        mint,
        TOKEN_PROGRAM_ID,
    ]);
    if (lookupTable) {
        const { blockhash } = await provider.connection.getLatestBlockhash();
        const message = new TransactionMessage({
            payerKey: provider.wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: [ix],
        }).compileToV0Message([lookupTable]);
        const tx = new VersionedTransaction(message);
        const relayerResult = await submitViaRelayer(provider, tx);
        inputNotes.forEach((note) => markNoteSpent(mint, note.id));
        outputNotes.forEach((note, index) => {
            if (note && outputEnabled[index]) {
                addNote(mint, note);
            }
        });
        if (outputEnabled.some((flag) => flag === 1)) {
            onRootChange?.(newRootBytes);
        }
        onDebit(baseUnits);
        onStatus('Withdraw complete.');
        return {
            signature: relayerResult.signature,
            amountBaseUnits: baseUnits,
            nullifier: built.nullifierValues[0] ?? 0n,
        };
    }

    const relayerResult = await submitViaRelayer(provider, new Transaction().add(ix));
    inputNotes.forEach((note) => markNoteSpent(mint, note.id));
    outputNotes.forEach((note, index) => {
        if (note && outputEnabled[index]) {
            addNote(mint, note);
        }
    });
    if (outputEnabled.some((flag) => flag === 1)) {
        onRootChange?.(newRootBytes);
    }
    onDebit(baseUnits);
    onStatus('Withdraw complete.');
    return {
        signature: relayerResult.signature,
        amountBaseUnits: baseUnits,
        nullifier: built.nullifierValues[0] ?? 0n,
    };
}

export async function runCreateAuthorizationFlow(params: {
    program: Program;
    mint: PublicKey;
    payer: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
    payee: PublicKey;
    amount: string;
    mintDecimals: number;
    expirySlots: string;
    onStatus: StatusHandler;
}): Promise<{
    intentHash: Uint8Array;
    signature: string;
    expirySlot: bigint;
    amountCiphertext: Uint8Array;
}> {
    const { program, mint, payer, signMessage, payee, amount: _amount, mintDecimals, expirySlots, onStatus } = params;
    const amountValue = parseTokenAmount(_amount, mintDecimals);
    const { ciphertext: amountCiphertext, payeeTagHash } = await buildAmountCiphertext({
        payee,
        amount: amountValue,
    });
    const expirySlot = BigInt(Date.now()) + BigInt(expirySlots);
    const intentHashBytes = await sha256(
        concatBytes([
            mint.toBytes(),
            bigIntToBytes32(payeeTagHash),
            amountCiphertext,
            new Uint8Array(new BN(expirySlot.toString()).toArray('be', 8)),
        ])
    );

    const domain = `VeilPay:v1:${program.programId.toBase58()}:localnet`;
    const intentSignature = RELAYER_TRUSTED
        ? null
        : await signMessage(concatBytes([new TextEncoder().encode(domain), intentHashBytes]));

    const intentPayload: Record<string, unknown> = {
        intentHash: Buffer.from(intentHashBytes).toString('base64'),
        mint: mint.toBase58(),
        payeeTagHash: Buffer.from(bigIntToBytes32(payeeTagHash)).toString('base64'),
        amountCiphertext: Buffer.from(amountCiphertext).toString('base64'),
        expirySlot: expirySlot.toString(),
        circuitId: 0,
        proofHash: Buffer.from(randomBytes(32)).toString('base64'),
    };
    if (!RELAYER_TRUSTED) {
        intentPayload.payer = payer.toBase58();
        intentPayload.signature = Buffer.from(intentSignature!).toString('base64');
        intentPayload.domain = domain;
    }

    await fetch(`${RELAYER_URL}/intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(intentPayload),
    });

    const config = deriveConfig(program.programId);
    const authorization = deriveAuthorization(program.programId, intentHashBytes);
    const signature = await program.methods
        .createAuthorization({
            intentHash: Buffer.from(intentHashBytes),
            payeeTagHash: Buffer.from(bigIntToBytes32(payeeTagHash)),
            mint,
            amountCiphertext: Buffer.from(amountCiphertext),
            expirySlot: new BN(expirySlot.toString()),
            circuitId: 0,
            proofHash: Buffer.from(randomBytes(32)),
            relayerPubkey: PublicKey.default,
        })
        .accounts({
            config,
            authorization,
            payer,
        })
        .rpc();

    onStatus('Authorization created.');
    return {
        intentHash: intentHashBytes,
        signature,
        expirySlot,
        amountCiphertext,
    };
}

export async function runSettleAuthorizationFlow(params: {
    program: Program;
    verifierProgram: Program | null;
    mint: PublicKey;
    payee: PublicKey;
    amount: string;
    mintDecimals: number;
    root: Uint8Array;
    nextNullifier: () => number;
    intentHash: Uint8Array;
    onStatus: StatusHandler;
    onDebit: (amount: bigint) => void;
    onRootChange?: (next: Uint8Array) => void;
}): Promise<{ signature: string; amountBaseUnits: bigint; nullifier: bigint }> {
    const {
        program,
        verifierProgram,
        mint,
        payee,
        amount,
        mintDecimals,
        root,
        nextNullifier: _nextNullifier,
        intentHash,
        onStatus,
        onDebit,
        onRootChange,
    } = params;
    const provider = getProvider(program);
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const authorization = deriveAuthorization(program.programId, intentHash);
    const vault = deriveVault(program.programId, mint);
    const { shieldedState, rootBytes, commitmentCount } = await fetchShieldedState(program, mint);
    await ensureIdentityRegistered(program, provider.wallet.publicKey, onStatus);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const recipientAta = await ensureAta(provider, mint, payee);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const { notes: inputNotes, total } = selectNotesForAmount(mint, baseUnits, MAX_INPUTS);
    if (inputNotes.length === 0 || total < baseUnits) {
        throw new Error('Insufficient shielded balance for that amount.');
    }
    inputNotes.forEach(assertCiphertextFields);
    const commitments = getCommitmentsWithSync(mint, commitmentCount, onStatus);
    const { root: derivedRoot } = await buildMerkleTree(commitments);
    const derivedRootBytes = bigIntToBytes32(derivedRoot);
    if (!bytesEqual(root, derivedRootBytes)) {
        onStatus('Provided root does not match local notes; using on-chain root.');
        onRootChange?.(derivedRootBytes);
    }
    if (!bytesEqual(rootBytes, derivedRootBytes)) {
        throw new Error('On-chain root does not match local note store.');
    }

    const feeAmount = 0n;
    const changeAmount = total - baseUnits - feeAmount;
    if (changeAmount < 0n) {
        throw new Error('Insufficient shielded balance for fee.');
    }

    const outputNotes: Array<NoteRecord | null> = [null, null];
    const outputEnabled = [0, 0];
    let nextIndex = commitments.length;
    if (changeAmount > 0n) {
        const { note: changeNote } = await createNote({
            mint,
            amount: changeAmount,
            recipient: provider.wallet.publicKey,
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

    const built = await buildSpendProofInput({
        program,
        mint,
        owner: provider.wallet.publicKey,
        inputNotes,
        outputNotes,
        outputEnabled,
        amountOut: baseUnits,
        feeAmount,
        commitments,
    });
    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof(built.input);
    const nullifierSets = await ensureNullifierSets(program, mint, built.nullifierValues);

    onStatus('Preflight verifying proof (no wallet approval needed)...');
    const verified = await preflightVerify(proof, publicSignals);
    if (!verified) {
        throw new Error(`Preflight verify failed. ${formatPublicSignals(publicSignals)}`);
    }
    onStatus('Preflight verified. Preparing relayer transaction...');

    if (verifierProgram) {
        onStatus('Checking verifier key consistency...');
        const vkCheck = await checkVerifierKeyMatch(verifierProgram);
        if (!vkCheck.ok) {
            throw new Error(`Verifier key mismatch on-chain: ${vkCheck.mismatch}`);
        }
    }
    onStatus('Verifier key matches. Submitting to relayer...');

    const ix = await program.methods
        .settleAuthorization({
            amount: new BN(baseUnits.toString()),
            proof: Buffer.from(proofBytes),
            publicInputs: Buffer.from(publicInputsBytes),
            relayerFeeBps: 0,
            newRoot: Buffer.from(newRootBytes),
        })
        .accounts({
            config,
            authorization,
            vault,
            vaultAta,
            shieldedState,
            identityRegistry: deriveIdentityRegistry(program.programId),
            nullifierSet: nullifierSets[0],
            recipientAta,
            relayerFeeAta: recipientAta,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .remainingAccounts(
            nullifierSets.slice(1).map((account) => ({
                pubkey: account,
                isWritable: true,
                isSigner: false,
            }))
        )
        .instruction();

    const lookupTable = await getEnvLookupTable(provider, [
        config,
        authorization,
        vault,
        vaultAta,
        shieldedState,
        deriveIdentityRegistry(program.programId),
        recipientAta,
        verifierKey,
        VERIFIER_PROGRAM_ID,
        mint,
        TOKEN_PROGRAM_ID,
        ...nullifierSets,
    ]);
    if (lookupTable) {
        const { blockhash } = await provider.connection.getLatestBlockhash();
        const message = new TransactionMessage({
            payerKey: provider.wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: [ix],
        }).compileToV0Message([lookupTable]);
        const tx = new VersionedTransaction(message);
        const relayerResult = await submitViaRelayer(provider, tx);
        inputNotes.forEach((note) => markNoteSpent(mint, note.id));
        outputNotes.forEach((note, index) => {
            if (note && outputEnabled[index]) {
                addNote(mint, note);
            }
        });
        if (outputEnabled.some((flag) => flag === 1)) {
            onRootChange?.(newRootBytes);
        }
        onDebit(baseUnits);
        onStatus('Authorization settled.');
        return {
            signature: relayerResult.signature,
            amountBaseUnits: baseUnits,
            nullifier: built.nullifierValues[0] ?? 0n,
        };
    }

    const relayerResult = await submitViaRelayer(provider, new Transaction().add(ix));
    inputNotes.forEach((note) => markNoteSpent(mint, note.id));
    outputNotes.forEach((note, index) => {
        if (note && outputEnabled[index]) {
            addNote(mint, note);
        }
    });
    if (outputEnabled.some((flag) => flag === 1)) {
        onRootChange?.(newRootBytes);
    }
    onDebit(baseUnits);
    onStatus('Authorization settled.');
    return {
        signature: relayerResult.signature,
        amountBaseUnits: baseUnits,
        nullifier: built.nullifierValues[0] ?? 0n,
    };
}

export async function runInternalTransferFlow(params: {
    program: Program;
    verifierProgram: Program | null;
    mint: PublicKey;
    recipient: PublicKey;
    amount?: string;
    mintDecimals?: number;
    root: Uint8Array;
    nextNullifier: () => number;
    onStatus: StatusHandler;
    onRootChange: (next: Uint8Array) => void;
}): Promise<{ signature: string; nullifier: bigint; newRoot: Uint8Array }> {
    const {
        program,
        verifierProgram,
        mint,
        recipient,
        amount,
        mintDecimals,
        root,
        nextNullifier: _nextNullifier,
        onStatus,
        onRootChange,
    } = params;
    const provider = getProvider(program);
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const { shieldedState, rootBytes, commitmentCount } = await fetchShieldedState(program, mint);
    await ensureIdentityRegistered(program, provider.wallet.publicKey, onStatus);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);
    const commitments = getCommitmentsWithSync(mint, commitmentCount, onStatus);
    const { root: derivedRoot } = await buildMerkleTree(commitments);
    const derivedRootBytes = bigIntToBytes32(derivedRoot);
    if (!bytesEqual(root, derivedRootBytes)) {
        onStatus('Provided root does not match local notes; using on-chain root.');
        onRootChange?.(derivedRootBytes);
    }
    if (!bytesEqual(rootBytes, derivedRootBytes)) {
        throw new Error('On-chain root does not match local note store.');
    }

    const availableNotes = listSpendableNotes(mint);
    const targetAmount =
        amount && mintDecimals !== undefined ? parseTokenAmount(amount, mintDecimals) : null;
    let inputNotes: NoteRecord[] = [];
    let total = 0n;
    if (targetAmount !== null) {
        const selection = selectNotesForAmount(mint, targetAmount, MAX_INPUTS);
        inputNotes = selection.notes;
        total = selection.total;
    } else {
        inputNotes = availableNotes.slice(0, 1);
        total = inputNotes[0] ? BigInt(inputNotes[0].amount) : 0n;
    }
    if (inputNotes.length === 0) {
        throw new Error('No spendable note found for internal transfer.');
    }
    inputNotes.forEach(assertCiphertextFields);
    const transferAmount = targetAmount ?? BigInt(inputNotes[0].amount);
    if (total < transferAmount) {
        throw new Error('Insufficient shielded balance for that amount.');
    }

    const outputNotes: Array<NoteRecord | null> = [null, null];
    const outputEnabled = [1, 0];
    let nextIndex = commitments.length;
    const { note: recipientNote } = await createNote({
        mint,
        amount: transferAmount,
        recipient,
        leafIndex: nextIndex,
    });
    outputNotes[0] = recipientNote;
    nextIndex += 1;
    const changeAmount = total - transferAmount;
    if (changeAmount > 0n) {
        const { note: changeNote } = await createNote({
            mint,
            amount: changeAmount,
            recipient: provider.wallet.publicKey,
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

    const built = await buildSpendProofInput({
        program,
        mint,
        owner: provider.wallet.publicKey,
        inputNotes,
        outputNotes,
        outputEnabled,
        amountOut: 0n,
        feeAmount: 0n,
        commitments,
    });
    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof(built.input);
    const nullifierSets = await ensureNullifierSets(program, mint, built.nullifierValues);

    onStatus('Preflight verifying proof (no wallet approval needed)...');
    const verified = await preflightVerify(proof, publicSignals);
    if (!verified) {
        throw new Error(`Preflight verify failed. ${formatPublicSignals(publicSignals)}`);
    }
    onStatus('Preflight verified. Preparing transaction...');

    if (verifierProgram) {
        onStatus('Checking verifier key consistency...');
        const vkCheck = await checkVerifierKeyMatch(verifierProgram);
        if (!vkCheck.ok) {
            throw new Error(`Verifier key mismatch on-chain: ${vkCheck.mismatch}`);
        }
    }
    onStatus('Verifier key matches. Submitting transaction...');

    const signature = await program.methods
        .internalTransfer({
            proof: Buffer.from(proofBytes),
            publicInputs: Buffer.from(publicInputsBytes),
            newRoot: Buffer.from(newRoot),
        })
        .accounts({
            config,
            shieldedState,
            identityRegistry: deriveIdentityRegistry(program.programId),
            nullifierSet: nullifierSets[0],
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
        .rpc();
 
    inputNotes.forEach((note) => markNoteSpent(mint, note.id));
    outputNotes.forEach((note, index) => {
        if (note && outputEnabled[index]) {
            addNote(mint, note);
        }
    });
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
    root: Uint8Array;
    nextNullifier: () => number;
    onStatus: StatusHandler;
    onDebit: (amount: bigint) => void;
    onRootChange?: (next: Uint8Array) => void;
}): Promise<{ signature: string; amountBaseUnits: bigint; nullifier: bigint }> {
    const {
        program,
        verifierProgram,
        mint,
        recipient,
        amount,
        mintDecimals,
        root,
        nextNullifier: _nextNullifier,
        onStatus,
        onDebit,
        onRootChange,
    } = params;
    const provider = getProvider(program);
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const vault = deriveVault(program.programId, mint);
    const { shieldedState, rootBytes, commitmentCount } = await fetchShieldedState(program, mint);
    await ensureIdentityRegistered(program, provider.wallet.publicKey, onStatus);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const destinationAta = await ensureAta(provider, mint, recipient);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const { notes: inputNotes, total } = selectNotesForAmount(mint, baseUnits, MAX_INPUTS);
    if (inputNotes.length === 0 || total < baseUnits) {
        throw new Error('Insufficient shielded balance for that amount.');
    }
    inputNotes.forEach(assertCiphertextFields);
    const commitments = getCommitmentsWithSync(mint, commitmentCount, onStatus);
    const { root: derivedRoot } = await buildMerkleTree(commitments);
    const derivedRootBytes = bigIntToBytes32(derivedRoot);
    if (!bytesEqual(root, derivedRootBytes)) {
        onStatus('Provided root does not match local notes; using on-chain root.');
        onRootChange?.(derivedRootBytes);
    }
    if (!bytesEqual(rootBytes, derivedRootBytes)) {
        throw new Error('On-chain root does not match local note store.');
    }

    const feeAmount = 0n;
    const changeAmount = total - baseUnits - feeAmount;
    if (changeAmount < 0n) {
        throw new Error('Insufficient shielded balance for fee.');
    }

    const outputNotes: Array<NoteRecord | null> = [null, null];
    const outputEnabled = [0, 0];
    let nextIndex = commitments.length;
    if (changeAmount > 0n) {
        const { note: changeNote } = await createNote({
            mint,
            amount: changeAmount,
            recipient: provider.wallet.publicKey,
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

    const built = await buildSpendProofInput({
        program,
        mint,
        owner: provider.wallet.publicKey,
        inputNotes,
        outputNotes,
        outputEnabled,
        amountOut: baseUnits,
        feeAmount,
        commitments,
    });
    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof(built.input);
    const nullifierSets = await ensureNullifierSets(program, mint, built.nullifierValues);

    onStatus('Preflight verifying proof (no wallet approval needed)...');
    const verified = await preflightVerify(proof, publicSignals);
    if (!verified) {
        throw new Error(`Preflight verify failed. ${formatPublicSignals(publicSignals)}`);
    }
    onStatus('Preflight verified. Preparing relayer transaction...');

    if (verifierProgram) {
        onStatus('Checking verifier key consistency...');
        const vkCheck = await checkVerifierKeyMatch(verifierProgram);
        if (!vkCheck.ok) {
            throw new Error(`Verifier key mismatch on-chain: ${vkCheck.mismatch}`);
        }
    }
    onStatus('Verifier key matches. Submitting to relayer...');

    const ix = await program.methods
        .externalTransfer({
            amount: new BN(baseUnits.toString()),
            proof: Buffer.from(proofBytes),
            publicInputs: Buffer.from(publicInputsBytes),
            relayerFeeBps: 0,
            newRoot: Buffer.from(newRootBytes),
        })
        .accounts({
            config,
            vault,
            vaultAta,
            shieldedState,
            identityRegistry: deriveIdentityRegistry(program.programId),
            nullifierSet: nullifierSets[0],
            destinationAta,
            relayerFeeAta: destinationAta,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .remainingAccounts(
            nullifierSets.slice(1).map((account) => ({
                pubkey: account,
                isWritable: true,
                isSigner: false,
            }))
        )
        .instruction();

    const lookupTable = await getEnvLookupTable(provider, [
        config,
        vault,
        vaultAta,
        shieldedState,
        deriveIdentityRegistry(program.programId),
        destinationAta,
        verifierKey,
        VERIFIER_PROGRAM_ID,
        mint,
        TOKEN_PROGRAM_ID,
        ...nullifierSets,
    ]);
    if (lookupTable) {
        const { blockhash } = await provider.connection.getLatestBlockhash();
        const message = new TransactionMessage({
            payerKey: provider.wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: [ix],
        }).compileToV0Message([lookupTable]);
        const tx = new VersionedTransaction(message);
        const relayerResult = await submitViaRelayer(provider, tx);
        inputNotes.forEach((note) => markNoteSpent(mint, note.id));
        outputNotes.forEach((note, index) => {
            if (note && outputEnabled[index]) {
                addNote(mint, note);
            }
        });
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

    const relayerResult = await submitViaRelayer(provider, new Transaction().add(ix));
    inputNotes.forEach((note) => markNoteSpent(mint, note.id));
    outputNotes.forEach((note, index) => {
        if (note && outputEnabled[index]) {
            addNote(mint, note);
        }
    });
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
