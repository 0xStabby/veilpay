import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Buffer } from 'buffer';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import styles from './UserTransferCard.module.css';
import { formatTokenAmount } from '../../lib/amount';
import { runExternalTransferFlow, runInternalTransferFlow } from '../../lib/flows';

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
    onRecord?: (record: import('../../lib/transactions').TransactionRecord) => string;
    onRecordUpdate?: (id: string, patch: import('../../lib/transactions').TransactionRecordPatch) => void;
    embedded?: boolean;
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
    onRecord,
    onRecordUpdate,
    embedded = false,
}) => {
    const [internalRecipient, setInternalRecipient] = useState('');
    const [internalAmount, setInternalAmount] = useState('250000');
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
            const result = await runInternalTransferFlow({
                program: veilpayProgram,
                verifierProgram,
                mint: parsedMint,
                recipient: parsedInternalRecipient,
                amount: internalAmount,
                mintDecimals: mintDecimals ?? undefined,
                root,
                nextNullifier,
                onStatus,
                onRootChange,
            });
            if (onRecord) {
                const { createTransactionRecord } = await import('../../lib/transactions');
                const recordId = onRecord(
                    createTransactionRecord('transfer:internal', {
                        signature: result.signature,
                        relayer: false,
                        status: 'confirmed',
                        details: {
                            mint: parsedMint.toBase58(),
                            recipient: parsedInternalRecipient.toBase58(),
                            nullifier: result.nullifier.toString(),
                            newRoot: Buffer.from(result.newRoot).toString('hex'),
                        },
                    })
                );
                if (onRecordUpdate) {
                    const { fetchTransactionDetails } = await import('../../lib/transactions');
                    const txDetails = await fetchTransactionDetails(
                        veilpayProgram.provider.connection,
                        result.signature
                    );
                    if (txDetails) {
                        onRecordUpdate(recordId, { details: { tx: txDetails } });
                    }
                }
            }
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
            const result = await runExternalTransferFlow({
                program: veilpayProgram,
                verifierProgram,
                mint: parsedMint,
                recipient: parsedExternalRecipient,
                amount: externalAmount,
                mintDecimals,
                root,
                nextNullifier,
                onStatus,
                onDebit,
                onRootChange,
            });
            if (onRecord) {
                const { createTransactionRecord } = await import('../../lib/transactions');
                const recordId = onRecord(
                    createTransactionRecord('transfer:external', {
                        signature: result.signature,
                        relayer: true,
                        status: 'confirmed',
                        details: {
                            mint: parsedMint.toBase58(),
                            recipient: parsedExternalRecipient.toBase58(),
                            amount: externalAmount,
                            amountBaseUnits: result.amountBaseUnits.toString(),
                            nullifier: result.nullifier.toString(),
                        },
                    })
                );
                if (onRecordUpdate) {
                    const { fetchTransactionDetails } = await import('../../lib/transactions');
                    const txDetails = await fetchTransactionDetails(
                        veilpayProgram.provider.connection,
                        result.signature
                    );
                    if (txDetails) {
                        onRecordUpdate(recordId, { details: { tx: txDetails } });
                    }
                }
            }
        } catch (error) {
            onStatus(`External transfer failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={embedded ? styles.embedded : styles.card}>
            <header>
                {embedded ? <h3>Transfers</h3> : <h2>Transfers</h2>}
                <p>Send privately inside VeilPay or externally.</p>
            </header>
            <div className={styles.column}>
                <h3>Internal</h3>
                <label className={styles.label}>
                    Amount (tokens)
                    <input value={internalAmount} onChange={(event) => setInternalAmount(event.target.value)} />
                </label>
                {mintDecimals !== null && (
                    <button
                        type="button"
                        className={styles.balanceButton}
                        onClick={() => setInternalAmount(formatTokenAmount(shieldedBalance, mintDecimals))}
                    >
                        VeilPay balance: {formatTokenAmount(shieldedBalance, mintDecimals)}
                    </button>
                )}
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
