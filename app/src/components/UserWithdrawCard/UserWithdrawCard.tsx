import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './UserWithdrawCard.module.css';
import { formatTokenAmount } from '../../lib/amount';
import { runWithdrawFlow } from '../../lib/flows';

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
    onRootChange: (next: Uint8Array) => void;
    onRecord?: (record: import('../../lib/transactions').TransactionRecord) => string;
    onRecordUpdate?: (id: string, patch: import('../../lib/transactions').TransactionRecordPatch) => void;
    embedded?: boolean;
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
    onRootChange,
    onRecord,
    onRecordUpdate,
    embedded = false,
}) => {
    const [amount, setAmount] = useState(DEFAULT_AMOUNT);
    const [recipient, setRecipient] = useState('');
    const [busy, setBusy] = useState(false);
    const { signMessage } = useWallet();

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
            const result = await runWithdrawFlow({
                program: veilpayProgram,
                verifierProgram,
                mint: parsedMint,
                recipient: parsedRecipient,
                amount,
                mintDecimals,
                root,
                nextNullifier,
                onStatus,
                onDebit,
                onRootChange,
                signMessage: signMessage ?? undefined,
            });
            if (onRecord) {
                const { createTransactionRecord } = await import('../../lib/transactions');
                const recordId = onRecord(
                    createTransactionRecord('withdraw', {
                        signature: result.signature,
                        relayer: true,
                        status: 'confirmed',
                        details: {
                            mint: parsedMint.toBase58(),
                            recipient: parsedRecipient.toBase58(),
                            amount,
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
            onStatus(`Withdraw failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={embedded ? styles.embedded : styles.card}>
            <header>
                {embedded ? <h3>Withdraw</h3> : <h2>Withdraw</h2>}
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
