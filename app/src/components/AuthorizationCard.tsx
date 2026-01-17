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
import styles from './AuthorizationCard.module.css';
import { deriveAuthorization, deriveConfig, deriveNullifierSet, deriveShielded, deriveVault, deriveVerifierKey } from '../lib/pda';
import { computeCommitment, computeNullifier, generateProof, bigIntToBytes32, preflightVerify, formatPublicSignals } from '../lib/prover';
import { bytesToBigIntBE, concatBytes, modField, randomBytes, sha256, toHex } from '../lib/crypto';
import { RELAYER_URL, VERIFIER_PROGRAM_ID } from '../lib/config';
import { useWallet } from '@solana/wallet-adapter-react';
import { submitViaRelayer } from '../lib/relayer';

type AuthorizationCardProps = {
    veilpayProgram: Program | null;
    mintAddress: string;
    onStatus: (message: string) => void;
    root: Uint8Array;
};

export const AuthorizationCard: FC<AuthorizationCardProps> = ({ veilpayProgram, mintAddress, onStatus, root }) => {
    const { publicKey, signMessage } = useWallet();
    const [payeeTagHash, setPayeeTagHash] = useState('');
    const [authAmount, setAuthAmount] = useState('50000');
    const [expirySlots, setExpirySlots] = useState('200');
    const [circuitId, setCircuitId] = useState(0);
    const [intentHash, setIntentHash] = useState<Uint8Array | null>(null);
    const [recipient, setRecipient] = useState('');
    const [nullifierIndex, setNullifierIndex] = useState(2);
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

    const payeeTagBytes = useMemo(() => {
        if (!payeeTagHash) return randomBytes(32);
        const clean = payeeTagHash.replace(/^0x/, '');
        if (clean.length !== 64) return randomBytes(32);
        const out = new Uint8Array(32);
        for (let i = 0; i < 32; i += 1) {
            out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
    }, [payeeTagHash]);

    const handleCreateAuthorization = async () => {
        if (!veilpayProgram || !parsedMint || !publicKey || !signMessage) return;
        setBusy(true);
        try {
            const amountCiphertext = randomBytes(64);
            const expirySlot = BigInt(Date.now()) + BigInt(expirySlots);
            const intentHashBytes = await sha256(
                concatBytes([
                    parsedMint.toBytes(),
                    payeeTagBytes,
                    amountCiphertext,
                    new Uint8Array(new BN(expirySlot.toString()).toArray('be', 8)),
                ])
            );
            setIntentHash(intentHashBytes);

            const domain = `VeilPay:v1:${veilpayProgram.programId.toBase58()}:localnet`;
            const signature = await signMessage(concatBytes([new TextEncoder().encode(domain), intentHashBytes]));

            const intentPayload = {
                intentHash: Buffer.from(intentHashBytes).toString('base64'),
                mint: parsedMint.toBase58(),
                payeeTagHash: Buffer.from(payeeTagBytes).toString('base64'),
                amountCiphertext: Buffer.from(amountCiphertext).toString('base64'),
                expirySlot: expirySlot.toString(),
                circuitId,
                proofHash: Buffer.from(randomBytes(32)).toString('base64'),
                payer: publicKey.toBase58(),
                signature: Buffer.from(signature).toString('base64'),
                domain,
            };

            await fetch(`${RELAYER_URL}/intent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(intentPayload),
            });

            const config = deriveConfig(veilpayProgram.programId);
            const authorization = deriveAuthorization(veilpayProgram.programId, intentHashBytes);

            await veilpayProgram.methods
                .createAuthorization({
                    intentHash: Buffer.from(intentHashBytes),
                    payeeTagHash: Buffer.from(payeeTagBytes),
                    mint: parsedMint,
                    amountCiphertext: Buffer.from(amountCiphertext),
                    expirySlot: new BN(expirySlot.toString()),
                    circuitId,
                    proofHash: Buffer.from(randomBytes(32)),
                    relayerPubkey: PublicKey.default,
                })
                .accounts({
                    config,
                    authorization,
                    payer: publicKey,
                })
                .rpc();

            onStatus(`Authorization created. Intent ${toHex(intentHashBytes).slice(0, 12)}...`);
        } catch (error) {
            onStatus(`Authorization failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    const handleSettleAuthorization = async () => {
        if (!veilpayProgram || !parsedMint || !publicKey || !parsedRecipient || !intentHash) return;
        setBusy(true);
        try {
            onStatus('Settling authorization...');
            const config = deriveConfig(veilpayProgram.programId);
            const authorization = deriveAuthorization(veilpayProgram.programId, intentHash);
            const vault = deriveVault(veilpayProgram.programId, parsedMint);
            const shieldedState = deriveShielded(veilpayProgram.programId, parsedMint);
            const nullifierSet = deriveNullifierSet(veilpayProgram.programId, parsedMint, 0);
            const vaultAta = await getAssociatedTokenAddress(parsedMint, vault, true);
            const recipientAta = await getAssociatedTokenAddress(parsedMint, parsedRecipient);
            const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);

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

            const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
            const randomness = modField(bytesToBigIntBE(randomBytes(32)));
            const leafIndex = BigInt(nullifierIndex);
            const amountValue = BigInt(authAmount);
            const recipientTagHashBytes = payeeTagHash
                ? payeeTagBytes
                : await sha256(parsedRecipient.toBytes());
            const recipientTagHash = modField(bytesToBigIntBE(recipientTagHashBytes));
            const nullifierValue = await computeNullifier(senderSecret, leafIndex);
            const commitmentValue = await computeCommitment(amountValue, randomness, recipientTagHash);

            onStatus('Generating Groth16 proof...');
            const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
                root: bytesToBigIntBE(root).toString(),
                nullifier: nullifierValue.toString(),
                recipient_tag_hash: recipientTagHash.toString(),
                ciphertext_commitment: commitmentValue.toString(),
                circuit_id: circuitId.toString(),
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
                .settleAuthorization({
                    amount: new BN(authAmount),
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
                <p>Create a claimable authorization and settle it with a proof.</p>
            </header>
            <div className={styles.column}>
                <label className={styles.label}>
                    Payee tag hash (hex 32 bytes)
                    <input value={payeeTagHash} onChange={(event) => setPayeeTagHash(event.target.value)} />
                </label>
                <label className={styles.label}>
                    Amount (base units)
                    <input value={authAmount} onChange={(event) => setAuthAmount(event.target.value)} />
                </label>
                <label className={styles.label}>
                    Expiry slots
                    <input value={expirySlots} onChange={(event) => setExpirySlots(event.target.value)} />
                </label>
                <label className={styles.label}>
                    Circuit ID
                    <input type="number" value={circuitId} onChange={(event) => setCircuitId(Number(event.target.value))} />
                </label>
                <button className={styles.button} onClick={handleCreateAuthorization} disabled={!publicKey || !parsedMint || busy}>
                    Create authorization
                </button>
            </div>
            <div className={styles.divider} />
            <div className={styles.column}>
                <label className={styles.label}>
                    Recipient wallet
                    <input value={recipient} onChange={(event) => setRecipient(event.target.value)} />
                </label>
                <label className={styles.label}>
                    Nullifier index
                    <input
                        type="number"
                        value={nullifierIndex}
                        onChange={(event) => setNullifierIndex(Number(event.target.value))}
                    />
                </label>
                <p className={styles.helper}>
                    Intent: {intentHash ? `${toHex(intentHash).slice(0, 12)}...` : 'not created'}
                </p>
                <button
                    className={styles.button}
                    onClick={handleSettleAuthorization}
                    disabled={!publicKey || !parsedMint || !parsedRecipient || !intentHash || busy}
                >
                    Settle authorization
                </button>
            </div>
        </section>
    );
};
