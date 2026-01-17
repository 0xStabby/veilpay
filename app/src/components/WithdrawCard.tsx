import React, { FC, useMemo, useState } from 'react';
import { Buffer } from 'buffer';
import { PublicKey, Transaction } from '@solana/web3.js';
import { BN, Program } from '@coral-xyz/anchor';
import {
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    getAccount,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import styles from './WithdrawCard.module.css';
import { deriveConfig, deriveNullifierSet, deriveShielded, deriveVault, deriveVerifierKey } from '../lib/pda';
import { computeCommitment, computeNullifier, generateProof, bigIntToBytes32, preflightVerify, formatPublicSignals } from '../lib/prover';
import { bytesToBigIntBE, modField, sha256, toHex } from '../lib/crypto';
import { VERIFIER_PROGRAM_ID } from '../lib/config';
import { submitViaRelayer } from '../lib/relayer';

const DEFAULT_AMOUNT = '100000';

type WithdrawCardProps = {
    veilpayProgram: Program | null;
    mintAddress: string;
    onStatus: (message: string) => void;
    root: Uint8Array;
};

export const WithdrawCard: FC<WithdrawCardProps> = ({ veilpayProgram, mintAddress, onStatus, root }) => {
    const [amount, setAmount] = useState(DEFAULT_AMOUNT);
    const [recipient, setRecipient] = useState('');
    const [relayerFeeBps, setRelayerFeeBps] = useState('0');
    const [relayerPubkey, setRelayerPubkey] = useState('');
    const [nullifierIndex, setNullifierIndex] = useState(1);
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

    const parsedRelayer = useMemo(() => {
        if (!relayerPubkey) return null;
        try {
            return new PublicKey(relayerPubkey);
        } catch {
            return null;
        }
    }, [relayerPubkey]);

    const handleWithdraw = async () => {
        if (!veilpayProgram || !parsedMint || !parsedRecipient) return;
        setBusy(true);
        try {
            if (Number(relayerFeeBps) > 0 && !parsedRelayer) {
                throw new Error('Relayer pubkey required when relayer fee > 0.');
            }
            onStatus('Submitting withdraw...');
            const config = deriveConfig(veilpayProgram.programId);
            const vault = deriveVault(veilpayProgram.programId, parsedMint);
            const shieldedState = deriveShielded(veilpayProgram.programId, parsedMint);
            const nullifierSet = deriveNullifierSet(veilpayProgram.programId, parsedMint, 0);
            const vaultAta = await getAssociatedTokenAddress(parsedMint, vault, true);
            const recipientAta = await getAssociatedTokenAddress(parsedMint, parsedRecipient);
            const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

            const relayerFeeAta = parsedRelayer
                ? await getAssociatedTokenAddress(parsedMint, parsedRelayer)
                : null;

            const ensureAta = async (ata: PublicKey, owner: PublicKey) => {
                try {
                    await getAccount(veilpayProgram.provider.connection, ata);
                } catch {
                    const ix = createAssociatedTokenAccountInstruction(
                        veilpayProgram.provider.wallet.publicKey,
                        ata,
                        owner,
                        parsedMint
                    );
                    await veilpayProgram.provider.sendAndConfirm(new Transaction().add(ix));
                }
            };

            await ensureAta(recipientAta, parsedRecipient);
            if (relayerFeeAta && parsedRelayer) {
                await ensureAta(relayerFeeAta, parsedRelayer);
            }

            const senderSecret = modField(bytesToBigIntBE(crypto.getRandomValues(new Uint8Array(32))));
            const randomness = modField(bytesToBigIntBE(crypto.getRandomValues(new Uint8Array(32))));
            const leafIndex = BigInt(nullifierIndex);
            const amountValue = BigInt(amount);
            const recipientTagHashBytes = await sha256(parsedRecipient.toBytes());
            const recipientTagHash = modField(bytesToBigIntBE(recipientTagHashBytes));
            const nullifierValue = await computeNullifier(senderSecret, leafIndex);
            const commitmentValue = await computeCommitment(amountValue, randomness, recipientTagHash);

            onStatus('Generating Groth16 proof...');
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

            onStatus('Preflight verifying proof...');
            const verified = await preflightVerify(proof, publicSignals);
            if (!verified) {
                throw new Error(`Preflight verify failed. ${formatPublicSignals(publicSignals)}`);
            }

            const ix = await veilpayProgram.methods
                .withdraw({
                    amount: new BN(amount),
                    proof: Buffer.from(proofBytes),
                    publicInputs: Buffer.from(publicInputsBytes),
                    nullifier: Buffer.from(bigIntToBytes32(nullifierValue)),
                    root: Buffer.from(root),
                    relayerFeeBps: Number(relayerFeeBps),
                })
                .accounts({
                    config,
                    vault,
                    vaultAta,
                    shieldedState,
                    nullifierSet,
                    recipientAta,
                    relayerFeeAta: relayerFeeAta ?? null,
                    verifierProgram: VERIFIER_PROGRAM_ID,
                    verifierKey,
                    mint: parsedMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .instruction();

            await submitViaRelayer(veilpayProgram.provider, new Transaction().add(ix));

            onStatus(`Withdraw complete. Nullifier ${toHex(bigIntToBytes32(nullifierValue)).slice(0, 12)}...`);
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
                <p>Spend a note to a destination ATA using Groth16 proof verification.</p>
            </header>
            <label className={styles.label}>
                Amount (base units)
                <input value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>
            <label className={styles.label}>
                Recipient wallet
                <input value={recipient} onChange={(event) => setRecipient(event.target.value)} />
            </label>
            <div className={styles.row}>
                <label className={styles.label}>
                    Relayer fee (bps)
                    <input value={relayerFeeBps} onChange={(event) => setRelayerFeeBps(event.target.value)} />
                </label>
                <label className={styles.label}>
                    Relayer pubkey
                    <input value={relayerPubkey} onChange={(event) => setRelayerPubkey(event.target.value)} />
                </label>
            </div>
            <label className={styles.label}>
                Nullifier index
                <input
                    type="number"
                    value={nullifierIndex}
                    onChange={(event) => setNullifierIndex(Number(event.target.value))}
                />
            </label>
            <p className={styles.helper}>Root: {toHex(root).slice(0, 16)}...</p>
            <button className={styles.button} onClick={handleWithdraw} disabled={!parsedRecipient || !parsedMint || busy}>
                Withdraw
            </button>
        </section>
    );
};
