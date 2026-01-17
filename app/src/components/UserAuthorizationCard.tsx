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
import styles from './UserAuthorizationCard.module.css';
import { deriveAuthorization, deriveConfig, deriveNullifierSet, deriveShielded, deriveVault, deriveVerifierKey } from '../lib/pda';
import { bytesToBigIntBE, concatBytes, modField, randomBytes, sha256 } from '../lib/crypto';
import { computeCommitment, computeNullifier, generateProof, bigIntToBytes32, preflightVerify, formatPublicSignals } from '../lib/prover';
import { RELAYER_URL, VERIFIER_PROGRAM_ID } from '../lib/config';
import { submitViaRelayer } from '../lib/relayer';
import { useWallet } from '@solana/wallet-adapter-react';
import { formatTokenAmount, parseTokenAmount } from '../lib/amount';
import { checkVerifierKeyMatch } from '../lib/verifierKey';

const DEFAULT_AMOUNT = '50000';

export type UserAuthorizationCardProps = {
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

export const UserAuthorizationCard: FC<UserAuthorizationCardProps> = ({
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
    const { publicKey, signMessage } = useWallet();
    const [amount, setAmount] = useState(DEFAULT_AMOUNT);
    const [payeeWallet, setPayeeWallet] = useState('');
    const [expirySlots, setExpirySlots] = useState('200');
    const [intentHash, setIntentHash] = useState<Uint8Array | null>(null);
    const [busy, setBusy] = useState(false);

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);

    const parsedPayee = useMemo(() => {
        if (!payeeWallet) return null;
        try {
            return new PublicKey(payeeWallet);
        } catch {
            return null;
        }
    }, [payeeWallet]);

    const handleCreate = async () => {
        if (!veilpayProgram || !parsedMint || !publicKey || !signMessage || !parsedPayee || mintDecimals === null) return;
        setBusy(true);
        try {
            const amountCiphertext = randomBytes(64);
            const expirySlot = BigInt(Date.now()) + BigInt(expirySlots);
            const payeeTagHash = await sha256(parsedPayee.toBytes());
            const intentHashBytes = await sha256(
                concatBytes([
                    parsedMint.toBytes(),
                    payeeTagHash,
                    amountCiphertext,
                    new Uint8Array(new BN(expirySlot.toString()).toArray('be', 8)),
                ])
            );
            setIntentHash(intentHashBytes);

            const domain = `VeilPay:v1:${veilpayProgram.programId.toBase58()}:localnet`;
            const signature = await signMessage(concatBytes([new TextEncoder().encode(domain), intentHashBytes]));

            await fetch(`${RELAYER_URL}/intent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    intentHash: Buffer.from(intentHashBytes).toString('base64'),
                    mint: parsedMint.toBase58(),
                    payeeTagHash: Buffer.from(payeeTagHash).toString('base64'),
                    amountCiphertext: Buffer.from(amountCiphertext).toString('base64'),
                    expirySlot: expirySlot.toString(),
                    circuitId: 0,
                    proofHash: Buffer.from(randomBytes(32)).toString('base64'),
                    payer: publicKey.toBase58(),
                    signature: Buffer.from(signature).toString('base64'),
                    domain,
                }),
            });

            const config = deriveConfig(veilpayProgram.programId);
            const authorization = deriveAuthorization(veilpayProgram.programId, intentHashBytes);

            await veilpayProgram.methods
                .createAuthorization({
                    intentHash: Buffer.from(intentHashBytes),
                    payeeTagHash: Buffer.from(payeeTagHash),
                    mint: parsedMint,
                    amountCiphertext: Buffer.from(amountCiphertext),
                    expirySlot: new BN(expirySlot.toString()),
                    circuitId: 0,
                    proofHash: Buffer.from(randomBytes(32)),
                    relayerPubkey: PublicKey.default,
                })
                .accounts({
                    config,
                    authorization,
                    payer: publicKey,
                })
                .rpc();

            onStatus('Authorization created.');
        } catch (error) {
            onStatus(`Authorization failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    const handleSettle = async () => {
        if (!veilpayProgram || !parsedMint || !publicKey || !parsedPayee || !intentHash || mintDecimals === null) return;
        setBusy(true);
        try {
            onStatus('Generating proof...');
            const config = deriveConfig(veilpayProgram.programId);
            const authorization = deriveAuthorization(veilpayProgram.programId, intentHash);
            const vault = deriveVault(veilpayProgram.programId, parsedMint);
            const shieldedState = deriveShielded(veilpayProgram.programId, parsedMint);
            const nullifierSet = deriveNullifierSet(veilpayProgram.programId, parsedMint, 0);
            const vaultAta = await getAssociatedTokenAddress(parsedMint, vault, true);
            const recipientAta = await getAssociatedTokenAddress(parsedMint, parsedPayee);
            const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

            try {
                await getAccount(veilpayProgram.provider.connection, recipientAta);
            } catch {
                const ix = createAssociatedTokenAccountInstruction(
                    veilpayProgram.provider.wallet.publicKey,
                    recipientAta,
                    parsedPayee,
                    parsedMint
                );
                await veilpayProgram.provider.sendAndConfirm(new Transaction().add(ix));
            }

            const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
            const randomness = modField(bytesToBigIntBE(randomBytes(32)));
            const leafIndex = BigInt(nextNullifier());
            const baseUnits = parseTokenAmount(amount, mintDecimals);
            const amountValue = baseUnits;
            const recipientTagHash = modField(bytesToBigIntBE(await sha256(parsedPayee.toBytes())));
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
                    mint: parsedMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .instruction();

            await submitViaRelayer(veilpayProgram.provider, new Transaction().add(ix));
            onDebit(baseUnits);
            onStatus('Authorization settled.');
        } catch (error) {
            onStatus(`Settle failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={styles.card}>
            <header>
                <h2>Authorization</h2>
                <p>Create a claimable invoice or settle one.</p>
            </header>
            <div className={styles.column}>
                <label className={styles.label}>
                    Payee wallet
                    <input value={payeeWallet} onChange={(event) => setPayeeWallet(event.target.value)} />
                </label>
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
                    Expiry slots
                    <input value={expirySlots} onChange={(event) => setExpirySlots(event.target.value)} />
                </label>
                <button
                    className={styles.button}
                    disabled={!parsedPayee || !parsedMint || mintDecimals === null || busy}
                    onClick={handleCreate}
                >
                    Create authorization
                </button>
            </div>
            <div className={styles.divider} />
            <div className={styles.column}>
                <p className={styles.helper}>Settle the latest authorization you created.</p>
                <button
                    className={styles.button}
                    disabled={!intentHash || !parsedPayee || !parsedMint || mintDecimals === null || busy}
                    onClick={handleSettle}
                >
                    Settle authorization
                </button>
            </div>
        </section>
    );
};
