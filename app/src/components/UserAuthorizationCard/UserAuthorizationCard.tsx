import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Buffer } from 'buffer';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import styles from './UserAuthorizationCard.module.css';
import { useWallet } from '@solana/wallet-adapter-react';
import { formatTokenAmount } from '../../lib/amount';
import { runCreateAuthorizationFlow, runSettleAuthorizationFlow } from '../../lib/flows';

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
    onRecord?: (record: import('../../lib/transactions').TransactionRecord) => string;
    onRecordUpdate?: (id: string, patch: import('../../lib/transactions').TransactionRecordPatch) => void;
    embedded?: boolean;
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
    onRecord,
    onRecordUpdate,
    embedded = false,
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
            const result = await runCreateAuthorizationFlow({
                program: veilpayProgram,
                mint: parsedMint,
                payer: publicKey,
                signMessage,
                payee: parsedPayee,
                amount,
                expirySlots,
                onStatus,
            });
            setIntentHash(result.intentHash);
            if (onRecord) {
                const { createTransactionRecord } = await import('../../lib/transactions');
                const recordId = onRecord(
                    createTransactionRecord('authorization:create', {
                        signature: result.signature,
                        relayer: false,
                        status: 'confirmed',
                        details: {
                            mint: parsedMint.toBase58(),
                            payee: parsedPayee.toBase58(),
                            amount,
                            expirySlot: result.expirySlot.toString(),
                            intentHash: Buffer.from(result.intentHash).toString('hex'),
                            amountCiphertext: Buffer.from(result.amountCiphertext).toString('base64'),
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
            onStatus(`Authorization failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    const handleSettle = async () => {
        if (!veilpayProgram || !parsedMint || !publicKey || !parsedPayee || !intentHash || mintDecimals === null) return;
        setBusy(true);
        try {
            const result = await runSettleAuthorizationFlow({
                program: veilpayProgram,
                verifierProgram,
                mint: parsedMint,
                payee: parsedPayee,
                amount,
                mintDecimals,
                root,
                nextNullifier,
                intentHash,
                onStatus,
                onDebit,
            });
            if (onRecord) {
                const { createTransactionRecord } = await import('../../lib/transactions');
                const recordId = onRecord(
                    createTransactionRecord('authorization:settle', {
                        signature: result.signature,
                        relayer: true,
                        status: 'confirmed',
                        details: {
                            mint: parsedMint.toBase58(),
                            payee: parsedPayee.toBase58(),
                            amount,
                            amountBaseUnits: result.amountBaseUnits.toString(),
                            nullifier: result.nullifier.toString(),
                            intentHash: Buffer.from(intentHash).toString('hex'),
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
            onStatus(`Settle failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={embedded ? styles.embedded : styles.card}>
            <header>
                {embedded ? <h3>Authorization</h3> : <h2>Authorization</h2>}
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
