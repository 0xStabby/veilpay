import { Buffer } from 'buffer';
import { BN, Program } from '@coral-xyz/anchor';
import type { AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    getAccount,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import {
    deriveAuthorization,
    deriveConfig,
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
import { ensureNullifierSet } from './nullifier';
import { RELAYER_TRUSTED, RELAYER_URL, VERIFIER_PROGRAM_ID } from './config';
import { submitViaRelayer } from './relayer';
import { checkVerifierKeyMatch } from './verifierKey';
import { parseTokenAmount } from './amount';
import { buildMerkleTree, getMerklePath } from './merkle';
import {
    addNote,
    buildAmountCiphertext,
    createNote,
    findSpendableNote,
    getRecipientKeypair,
    listCommitments,
    markNoteSpent,
    recipientTagHash,
} from './notes';

type StatusHandler = (message: string) => void;

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
    const commitments = listCommitments(mint);
    const leafIndex = Number(commitmentCount);
    if (commitments.length !== leafIndex) {
        throw new Error('Local note store is out of sync with on-chain commitment count.');
    }
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
    } = params;
    const provider = getProvider(program);
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const vault = deriveVault(program.programId, mint);
    const { shieldedState, rootBytes } = await fetchShieldedState(program, mint);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const recipientAta = await ensureAta(provider, mint, recipient);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const note = findSpendableNote(mint, baseUnits);
    if (!note) {
        throw new Error('No spendable note found for that amount.');
    }
    assertCiphertextFields(note);
    const commitmentValue = BigInt(note.commitment);
    const commitments = listCommitments(mint);
    const { root: derivedRoot, pathElements, pathIndices } = await getMerklePath(
        commitments,
        note.leafIndex
    );
    const derivedRootBytes = bigIntToBytes32(derivedRoot);
    if (!bytesEqual(root, derivedRootBytes)) {
        throw new Error('Selected note does not match the provided root.');
    }
    if (!bytesEqual(rootBytes, derivedRootBytes)) {
        throw new Error('On-chain root does not match local note store.');
    }
    const senderSecret = BigInt(note.senderSecret);
    const randomness = BigInt(note.randomness);
    const leafIndex = BigInt(note.leafIndex);
    const noteRecipientTagHash = BigInt(note.recipientTagHash);
    const { pubkey } = await getRecipientKeypair(provider.wallet.publicKey);
    const { pubkey } = await getRecipientKeypair(provider.wallet.publicKey);
    const nullifierValue = await computeNullifier(senderSecret, leafIndex);
    const nullifierSet = await ensureNullifierSet(program, mint, nullifierValue);

    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
        root: derivedRoot.toString(),
        nullifier: nullifierValue.toString(),
        recipient_tag_hash: noteRecipientTagHash.toString(),
        ciphertext_commitment: commitmentValue.toString(),
        circuit_id: '0',
        amount: baseUnits.toString(),
        randomness: randomness.toString(),
        sender_secret: senderSecret.toString(),
        leaf_index: leafIndex.toString(),
        path_elements: pathElements.map((value) => value.toString()),
        path_index: pathIndices,
        recipient_pubkey_x: pubkey[0].toString(),
        recipient_pubkey_y: pubkey[1].toString(),
        enc_randomness: note.encRandomness,
        c1x: note.c1x,
        c1y: note.c1y,
        c2_amount: note.c2Amount,
        c2_randomness: note.c2Randomness,
    });

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
        .withdraw({
            amount: new BN(baseUnits.toString()),
            proof: Buffer.from(proofBytes),
            publicInputs: Buffer.from(publicInputsBytes),
            nullifier: Buffer.from(bigIntToBytes32(nullifierValue)),
            root: Buffer.from(root),
            relayerFeeBps: 0,
        })
        .accounts({
            config,
            vault,
            vaultAta,
            shieldedState,
            nullifierSet,
            recipientAta,
            relayerFeeAta: recipientAta,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

    const relayerResult = await submitViaRelayer(provider, new Transaction().add(ix));
    markNoteSpent(mint, note.id);
    onDebit(baseUnits);
    onStatus('Withdraw complete.');
    return {
        signature: relayerResult.signature,
        amountBaseUnits: baseUnits,
        nullifier: nullifierValue,
    };
}

export async function runCreateAuthorizationFlow(params: {
    program: Program;
    mint: PublicKey;
    payer: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
    payee: PublicKey;
    amount: string;
    expirySlots: string;
    onStatus: StatusHandler;
}): Promise<{
    intentHash: Uint8Array;
    signature: string;
    expirySlot: bigint;
    amountCiphertext: Uint8Array;
}> {
    const { program, mint, payer, signMessage, payee, amount: _amount, expirySlots, onStatus } = params;
    const amountValue = BigInt(_amount);
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

    const newRecipientTagHash = await recipientTagHash(recipient);
    const signature = await program.methods
        .internalTransfer({
            proof: Buffer.from(proofBytes),
            publicInputs: Buffer.from(publicInputsBytes),
            nullifier: Buffer.from(bigIntToBytes32(nullifierValue)),
            root: Buffer.from(root),
            newRoot: Buffer.from(newRoot),
            ciphertextNew: Buffer.from(ciphertextNew),
            recipientTagHash: Buffer.from(bigIntToBytes32(newRecipientTagHash)),
        })
        .accounts({
            config,
            shieldedState,
            nullifierSet,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
        })
        .rpc();
 
    markNoteSpent(mint, note.id);
    addNote(mint, newNote);
    onRootChange(newRoot);
    onStatus('Internal transfer complete.');
    return { signature, nullifier: nullifierValue, newRoot };
}
        .createAuthorization({
            intentHash: Buffer.from(intentHashBytes),
            payeeTagHash: Buffer.from(payeeTagHash),
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
    } = params;
    const provider = getProvider(program);
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const authorization = deriveAuthorization(program.programId, intentHash);
    const vault = deriveVault(program.programId, mint);
    const { shieldedState, rootBytes } = await fetchShieldedState(program, mint);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const recipientAta = await ensureAta(provider, mint, payee);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const note = findSpendableNote(mint, baseUnits);
    if (!note) {
        throw new Error('No spendable note found for that amount.');
    }
    assertCiphertextFields(note);
    const commitmentValue = BigInt(note.commitment);
    const commitments = listCommitments(mint);
    const { root: derivedRoot, pathElements, pathIndices } = await getMerklePath(
        commitments,
        note.leafIndex
    );
    const derivedRootBytes = bigIntToBytes32(derivedRoot);
    if (!bytesEqual(root, derivedRootBytes)) {
        throw new Error('Selected note does not match the provided root.');
    }
    if (!bytesEqual(rootBytes, derivedRootBytes)) {
        throw new Error('On-chain root does not match local note store.');
    }
    const senderSecret = BigInt(note.senderSecret);
    const randomness = BigInt(note.randomness);
    const leafIndex = BigInt(note.leafIndex);
    const noteRecipientTagHash = BigInt(note.recipientTagHash);
    const { pubkey } = await getRecipientKeypair(provider.wallet.publicKey);
    const nullifierValue = await computeNullifier(senderSecret, leafIndex);
    const nullifierSet = await ensureNullifierSet(program, mint, nullifierValue);

    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
        root: derivedRoot.toString(),
        nullifier: nullifierValue.toString(),
        recipient_tag_hash: noteRecipientTagHash.toString(),
        ciphertext_commitment: commitmentValue.toString(),
        circuit_id: '0',
        amount: baseUnits.toString(),
        randomness: randomness.toString(),
        sender_secret: senderSecret.toString(),
        leaf_index: leafIndex.toString(),
        path_elements: pathElements.map((value) => value.toString()),
        path_index: pathIndices,
        recipient_pubkey_x: pubkey[0].toString(),
        recipient_pubkey_y: pubkey[1].toString(),
        enc_randomness: note.encRandomness,
        c1x: note.c1x,
        c1y: note.c1y,
        c2_amount: note.c2Amount,
        c2_randomness: note.c2Randomness,
    });

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
            nullifier: Buffer.from(bigIntToBytes32(nullifierValue)),
            root: Buffer.from(root),
            relayerFeeBps: 0,
        })
        .accounts({
            config,
            authorization,
            vault,
            vaultAta,
            shieldedState,
            nullifierSet,
            recipientAta,
            relayerFeeAta: recipientAta,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

    const relayerResult = await submitViaRelayer(provider, new Transaction().add(ix));
    markNoteSpent(mint, note.id);
    onDebit(baseUnits);
    onStatus('Authorization settled.');
    return {
        signature: relayerResult.signature,
        amountBaseUnits: baseUnits,
        nullifier: nullifierValue,
    };
}

export async function runInternalTransferFlow(params: {
    program: Program;
    verifierProgram: Program | null;
    mint: PublicKey;
    recipient: PublicKey;
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
        root,
        nextNullifier: _nextNullifier,
        onStatus,
        onRootChange,
    } = params;
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const { shieldedState, rootBytes } = await fetchShieldedState(program, mint);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);
    const note = findSpendableNote(mint);
    if (!note) {
        throw new Error('No spendable note found for internal transfer.');
    }
    assertCiphertextFields(note);
    const commitments = listCommitments(mint);
    const { root: derivedRoot, pathElements, pathIndices } = await getMerklePath(
        commitments,
        note.leafIndex
    );
    const derivedRootBytes = bigIntToBytes32(derivedRoot);
    if (!bytesEqual(root, derivedRootBytes)) {
        throw new Error('Selected note does not match the provided root.');
    }
    if (!bytesEqual(rootBytes, derivedRootBytes)) {
        throw new Error('On-chain root does not match local note store.');
    }
    const senderSecret = BigInt(note.senderSecret);
    const randomness = BigInt(note.randomness);
    const leafIndex = BigInt(note.leafIndex);
    const amountValue = BigInt(note.amount);
    const noteRecipientTagHash = BigInt(note.recipientTagHash);
    const { pubkey } = await getRecipientKeypair(provider.wallet.publicKey);
    const nullifierValue = await computeNullifier(senderSecret, leafIndex);
    const commitmentValue = BigInt(note.commitment);
    const nullifierSet = await ensureNullifierSet(program, mint, nullifierValue);
    const { note: newNote, plaintext: ciphertextNew } = await createNote({
        mint,
        amount: amountValue,
        recipient,
        leafIndex: commitments.length,
    });
    const nextCommitments = [...commitments, BigInt(newNote.commitment)];
    const { root: nextRoot } = await buildMerkleTree(nextCommitments);
    const newRoot = bigIntToBytes32(nextRoot);

    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
        root: derivedRoot.toString(),
        nullifier: nullifierValue.toString(),
        recipient_tag_hash: noteRecipientTagHash.toString(),
        ciphertext_commitment: commitmentValue.toString(),
        circuit_id: '0',
        amount: amountValue.toString(),
        randomness: randomness.toString(),
        sender_secret: senderSecret.toString(),
        leaf_index: leafIndex.toString(),
        path_elements: pathElements.map((value) => value.toString()),
        path_index: pathIndices,
        recipient_pubkey_x: pubkey[0].toString(),
        recipient_pubkey_y: pubkey[1].toString(),
        enc_randomness: note.encRandomness,
        c1x: note.c1x,
        c1y: note.c1y,
        c2_amount: note.c2Amount,
        c2_randomness: note.c2Randomness,
    });

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

    const newRecipientTagHash = await recipientTagHash(recipient);
    const signature = await program.methods
        .internalTransfer({
            proof: Buffer.from(proofBytes),
            publicInputs: Buffer.from(publicInputsBytes),
            nullifier: Buffer.from(bigIntToBytes32(nullifierValue)),
            root: Buffer.from(root),
            newRoot: Buffer.from(newRoot),
            ciphertextNew: Buffer.from(ciphertextNew),
            recipientTagHash: Buffer.from(bigIntToBytes32(newRecipientTagHash)),
        })
        .accounts({
            config,
            shieldedState,
            nullifierSet,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
        })
        .rpc();

    markNoteSpent(mint, note.id);
    addNote(mint, newNote);
    onRootChange(newRoot);
    onStatus('Internal transfer complete.');
    return { signature, nullifier: nullifierValue, newRoot };
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
    } = params;
    const provider = getProvider(program);
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const vault = deriveVault(program.programId, mint);
    const { shieldedState, rootBytes } = await fetchShieldedState(program, mint);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const destinationAta = await ensureAta(provider, mint, recipient);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const note = findSpendableNote(mint, baseUnits);
    if (!note) {
        throw new Error('No spendable note found for that amount.');
    }
    assertCiphertextFields(note);
    const commitmentValue = BigInt(note.commitment);
    const commitments = listCommitments(mint);
    const { root: derivedRoot, pathElements, pathIndices } = await getMerklePath(
        commitments,
        note.leafIndex
    );
    const derivedRootBytes = bigIntToBytes32(derivedRoot);
    if (!bytesEqual(root, derivedRootBytes)) {
        throw new Error('Selected note does not match the provided root.');
    }
    if (!bytesEqual(rootBytes, derivedRootBytes)) {
        throw new Error('On-chain root does not match local note store.');
    }
    const senderSecret = BigInt(note.senderSecret);
    const randomness = BigInt(note.randomness);
    const leafIndex = BigInt(note.leafIndex);
    const noteRecipientTagHash = BigInt(note.recipientTagHash);
    const { pubkey } = await getRecipientKeypair(provider.wallet.publicKey);
    const nullifierValue = await computeNullifier(senderSecret, leafIndex);
    const nullifierSet = await ensureNullifierSet(program, mint, nullifierValue);

    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
        root: derivedRoot.toString(),
        nullifier: nullifierValue.toString(),
        recipient_tag_hash: noteRecipientTagHash.toString(),
        ciphertext_commitment: commitmentValue.toString(),
        circuit_id: '0',
        amount: baseUnits.toString(),
        randomness: randomness.toString(),
        sender_secret: senderSecret.toString(),
        leaf_index: leafIndex.toString(),
        path_elements: pathElements.map((value) => value.toString()),
        path_index: pathIndices,
        recipient_pubkey_x: pubkey[0].toString(),
        recipient_pubkey_y: pubkey[1].toString(),
        enc_randomness: note.encRandomness,
        c1x: note.c1x,
        c1y: note.c1y,
        c2_amount: note.c2Amount,
        c2_randomness: note.c2Randomness,
    });

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
            nullifier: Buffer.from(bigIntToBytes32(nullifierValue)),
            root: Buffer.from(root),
            relayerFeeBps: 0,
        })
        .accounts({
            config,
            vault,
            vaultAta,
            shieldedState,
            nullifierSet,
            destinationAta,
            relayerFeeAta: destinationAta,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

    const relayerResult = await submitViaRelayer(provider, new Transaction().add(ix));
    markNoteSpent(mint, note.id);
    onDebit(baseUnits);
    onStatus('External transfer complete.');
    return {
        signature: relayerResult.signature,
        amountBaseUnits: baseUnits,
        nullifier: nullifierValue,
    };
}
