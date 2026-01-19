import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Buffer } from 'buffer';
import { PublicKey, Transaction } from '@solana/web3.js';
import { BN, Program } from '@coral-xyz/anchor';
import type { AnchorProvider } from '@coral-xyz/anchor';
import {
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    getAccount,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import styles from './TransferCard.module.css';
import { deriveConfig, deriveShielded, deriveVault, deriveVerifierKey } from '../../lib/pda';
import { computeCommitment, computeNullifier, generateProof, bigIntToBytes32, preflightVerify, formatPublicSignals } from '../../lib/prover';
import { ensureNullifierSet } from '../../lib/nullifier';
import { bytesToBigIntBE, modField, randomBytes, sha256, toHex } from '../../lib/crypto';
import { VERIFIER_PROGRAM_ID } from '../../lib/config';
import { submitViaRelayer } from '../../lib/relayer';

type TransferCardProps = {
    veilpayProgram: Program | null;
    mintAddress: string;
    onStatus: (message: string) => void;
    root: Uint8Array;
    onRootChange: (next: Uint8Array) => void;
};

export const TransferCard: FC<TransferCardProps> = ({
    veilpayProgram,
    mintAddress,
    onStatus,
    root,
    onRootChange,
}) => {
    const [internalRecipientHash, setInternalRecipientHash] = useState('');
    const [externalRecipient, setExternalRecipient] = useState('');
    const [externalAmount, setExternalAmount] = useState('250000');
    const [relayerFeeBps, setRelayerFeeBps] = useState('0');
    const [relayerPubkey, setRelayerPubkey] = useState('');
    const [nullifierIndex, setNullifierIndex] = useState(3);
    const [busy, setBusy] = useState(false);

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);

    const parsedExternalRecipient = useMemo(() => {
        if (!externalRecipient) return null;
        try {
            return new PublicKey(externalRecipient);
        } catch {
            return null;
        }
    }, [externalRecipient]);

    const parsedRelayer = useMemo(() => {
        if (!relayerPubkey) return null;
        try {
            return new PublicKey(relayerPubkey);
        } catch {
            return null;
        }
    }, [relayerPubkey]);

    const recipientTagHash = useMemo(() => {
        const clean = internalRecipientHash.replace(/^0x/, '');
        if (clean.length !== 64) return randomBytes(32);
        const out = new Uint8Array(32);
        for (let i = 0; i < 32; i += 1) {
            out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
    }, [internalRecipientHash]);

    const handleInternal = async () => {
        if (!veilpayProgram || !parsedMint) return;
        setBusy(true);
        try {
            onStatus('Submitting internal transfer...');
            const config = deriveConfig(veilpayProgram.programId);
            const shieldedState = deriveShielded(veilpayProgram.programId, parsedMint);
            const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);
            const newRootValue = modField(bytesToBigIntBE(randomBytes(32)));
            const newRoot = bigIntToBytes32(newRootValue);
            const ciphertextNew = randomBytes(64);
            const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
            const randomness = modField(bytesToBigIntBE(randomBytes(32)));
            const leafIndex = BigInt(nullifierIndex);
            const amountValue = 0n;
            const nullifierValue = await computeNullifier(senderSecret, leafIndex);
            const recipientTagHashValue = modField(bytesToBigIntBE(recipientTagHash));
            const commitmentValue = await computeCommitment(amountValue, randomness, recipientTagHashValue);
            const nullifierSet = await ensureNullifierSet(veilpayProgram, parsedMint, nullifierValue);

            onStatus('Generating Groth16 proof...');
            const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
                root: bytesToBigIntBE(root).toString(),
                nullifier: nullifierValue.toString(),
                recipient_tag_hash: recipientTagHashValue.toString(),
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

            await veilpayProgram.methods
                .internalTransfer({
                    proof: Buffer.from(proofBytes),
                    publicInputs: Buffer.from(publicInputsBytes),
                    nullifier: Buffer.from(bigIntToBytes32(nullifierValue)),
                    root: Buffer.from(root),
                    newRoot: Buffer.from(newRoot),
                    ciphertextNew: Buffer.from(ciphertextNew),
                    recipientTagHash: Buffer.from(bigIntToBytes32(recipientTagHashValue)),
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
            onStatus(`Internal transfer complete. Root ${toHex(newRoot).slice(0, 12)}...`);
        } catch (error) {
            onStatus(`Internal transfer failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    const handleExternal = async () => {
        if (!veilpayProgram || !parsedMint || !parsedExternalRecipient) return;
        setBusy(true);
        try {
            if (Number(relayerFeeBps) > 0 && !parsedRelayer) {
                throw new Error('Relayer pubkey required when relayer fee > 0.');
            }
            onStatus('Submitting external transfer...');
            const config = deriveConfig(veilpayProgram.programId);
            const vault = deriveVault(veilpayProgram.programId, parsedMint);
            const shieldedState = deriveShielded(veilpayProgram.programId, parsedMint);
            const vaultAta = await getAssociatedTokenAddress(parsedMint, vault, true);
            const destinationAta = await getAssociatedTokenAddress(parsedMint, parsedExternalRecipient);
            const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, 0);
            const relayerFeeAta = parsedRelayer
                ? await getAssociatedTokenAddress(parsedMint, parsedRelayer)
                : null;
            const provider = veilpayProgram.provider as AnchorProvider;
            const wallet = provider.wallet;
            if (!wallet) {
                throw new Error('Connect a wallet to transfer.');
            }

            const ensureAta = async (ata: PublicKey, owner: PublicKey) => {
                try {
                    await getAccount(provider.connection, ata);
                } catch {
                    const ix = createAssociatedTokenAccountInstruction(
                        wallet.publicKey,
                        ata,
                        owner,
                        parsedMint
                    );
                    await provider.sendAndConfirm(new Transaction().add(ix));
                }
            };

            await ensureAta(destinationAta, parsedExternalRecipient);
            if (relayerFeeAta && parsedRelayer) {
                await ensureAta(relayerFeeAta, parsedRelayer);
            }

            const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
            const randomness = modField(bytesToBigIntBE(randomBytes(32)));
            const leafIndex = BigInt(nullifierIndex);
            const amountValue = BigInt(externalAmount);
            const recipientTagHashBytes = await sha256(parsedExternalRecipient.toBytes());
            const recipientTagHashValue = modField(bytesToBigIntBE(recipientTagHashBytes));
            const nullifierValue = await computeNullifier(senderSecret, leafIndex);
            const commitmentValue = await computeCommitment(amountValue, randomness, recipientTagHashValue);
            const nullifierSet = await ensureNullifierSet(veilpayProgram, parsedMint, nullifierValue);

            onStatus('Generating Groth16 proof...');
            const { proofBytes, publicInputsBytes, publicSignals, proof } = await generateProof({
                root: bytesToBigIntBE(root).toString(),
                nullifier: nullifierValue.toString(),
                recipient_tag_hash: recipientTagHashValue.toString(),
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
                ...(relayerFeeAta ? { relayerFeeAta } : {}),
            };

            const ix = await veilpayProgram.methods
                .externalTransfer({
                    amount: new BN(externalAmount),
                    proof: Buffer.from(proofBytes),
                    publicInputs: Buffer.from(publicInputsBytes),
                    nullifier: Buffer.from(bigIntToBytes32(nullifierValue)),
                    root: Buffer.from(root),
                    relayerFeeBps: Number(relayerFeeBps),
                })
                .accounts(accounts)
                .instruction();

            await submitViaRelayer(provider, new Transaction().add(ix));

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
                <p>Internal transfers keep amounts hidden; external transfers reveal the amount.</p>
            </header>
            <div className={styles.column}>
                <h3>Internal transfer</h3>
                <label className={styles.label}>
                    Recipient tag hash (hex)
                    <input value={internalRecipientHash} onChange={(event) => setInternalRecipientHash(event.target.value)} />
                </label>
                <label className={styles.label}>
                    Nullifier index
                    <input
                        type="number"
                        value={nullifierIndex}
                        onChange={(event) => setNullifierIndex(Number(event.target.value))}
                    />
                </label>
                <p className={styles.helper}>Current root: {toHex(root).slice(0, 12)}...</p>
                <button className={styles.button} onClick={handleInternal} disabled={!parsedMint || busy}>
                    Execute internal transfer
                </button>
            </div>
            <div className={styles.divider} />
            <div className={styles.column}>
                <h3>External transfer</h3>
                <label className={styles.label}>
                    Amount
                    <input value={externalAmount} onChange={(event) => setExternalAmount(event.target.value)} />
                </label>
                <label className={styles.label}>
                    Destination wallet
                    <input value={externalRecipient} onChange={(event) => setExternalRecipient(event.target.value)} />
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
                <button className={styles.button} onClick={handleExternal} disabled={!parsedMint || !parsedExternalRecipient || busy}>
                    Execute external transfer
                </button>
            </div>
        </section>
    );
};
