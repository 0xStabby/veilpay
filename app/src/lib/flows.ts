import { Buffer } from 'buffer';
import { BN, Program } from '@coral-xyz/anchor';
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
import { bytesToBigIntBE, concatBytes, modField, randomBytes, sha256 } from './crypto';
import {
    computeCommitment,
    computeNullifier,
    formatPublicSignals,
    generateProof,
    preflightVerify,
    bigIntToBytes32,
} from './prover';
import { ensureNullifierSet } from './nullifier';
import { RELAYER_URL, VERIFIER_PROGRAM_ID } from './config';
import { submitViaRelayer } from './relayer';
import { checkVerifierKeyMatch } from './verifierKey';
import { parseTokenAmount } from './amount';

type StatusHandler = (message: string) => void;

async function ensureAta(
    program: Program,
    mint: PublicKey,
    owner: PublicKey
): Promise<PublicKey> {
    const ata = await getAssociatedTokenAddress(mint, owner);
    try {
        await getAccount(program.provider.connection, ata);
    } catch {
        const ix = createAssociatedTokenAccountInstruction(program.provider.wallet.publicKey, ata, owner, mint);
        await program.provider.sendAndConfirm(new Transaction().add(ix));
    }
    return ata;
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
    onStatus('Depositing into VeilPay vault...');
    const config = deriveConfig(program.programId);
    const vault = deriveVault(program.programId, mint);
    const shieldedState = deriveShielded(program.programId, mint);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const userAta = await getAssociatedTokenAddress(mint, program.provider.wallet.publicKey);

    const ciphertext = randomBytes(64);
    const newRootValue = modField(bytesToBigIntBE(randomBytes(32)));
    const newRoot = bigIntToBytes32(newRootValue);
    const randomness = modField(bytesToBigIntBE(randomBytes(32)));
    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const recipientTagBytes = await sha256(program.provider.wallet.publicKey.toBytes());
    const recipientTagHash = modField(bytesToBigIntBE(recipientTagBytes));
    const commitmentValue = await computeCommitment(baseUnits, randomness, recipientTagHash);
    const commitment = bigIntToBytes32(commitmentValue);

    const signature = await program.methods
        .deposit({
            amount: new BN(baseUnits.toString()),
            ciphertext: Buffer.from(ciphertext),
            commitment: Buffer.from(commitment),
            newRoot: Buffer.from(newRoot),
        })
        .accounts({
            config,
            vault,
            vaultAta,
            shieldedState,
            user: program.provider.wallet.publicKey,
            userAta,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

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
    const { program, verifierProgram, mint, recipient, amount, mintDecimals, root, nextNullifier, onStatus, onDebit } = params;
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const vault = deriveVault(program.programId, mint);
    const shieldedState = deriveShielded(program.programId, mint);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const recipientAta = await ensureAta(program, mint, recipient);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

    const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
    const randomness = modField(bytesToBigIntBE(randomBytes(32)));
    const leafIndex = BigInt(nextNullifier());
    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const recipientTagHashBytes = await sha256(recipient.toBytes());
    const recipientTagHash = modField(bytesToBigIntBE(recipientTagHashBytes));
    const nullifierValue = await computeNullifier(senderSecret, leafIndex);
    const commitmentValue = await computeCommitment(baseUnits, randomness, recipientTagHash);
    const nullifierSet = await ensureNullifierSet(program, mint, nullifierValue);

    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
        root: bytesToBigIntBE(root).toString(),
        nullifier: nullifierValue.toString(),
        recipient_tag_hash: recipientTagHash.toString(),
        ciphertext_commitment: commitmentValue.toString(),
        circuit_id: '0',
        amount: baseUnits.toString(),
        randomness: randomness.toString(),
        sender_secret: senderSecret.toString(),
        leaf_index: leafIndex.toString(),
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
            relayerFeeAta: null,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

    const relayerResult = await submitViaRelayer(program.provider, new Transaction().add(ix));
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
    const { program, mint, payer, signMessage, payee, amount, expirySlots, onStatus } = params;
    const amountCiphertext = randomBytes(64);
    const expirySlot = BigInt(Date.now()) + BigInt(expirySlots);
    const payeeTagHash = await sha256(payee.toBytes());
    const intentHashBytes = await sha256(
        concatBytes([
            mint.toBytes(),
            payeeTagHash,
            amountCiphertext,
            new Uint8Array(new BN(expirySlot.toString()).toArray('be', 8)),
        ])
    );

    const domain = `VeilPay:v1:${program.programId.toBase58()}:localnet`;
    const intentSignature = await signMessage(concatBytes([new TextEncoder().encode(domain), intentHashBytes]));

    await fetch(`${RELAYER_URL}/intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            intentHash: Buffer.from(intentHashBytes).toString('base64'),
            mint: mint.toBase58(),
            payeeTagHash: Buffer.from(payeeTagHash).toString('base64'),
            amountCiphertext: Buffer.from(amountCiphertext).toString('base64'),
            expirySlot: expirySlot.toString(),
            circuitId: 0,
            proofHash: Buffer.from(randomBytes(32)).toString('base64'),
            payer: payer.toBase58(),
            signature: Buffer.from(intentSignature).toString('base64'),
            domain,
        }),
    });

    const config = deriveConfig(program.programId);
    const authorization = deriveAuthorization(program.programId, intentHashBytes);

    const signature = await program.methods
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
        nextNullifier,
        intentHash,
        onStatus,
        onDebit,
    } = params;
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const authorization = deriveAuthorization(program.programId, intentHash);
    const vault = deriveVault(program.programId, mint);
    const shieldedState = deriveShielded(program.programId, mint);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const recipientAta = await ensureAta(program, mint, payee);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

    const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
    const randomness = modField(bytesToBigIntBE(randomBytes(32)));
    const leafIndex = BigInt(nextNullifier());
    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const recipientTagHash = modField(bytesToBigIntBE(await sha256(payee.toBytes())));
    const nullifierValue = await computeNullifier(senderSecret, leafIndex);
    const commitmentValue = await computeCommitment(baseUnits, randomness, recipientTagHash);
    const nullifierSet = await ensureNullifierSet(program, mint, nullifierValue);

    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
        root: bytesToBigIntBE(root).toString(),
        nullifier: nullifierValue.toString(),
        recipient_tag_hash: recipientTagHash.toString(),
        ciphertext_commitment: commitmentValue.toString(),
        circuit_id: '0',
        amount: baseUnits.toString(),
        randomness: randomness.toString(),
        sender_secret: senderSecret.toString(),
        leaf_index: leafIndex.toString(),
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
            relayerFeeAta: null,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

    const relayerResult = await submitViaRelayer(program.provider, new Transaction().add(ix));
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
    const { program, verifierProgram, mint, recipient, root, nextNullifier, onStatus, onRootChange } = params;
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const shieldedState = deriveShielded(program.programId, mint);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);
    const newRootValue = modField(bytesToBigIntBE(randomBytes(32)));
    const newRoot = bigIntToBytes32(newRootValue);
    const ciphertextNew = randomBytes(64);

    const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
    const randomness = modField(bytesToBigIntBE(randomBytes(32)));
    const leafIndex = BigInt(nextNullifier());
    const amountValue = 0n;
    const recipientTagHash = modField(bytesToBigIntBE(await sha256(recipient.toBytes())));
    const nullifierValue = await computeNullifier(senderSecret, leafIndex);
    const commitmentValue = await computeCommitment(amountValue, randomness, recipientTagHash);
    const nullifierSet = await ensureNullifierSet(program, mint, nullifierValue);

    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
        root: bytesToBigIntBE(root).toString(),
        nullifier: nullifierValue.toString(),
        recipient_tag_hash: recipientTagHash.toString(),
        ciphertext_commitment: commitmentValue.toString(),
        circuit_id: '0',
        amount: amountValue.toString(),
        randomness: randomness.toString(),
        sender_secret: senderSecret.toString(),
        leaf_index: leafIndex.toString(),
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

    const signature = await program.methods
        .internalTransfer({
            proof: Buffer.from(proofBytes),
            publicInputs: Buffer.from(publicInputsBytes),
            nullifier: Buffer.from(bigIntToBytes32(nullifierValue)),
            root: Buffer.from(root),
            newRoot: Buffer.from(newRoot),
            ciphertextNew: Buffer.from(ciphertextNew),
            recipientTagHash: Buffer.from(bigIntToBytes32(recipientTagHash)),
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
        nextNullifier,
        onStatus,
        onDebit,
    } = params;
    onStatus('Generating proof...');
    const config = deriveConfig(program.programId);
    const vault = deriveVault(program.programId, mint);
    const shieldedState = deriveShielded(program.programId, mint);
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const destinationAta = await ensureAta(program, mint, recipient);
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

    const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
    const randomness = modField(bytesToBigIntBE(randomBytes(32)));
    const leafIndex = BigInt(nextNullifier());
    const baseUnits = parseTokenAmount(amount, mintDecimals);
    const recipientTagHash = modField(bytesToBigIntBE(await sha256(recipient.toBytes())));
    const nullifierValue = await computeNullifier(senderSecret, leafIndex);
    const commitmentValue = await computeCommitment(baseUnits, randomness, recipientTagHash);
    const nullifierSet = await ensureNullifierSet(program, mint, nullifierValue);

    const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
        root: bytesToBigIntBE(root).toString(),
        nullifier: nullifierValue.toString(),
        recipient_tag_hash: recipientTagHash.toString(),
        ciphertext_commitment: commitmentValue.toString(),
        circuit_id: '0',
        amount: baseUnits.toString(),
        randomness: randomness.toString(),
        sender_secret: senderSecret.toString(),
        leaf_index: leafIndex.toString(),
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
            relayerFeeAta: null,
            verifierProgram: VERIFIER_PROGRAM_ID,
            verifierKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

    const relayerResult = await submitViaRelayer(program.provider, new Transaction().add(ix));
    onDebit(baseUnits);
    onStatus('External transfer complete.');
    return {
        signature: relayerResult.signature,
        amountBaseUnits: baseUnits,
        nullifier: nullifierValue,
    };
}
