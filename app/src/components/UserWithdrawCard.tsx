import React, { FC, useMemo, useState } from 'react';
import { Buffer } from 'buffer';
import { BN, Program } from '@coral-xyz/anchor';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    getAccount,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import styles from './UserWithdrawCard.module.css';
import { deriveConfig, deriveNullifierSet, deriveShielded, deriveVault, deriveVerifierKey } from '../lib/pda';
import { bytesToBigIntBE, modField, sha256 } from '../lib/crypto';
import { computeCommitment, computeNullifier, generateProof, bigIntToBytes32, preflightVerify, formatPublicSignals } from '../lib/prover';
import { VERIFIER_PROGRAM_ID } from '../lib/config';
import { submitViaRelayer } from '../lib/relayer';
import { formatTokenAmount, parseTokenAmount } from '../lib/amount';
import { checkVerifierKeyMatch } from '../lib/verifierKey';

const DEFAULT_AMOUNT = '100000';

type UserWithdrawCardProps = {
    veilpayProgram: Program | null;
    mintAddress: string;
    verifierProgram: Program | null;
    onStatus: (message: string) => void;
    root: Uint8Array;
    nextNullifier: () => number;
    mintDecimals: number | null;
    shieldedBalance: bigint;
    onDebit: (amount: bigint) => void;
};

export const UserWithdrawCard: FC<UserWithdrawCardProps> = ({
    veilpayProgram,
    verifierProgram,
    mintAddress,
    onStatus,
    root,
    nextNullifier,
    mintDecimals,
    shieldedBalance,
    onDebit,
}) => {
    const [amount, setAmount] = useState(DEFAULT_AMOUNT);
    const [recipient, setRecipient] = useState('');
    const [busy, setBusy] = useState(false);

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);

    const parsedRecipient = useMemo(() => {
        if (!recipient) return null;
        try {
            return new PublicKey(recipient);
        } catch {
            return null;
        }
    }, [recipient]);

    const handleWithdraw = async () => {
        if (!veilpayProgram || !parsedMint || !parsedRecipient || mintDecimals === null) return;
        setBusy(true);
        try {
            onStatus('Generating proof...');
            const config = deriveConfig(veilpayProgram.programId);
            const vault = deriveVault(veilpayProgram.programId, parsedMint);
            const shieldedState = deriveShielded(veilpayProgram.programId, parsedMint);
            const nullifierSet = deriveNullifierSet(veilpayProgram.programId, parsedMint, 0);
            const vaultAta = await getAssociatedTokenAddress(parsedMint, vault, true);
            const recipientAta = await getAssociatedTokenAddress(parsedMint, parsedRecipient);
            const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

            const ensureAta = async () => {
                try {
                    await getAccount(veilpayProgram.provider.connection, recipientAta);
                } catch {
                    const ix = createAssociatedTokenAccountInstruction(
                        veilpayProgram.provider.wallet.publicKey,
                        recipientAta,
                        parsedRecipient,
                        parsedMint
                    );
                    await veilpayProgram.provider.sendAndConfirm(new Transaction().add(ix));
                }
            };

            await ensureAta();

            const senderSecret = modField(bytesToBigIntBE(crypto.getRandomValues(new Uint8Array(32))));
            const randomness = modField(bytesToBigIntBE(crypto.getRandomValues(new Uint8Array(32))));
            const leafIndex = BigInt(nextNullifier());
            const baseUnits = parseTokenAmount(amount, mintDecimals);
            const amountValue = baseUnits;
            const recipientTagHashBytes = await sha256(parsedRecipient.toBytes());
            const recipientTagHash = modField(bytesToBigIntBE(recipientTagHashBytes));
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

            const ix = await veilpayProgram.methods
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
                    mint: parsedMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .instruction();

            await submitViaRelayer(veilpayProgram.provider, new Transaction().add(ix));
            onDebit(baseUnits);
            onStatus('Withdraw complete.');
        } catch (error) {
            onStatus(`Withdraw failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={styles.card}>
            <header>
                <h2>Withdraw</h2>
                <p>Move funds out to your wallet.</p>
            </header>
            <div className={styles.labelRow}>
                <label className={styles.label}>
                    Amount (tokens)
                    <input value={amount} onChange={(event) => setAmount(event.target.value)} />
                </label>
                {mintDecimals !== null && (
                    <button
                        type="button"
                        className={styles.balanceButton}
                        onClick={() => setAmount(formatTokenAmount(shieldedBalance, mintDecimals))}
                    >
                        VeilPay balance: {formatTokenAmount(shieldedBalance, mintDecimals)}
                    </button>
                )}
            </div>
            <label className={styles.label}>
                Recipient wallet
                <input value={recipient} onChange={(event) => setRecipient(event.target.value)} />
            </label>
            <button
                className={styles.button}
                disabled={!parsedRecipient || !parsedMint || mintDecimals === null || busy}
                onClick={handleWithdraw}
            >
                Withdraw
            </button>
        </section>
    );
};
