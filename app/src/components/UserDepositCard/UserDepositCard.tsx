import { useEffect, useMemo, useState } from 'react';
import type { FC } from 'react';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import styles from './UserDepositCard.module.css';
import { formatTokenAmount } from '../../lib/amount';
import { runDepositFlow } from '../../lib/flows';
import { rescanNotesForOwner } from '../../lib/noteScanner';
import { fetchTransactionDetails } from '../../lib/transactions';
import { deriveViewKeypair } from '../../lib/notes';
import { useWallet } from '@solana/wallet-adapter-react';
import { WSOL_MINT } from '../../lib/config';
import { FlowStepsModal } from '../FlowSteps';
import type { FlowStepHandler, FlowStepStatus } from '../../lib/flowSteps';
import { initStepStatus } from '../../lib/flowSteps';

type UserDepositCardProps = {
    veilpayProgram: Program | null;
    mintAddress: string;
    onStatus: (message: string) => void;
    onRootChange: (next: Uint8Array) => void;
    mintDecimals: number | null;
    walletBalance: bigint | null;
    solBalance: bigint | null;
    onCredit: (amount: bigint) => void;
    onRecord?: (record: import('../../lib/transactions').TransactionRecord) => string;
    onRecordUpdate?: (id: string, patch: import('../../lib/transactions').TransactionRecordPatch) => void;
    embedded?: boolean;
};

export const UserDepositCard: FC<UserDepositCardProps> = ({
    veilpayProgram,
    mintAddress,
    onStatus,
    onRootChange,
    mintDecimals,
    walletBalance,
    solBalance,
    onCredit,
    onRecord,
    onRecordUpdate,
    embedded = false,
}) => {
    const [amount, setAmount] = useState('');
    const [depositAsset, setDepositAsset] = useState<'sol' | 'wsol'>('sol');
    const [busy, setBusy] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const { publicKey, signMessage } = useWallet();
    const steps = useMemo(
        () => [
            { id: 'sync', label: 'Sync identity + notes' },
            { id: 'keys', label: 'Sign message to derive view key', requiresSignature: true },
            { id: 'submit', label: 'Sign & confirm deposit', requiresSignature: true },
            { id: 'confirm', label: 'Update shielded balance' },
        ],
        []
    );
    const [stepStatus, setStepStatus] = useState<Record<string, FlowStepStatus>>(() => initStepStatus(steps));

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);
    const supportsSol = useMemo(() => parsedMint?.equals(WSOL_MINT) ?? false, [parsedMint]);
    const solDecimals = 9;

    useEffect(() => {
        if (!supportsSol && depositAsset === 'sol') {
            setDepositAsset('wsol');
        }
    }, [supportsSol, depositAsset]);

    const handleStep: FlowStepHandler = (stepId, status) => {
        setStepStatus((prev) => ({ ...prev, [stepId]: status }));
    };

    const handleDeposit = async () => {
        if (!veilpayProgram || !parsedMint || mintDecimals === null) return;
        const asset = supportsSol ? depositAsset : 'wsol';
        setBusy(true);
        setModalOpen(true);
        setStepStatus(initStepStatus(steps));
        try {
            const result = await runDepositFlow({
                program: veilpayProgram,
                mint: parsedMint,
                amount,
                mintDecimals,
                depositAsset: asset,
                onStatus,
                onRootChange,
                onCredit,
                signMessage: signMessage ?? undefined,
                onStep: handleStep,
                rescanNotes: async () => {
                    if (!publicKey || !signMessage) {
                        throw new Error('Connect a wallet that can sign a message to rescan notes.');
                    }
                    await rescanNotesForOwner({
                        program: veilpayProgram,
                        mint: parsedMint,
                        owner: publicKey,
                        onStatus,
                        signMessage,
                    });
                },
                ensureRecipientSecret: async () => {
                    if (!publicKey || !signMessage) {
                        throw new Error('Connect a wallet that can sign a message to derive view keys.');
                    }
                    await deriveViewKeypair({ owner: publicKey, signMessage, index: 0 });
                },
            });
            if (onRecord) {
                const { createTransactionRecord } = await import('../../lib/transactions');
                const recordId = onRecord(
                    createTransactionRecord('deposit', {
                        signature: result.signature,
                        relayer: false,
                        status: 'confirmed',
                        details: {
                            mint: parsedMint.toBase58(),
                            amount,
                            amountBaseUnits: result.amountBaseUnits.toString(),
                        },
                    })
                );
                if (onRecordUpdate) {
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
            onStatus(`Deposit failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
            setModalOpen(false);
        }
    };

    return (
        <section className={embedded ? styles.embedded : styles.card}>
            <header>
                {embedded ? <h3>Deposit</h3> : <h2>Deposit</h2>}
                <p>Move funds into your private balance.</p>
            </header>
            <FlowStepsModal
                open={modalOpen}
                title="Deposit in progress"
                steps={steps}
                status={stepStatus}
                allowClose={!busy}
                onClose={() => setModalOpen(false)}
            />
            {supportsSol && (
                <div className={styles.assetToggle}>
                    <button
                        type="button"
                        className={depositAsset === 'sol' ? styles.assetActive : styles.assetButton}
                        onClick={() => setDepositAsset('sol')}
                        disabled={busy}
                    >
                        SOL
                    </button>
                    <button
                        type="button"
                        className={depositAsset === 'wsol' ? styles.assetActive : styles.assetButton}
                        onClick={() => setDepositAsset('wsol')}
                        disabled={busy}
                    >
                        WSOL
                    </button>
                </div>
            )}
            <div className={styles.labelRow}>
                <label className={styles.label}>
                    Amount (tokens)
                    <input
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        placeholder="0.00"
                    />
                </label>
                {walletBalance !== null &&
                    mintDecimals !== null &&
                    (!supportsSol || depositAsset === 'wsol') && (
                    <button
                        type="button"
                        className={styles.balanceButton}
                        onClick={() => setAmount(formatTokenAmount(walletBalance, mintDecimals))}
                    >
                        Wallet: {formatTokenAmount(walletBalance, mintDecimals)}
                    </button>
                )}
                {supportsSol && depositAsset === 'sol' && solBalance !== null && (
                    <button
                        type="button"
                        className={styles.balanceButton}
                        onClick={() => setAmount(formatTokenAmount(solBalance, solDecimals))}
                    >
                        Wallet: {formatTokenAmount(solBalance, solDecimals)}
                    </button>
                )}
            </div>
            <button className={styles.button} disabled={!parsedMint || mintDecimals === null || busy} onClick={handleDeposit}>
                Deposit
            </button>
        </section>
    );
};
