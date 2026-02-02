import { useEffect, useMemo, useState } from 'react';
import type { FC } from 'react';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './UserWithdrawCard.module.css';
import { formatTokenAmount } from '../../lib/amount';
import { runExternalTransferFlow } from '../../lib/flows';
import { WSOL_MINT } from '../../lib/config';
import { FlowStepsModal } from '../FlowSteps';
import type { FlowStepHandler, FlowStepStatus } from '../../lib/flowSteps';
import { initStepStatus } from '../../lib/flowSteps';

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
    const [amount, setAmount] = useState('');
    const [withdrawAsset, setWithdrawAsset] = useState<'sol' | 'wsol'>('sol');
    const [busy, setBusy] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const { signMessage, publicKey } = useWallet();
    const steps = useMemo(
        () => [
            { id: 'sync', label: 'Sync identity + notes' },
            { id: 'proof', label: 'Generate withdrawal proof' },
            { id: 'upload', label: 'Sign proof upload', requiresSignature: true },
            { id: 'submit', label: 'Authorize relayer transfer', requiresSignature: true },
            { id: 'confirm', label: 'Confirm + sync shielded state' },
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

    useEffect(() => {
        if (withdrawAsset === 'sol' && !supportsSol) {
            setWithdrawAsset('wsol');
        }
    }, [withdrawAsset, supportsSol]);

    const handleStep: FlowStepHandler = (stepId, status) => {
        setStepStatus((prev) => ({ ...prev, [stepId]: status }));
    };

    const handleWithdraw = async () => {
        if (!veilpayProgram || !parsedMint || !publicKey || mintDecimals === null) return;
        const asset = supportsSol ? withdrawAsset : 'wsol';
        setBusy(true);
        setModalOpen(true);
        setStepStatus(initStepStatus(steps));
        try {
            const result = await runExternalTransferFlow({
                program: veilpayProgram,
                verifierProgram,
                mint: parsedMint,
                recipient: publicKey,
                amount,
                mintDecimals,
                deliverAsset: asset,
                root,
                nextNullifier,
                onStatus,
                onDebit,
                onRootChange,
                signMessage: signMessage ?? undefined,
                onStep: handleStep,
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
                            recipient: publicKey.toBase58(),
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
            setModalOpen(false);
        }
    };

    return (
        <section className={embedded ? styles.embedded : styles.card}>
            <header>
                {embedded ? <h3>Withdraw</h3> : <h2>Withdraw</h2>}
                <p>Move funds out to your wallet.</p>
            </header>
            <FlowStepsModal
                open={modalOpen}
                title="Withdraw in progress"
                steps={steps}
                status={stepStatus}
                allowClose={!busy}
                onClose={() => setModalOpen(false)}
            />
            {supportsSol && (
                <div className={styles.assetToggle}>
                    <button
                        type="button"
                        className={withdrawAsset === 'sol' ? styles.assetActive : styles.assetButton}
                        onClick={() => setWithdrawAsset('sol')}
                        disabled={busy}
                    >
                        SOL
                    </button>
                    <button
                        type="button"
                        className={withdrawAsset === 'wsol' ? styles.assetActive : styles.assetButton}
                        onClick={() => setWithdrawAsset('wsol')}
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
            <button
                className={styles.button}
                disabled={!publicKey || !parsedMint || mintDecimals === null || busy}
                onClick={handleWithdraw}
            >
                Withdraw
            </button>
        </section>
    );
};
