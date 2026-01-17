import { useMemo, useState } from 'react';
import type { FC } from 'react';
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
import styles from './UserTransferCard.module.css';
import { deriveConfig, deriveNullifierSet, deriveShielded, deriveVault, deriveVerifierKey } from '../lib/pda';
import { bytesToBigIntBE, modField, randomBytes, sha256 } from '../lib/crypto';
import { computeCommitment, computeNullifier, generateProof, bigIntToBytes32, preflightVerify, formatPublicSignals } from '../lib/prover';
import { VERIFIER_PROGRAM_ID } from '../lib/config';
import { submitViaRelayer } from '../lib/relayer';
import { formatTokenAmount, parseTokenAmount } from '../lib/amount';
import { checkVerifierKeyMatch } from '../lib/verifierKey';

export type UserTransferCardProps = {
    veilpayProgram: Program | null;
    mintAddress: string;
    verifierProgram: Program | null;
    onStatus: (message: string) => void;
    root: Uint8Array;
    nextNullifier: () => number;
    onRootChange: (next: Uint8Array) => void;
    mintDecimals: number | null;
    shieldedBalance: bigint;
    onDebit: (amount: bigint) => void;
};

export const UserTransferCard: FC<UserTransferCardProps> = ({
    veilpayProgram,
    verifierProgram,
    mintAddress,
    onStatus,
    root,
    nextNullifier,
    onRootChange,
    mintDecimals,
    shieldedBalance,
    onDebit,
}) => {
    const [internalRecipient, setInternalRecipient] = useState('');
    const [externalRecipient, setExternalRecipient] = useState('');
    const [externalAmount, setExternalAmount] = useState('250000');
    const [busy, setBusy] = useState(false);

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);

    const parsedInternalRecipient = useMemo(() => {
        if (!internalRecipient) return null;
        try {
            return new PublicKey(internalRecipient);
        } catch {
            return null;
        }
    }, [internalRecipient]);

    const parsedExternalRecipient = useMemo(() => {
        if (!externalRecipient) return null;
        try {
            return new PublicKey(externalRecipient);
        } catch {
            return null;
        }
    }, [externalRecipient]);

    const handleInternal = async () => {
        if (!veilpayProgram || !parsedMint || !parsedInternalRecipient || mintDecimals === null) return;
        setBusy(true);
        try {
            onStatus('Generating proof...');
            const config = deriveConfig(veilpayProgram.programId);
            const shieldedState = deriveShielded(veilpayProgram.programId, parsedMint);
            const nullifierSet = deriveNullifierSet(veilpayProgram.programId, parsedMint, 0);
            const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);
            const newRootValue = modField(bytesToBigIntBE(randomBytes(32)));
            const newRoot = bigIntToBytes32(newRootValue);
            const ciphertextNew = randomBytes(64);

            const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
            const randomness = modField(bytesToBigIntBE(randomBytes(32)));
            const leafIndex = BigInt(nextNullifier());
            const amountValue = 0n;
            const recipientTagHash = modField(bytesToBigIntBE(await sha256(parsedInternalRecipient.toBytes())));
            const nullifierValue = await computeNullifier(senderSecret, leafIndex);
            const commitmentValue = await computeCommitment(amountValue, randomness, recipientTagHash);

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

            await veilpayProgram.methods
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
                    mint: parsedMint,
                })
                .rpc();

            onRootChange(newRoot);
            onStatus('Internal transfer complete.');
        } catch (error) {
            onStatus(`Internal transfer failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    const handleExternal = async () => {
        if (!veilpayProgram || !parsedMint || !parsedExternalRecipient || mintDecimals === null) return;
        setBusy(true);
        try {
            onStatus('Generating proof...');
            const config = deriveConfig(veilpayProgram.programId);
            const vault = deriveVault(veilpayProgram.programId, parsedMint);
            const shieldedState = deriveShielded(veilpayProgram.programId, parsedMint);
            const nullifierSet = deriveNullifierSet(veilpayProgram.programId, parsedMint, 0);
            const vaultAta = await getAssociatedTokenAddress(parsedMint, vault, true);
            const destinationAta = await getAssociatedTokenAddress(parsedMint, parsedExternalRecipient);
            const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

            const provider = veilpayProgram.provider as AnchorProvider;
            const wallet = provider.wallet;
            if (!wallet) {
                throw new Error('Connect a wallet to transfer.');
            }
            try {
                await getAccount(provider.connection, destinationAta);
            } catch {
                const ix = createAssociatedTokenAccountInstruction(
                    wallet.publicKey,
                    destinationAta,
                    parsedExternalRecipient,
                    parsedMint
                );
                await provider.sendAndConfirm(new Transaction().add(ix));
            }

            const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
            const randomness = modField(bytesToBigIntBE(randomBytes(32)));
            const leafIndex = BigInt(nextNullifier());
            const baseUnits = parseTokenAmount(externalAmount, mintDecimals);
            const amountValue = baseUnits;
            const recipientTagHash = modField(bytesToBigIntBE(await sha256(parsedExternalRecipient.toBytes())));
            const nullifierValue = await computeNullifier(senderSecret, leafIndex);
            const commitmentValue = await computeCommitment(amountValue, randomness, recipientTagHash);

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
            onStatus('Preflight verified. Preparing relayer transaction...');

            if (verifierProgram) {
                onStatus('Checking verifier key consistency...');
                const vkCheck = await checkVerifierKeyMatch(verifierProgram);
                if (!vkCheck.ok) {
                    throw new Error(`Verifier key mismatch on-chain: ${vkCheck.mismatch}`);
                }
            }
            onStatus('Verifier key matches. Submitting to relayer...');

            const accounts = {
                config,
                vault,
                vaultAta,
                shieldedState,
                nullifierSet,
                destinationAta,
                verifierProgram: VERIFIER_PROGRAM_ID,
                verifierKey,
                mint: parsedMint,
                tokenProgram: TOKEN_PROGRAM_ID,
            };

            const ix = await veilpayProgram.methods
                .externalTransfer({
                    amount: new BN(baseUnits.toString()),
                    proof: Buffer.from(proofBytes),
                    publicInputs: Buffer.from(publicInputsBytes),
                    nullifier: Buffer.from(bigIntToBytes32(nullifierValue)),
                    root: Buffer.from(root),
                    relayerFeeBps: 0,
                })
                .accounts(accounts)
                .instruction();

            await submitViaRelayer(provider, new Transaction().add(ix));
            onDebit(baseUnits);
            onStatus('External transfer complete.');
        } catch (error) {
            onStatus(`External transfer failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={styles.card}>
            <header>
                <h2>Transfers</h2>
                <p>Send privately inside VeilPay or externally.</p>
            </header>
            <div className={styles.column}>
                <h3>Internal</h3>
                <label className={styles.label}>
                    Recipient wallet
                    <input value={internalRecipient} onChange={(event) => setInternalRecipient(event.target.value)} />
                </label>
                <button className={styles.button} disabled={!parsedInternalRecipient || !parsedMint || busy} onClick={handleInternal}>
                    Send internally
                </button>
            </div>
            <div className={styles.divider} />
            <div className={styles.column}>
                <h3>External</h3>
                <label className={styles.label}>
                    Amount (tokens)
                    <input value={externalAmount} onChange={(event) => setExternalAmount(event.target.value)} />
                </label>
                {mintDecimals !== null && (
                    <button
                        type="button"
                        className={styles.balanceButton}
                        onClick={() => setExternalAmount(formatTokenAmount(shieldedBalance, mintDecimals))}
                    >
                        VeilPay balance: {formatTokenAmount(shieldedBalance, mintDecimals)}
                    </button>
                )}
                <label className={styles.label}>
                    Destination wallet
                    <input value={externalRecipient} onChange={(event) => setExternalRecipient(event.target.value)} />
                </label>
                <button
                    className={styles.button}
                    disabled={!parsedExternalRecipient || !parsedMint || mintDecimals === null || busy}
                    onClick={handleExternal}
                >
                    Send externally
                </button>
            </div>
        </section>
    );
};
