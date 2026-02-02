import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Buffer } from 'buffer';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './UserTransferCard.module.css';
import { formatTokenAmount } from '../../lib/amount';
import { runExternalTransferFlow, runInternalTransferFlow } from '../../lib/flows';
import { parseViewKey } from '../../lib/notes';
import { WSOL_MINT } from '../../lib/config';
import { FlowStepsModal } from '../FlowSteps';
import type { FlowStepStatus } from '../../lib/flowSteps';
import { initStepStatus } from '../../lib/flowSteps';

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
    flowLocked?: boolean;
    flowLockedReason?: string | null;
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
    flowLocked = false,
    flowLockedReason = null,
}) => {
    const [internalRecipient, setInternalRecipient] = useState('');
    const [internalAmount, setInternalAmount] = useState('');
    const [externalRecipient, setExternalRecipient] = useState('');
    const [externalAmount, setExternalAmount] = useState('');
    const [busy, setBusy] = useState(false);
    const [internalModalOpen, setInternalModalOpen] = useState(false);
    const [externalModalOpen, setExternalModalOpen] = useState(false);
    const { signMessage } = useWallet();
    const internalSteps = useMemo(
        () => [
            { id: 'sync', label: 'Sync identity + notes' },
            { id: 'proof', label: 'Generate transfer proof' },
            { id: 'upload', label: 'Sign proof upload', requiresSignature: true },
            { id: 'submit', label: 'Authorize transfer', requiresSignature: true },
            { id: 'confirm', label: 'Update notes + root' },
        ],
        []
    );
    const externalSteps = useMemo(
        () => [
            { id: 'sync', label: 'Sync identity + notes' },
            { id: 'proof', label: 'Generate transfer proof' },
            { id: 'upload', label: 'Sign proof upload', requiresSignature: true },
            { id: 'submit', label: 'Authorize relayer transfer', requiresSignature: true },
            { id: 'confirm', label: 'Confirm + sync shielded state' },
        ],
        []
    );
    const [internalStatus, setInternalStatus] = useState<Record<string, FlowStepStatus>>(() =>
        initStepStatus(internalSteps)
    );
    const [externalStatus, setExternalStatus] = useState<Record<string, FlowStepStatus>>(() =>
        initStepStatus(externalSteps)
    );

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
            return parseViewKey(internalRecipient);
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
        setInternalModalOpen(true);
        setInternalStatus(initStepStatus(internalSteps));
        try {
            const result = await runInternalTransferFlow({
                program: veilpayProgram,
                verifierProgram,
                mint: parsedMint,
                recipientViewKey: internalRecipient.trim(),
                amount: internalAmount,
                mintDecimals: mintDecimals ?? undefined,
                root,
                nextNullifier,
                onStatus,
                onRootChange,
                signMessage: signMessage ?? undefined,
                onStep: (stepId, status) =>
                    setInternalStatus((prev) => ({ ...prev, [stepId]: status })),
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
                            recipient: internalRecipient.trim(),
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
            setInternalModalOpen(false);
        }
    };


    const handleExternal = async () => {
        if (!veilpayProgram || !parsedMint || !parsedExternalRecipient || mintDecimals === null) return;
        onStatus(`External transfer starting. mint=${parsedMint.toBase58()} recipient=${parsedExternalRecipient.toBase58()}`);
        setBusy(true);
        setExternalModalOpen(true);
        setExternalStatus(initStepStatus(externalSteps));
        try {
            const deliverAsset = parsedMint.equals(WSOL_MINT) ? 'sol' : 'wsol';
            const result = await runExternalTransferFlow({
                program: veilpayProgram,
                verifierProgram,
                mint: parsedMint,
                recipient: parsedExternalRecipient,
                amount: externalAmount,
                mintDecimals,
                deliverAsset,
                root,
                nextNullifier,
                onStatus,
                onDebit,
                onRootChange,
                signMessage: signMessage ?? undefined,
                onStep: (stepId, status) =>
                    setExternalStatus((prev) => ({ ...prev, [stepId]: status })),
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
            setExternalModalOpen(false);
        }
    };

    return (
        <section className={embedded ? styles.embedded : styles.card}>
            <header>
                {embedded ? <h3>Transfers</h3> : <h2>Transfers</h2>}
                <p>Send privately inside VeilPay or externally.</p>
            </header>
            {flowLocked && flowLockedReason && <p className={styles.locked}>{flowLockedReason}</p>}
            <div className={styles.column}>
                <h3>Internal</h3>
                <FlowStepsModal
                    open={internalModalOpen}
                    title="Internal transfer in progress"
                    steps={internalSteps}
                    status={internalStatus}
                    allowClose={!busy}
                    onClose={() => setInternalModalOpen(false)}
                />
                <label className={styles.label}>
                    Amount (tokens)
                    <input
                        value={internalAmount}
                        onChange={(event) => setInternalAmount(event.target.value)}
                        placeholder="0.00"
                    />
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
                    Recipient view key
                    <input
                        value={internalRecipient}
                        onChange={(event) => setInternalRecipient(event.target.value)}
                        placeholder="recipient view key (x:y hex)"
                    />
                </label>
                <button
                    className={styles.button}
                    disabled={!parsedInternalRecipient || !parsedMint || busy || flowLocked}
                    onClick={handleInternal}
                >
                    Send internally
                </button>
            </div>
            <div className={styles.divider} />
            <div className={styles.column}>
                <h3>External</h3>
                <FlowStepsModal
                    open={externalModalOpen}
                    title="External transfer in progress"
                    steps={externalSteps}
                    status={externalStatus}
                    allowClose={!busy}
                    onClose={() => setExternalModalOpen(false)}
                />
                <label className={styles.label}>
                    Amount (tokens)
                    <input
                        value={externalAmount}
                        onChange={(event) => setExternalAmount(event.target.value)}
                        placeholder="0.00"
                    />
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
                    disabled={!parsedExternalRecipient || !parsedMint || mintDecimals === null || busy || flowLocked}
                    onClick={handleExternal}
                >
                    Send externally
                </button>
            </div>
        </section>
    );
};
