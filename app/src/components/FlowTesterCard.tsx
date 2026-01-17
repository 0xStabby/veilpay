import React, { FC, useEffect, useMemo, useRef, useState } from 'react';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './FlowTesterCard.module.css';
import { formatTokenAmount, parseTokenAmount } from '../lib/amount';
import {
    runCreateAuthorizationFlow,
    runDepositFlow,
    runExternalTransferFlow,
    runInternalTransferFlow,
    runSettleAuthorizationFlow,
    runWithdrawFlow,
} from '../lib/flows';

type FlowStatus = 'idle' | 'running' | 'success' | 'error';

type FlowTesterCardProps = {
    veilpayProgram: Program | null;
    verifierProgram: Program | null;
    mintAddress: string;
    root: Uint8Array;
    onRootChange: (next: Uint8Array) => void;
    nextNullifier: () => number;
    mintDecimals: number | null;
    walletBalance: bigint | null;
    shieldedBalance: bigint;
    onCredit: (amount: bigint) => void;
    onDebit: (amount: bigint) => void;
    onStatus: (message: string) => void;
};

const DEFAULT_AMOUNT = '1';

export const FlowTesterCard: FC<FlowTesterCardProps> = ({
    veilpayProgram,
    verifierProgram,
    mintAddress,
    root,
    onRootChange,
    nextNullifier,
    mintDecimals,
    walletBalance,
    shieldedBalance,
    onCredit,
    onDebit,
    onStatus,
}) => {
    const { publicKey, signMessage } = useWallet();
    const [amount, setAmount] = useState(DEFAULT_AMOUNT);
    const [recipient, setRecipient] = useState('');
    const [selected, setSelected] = useState(() => ({
        deposit: true,
        withdraw: true,
        authorization: true,
        internal: true,
        external: true,
    }));
    const [statuses, setStatuses] = useState<Record<string, { status: FlowStatus; message?: string }>>({});
    const [busy, setBusy] = useState(false);
    const rootRef = useRef(root);

    useEffect(() => {
        rootRef.current = root;
    }, [root]);

    useEffect(() => {
        if (publicKey && !recipient) {
            setRecipient(publicKey.toBase58());
        }
    }, [publicKey, recipient]);

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

    const handleRootUpdate = (next: Uint8Array) => {
        rootRef.current = next;
        onRootChange(next);
    };

    const updateStatus = (id: string, status: FlowStatus, message?: string) => {
        setStatuses((prev) => ({ ...prev, [id]: { status, message } }));
    };

    const canRun = Boolean(veilpayProgram && parsedMint && mintDecimals !== null && parsedRecipient);

    const runAll = async () => {
        if (!veilpayProgram || !parsedMint || mintDecimals === null || !parsedRecipient) return;
        if (!publicKey || !signMessage) {
            onStatus('Connect a wallet that supports message signing.');
            return;
        }
        const requestedAmount = parseTokenAmount(amount, mintDecimals);
        if (requestedAmount <= 0n) {
            onStatus('Enter a valid amount for the flow test.');
            return;
        }
        setBusy(true);
        onStatus('Running flow tests...');
        let runningBalance = shieldedBalance;
        const completedDebits = new Set<string>();

        const computeDebitAmount = (label: string) => {
            const remainingDebits = steps.filter(
                (step) =>
                    step.type === 'debit' &&
                    selected[step.id as keyof typeof selected] &&
                    !completedDebits.has(step.id)
            ).length;
            const perStep = runningBalance / BigInt(Math.max(1, remainingDebits));
            const useAmount = perStep < requestedAmount ? perStep : requestedAmount;
            if (useAmount <= 0n) {
                throw new Error(`Insufficient shielded balance for ${label.toLowerCase()}.`);
            }
            const amountString = formatTokenAmount(useAmount, mintDecimals);
            if (useAmount !== requestedAmount) {
                onStatus(`Adjusting ${label.toLowerCase()} amount to ${amountString} to fit remaining balance.`);
            }
            return { useAmount, amountString };
        };

        const steps = [
            {
                id: 'deposit',
                label: 'Deposit',
                type: 'credit' as const,
                run: async () => {
                    await runDepositFlow({
                        program: veilpayProgram,
                        mint: parsedMint,
                        amount,
                        mintDecimals,
                        onStatus,
                        onRootChange: handleRootUpdate,
                        onCredit,
                    });
                    runningBalance += requestedAmount;
                },
            },
            {
                id: 'withdraw',
                label: 'Withdraw',
                type: 'debit' as const,
                run: async () => {
                    const { useAmount, amountString } = computeDebitAmount('Withdraw');
                    await runWithdrawFlow({
                        program: veilpayProgram,
                        verifierProgram,
                        mint: parsedMint,
                        recipient: parsedRecipient,
                        amount: amountString,
                        mintDecimals,
                        root: rootRef.current,
                        nextNullifier,
                        onStatus,
                        onDebit,
                    });
                    runningBalance -= useAmount;
                },
            },
            {
                id: 'authorization',
                label: 'Authorization',
                type: 'debit' as const,
                run: async () => {
                    const { useAmount, amountString } = computeDebitAmount('Authorization');
                    const intent = await runCreateAuthorizationFlow({
                        program: veilpayProgram,
                        mint: parsedMint,
                        payer: publicKey,
                        signMessage,
                        payee: parsedRecipient,
                        amount: amountString,
                        expirySlots: '200',
                        onStatus,
                    });
                    await runSettleAuthorizationFlow({
                        program: veilpayProgram,
                        verifierProgram,
                        mint: parsedMint,
                        payee: parsedRecipient,
                        amount: amountString,
                        mintDecimals,
                        root: rootRef.current,
                        nextNullifier,
                        intentHash: intent,
                        onStatus,
                        onDebit,
                    });
                    runningBalance -= useAmount;
                },
            },
            {
                id: 'internal',
                label: 'Internal transfer',
                type: 'neutral' as const,
                run: async () => {
                    await runInternalTransferFlow({
                        program: veilpayProgram,
                        verifierProgram,
                        mint: parsedMint,
                        recipient: parsedRecipient,
                        root: rootRef.current,
                        nextNullifier,
                        onStatus,
                        onRootChange: handleRootUpdate,
                    });
                },
            },
            {
                id: 'external',
                label: 'External transfer',
                type: 'debit' as const,
                run: async () => {
                    const { useAmount, amountString } = computeDebitAmount('External transfer');
                    await runExternalTransferFlow({
                        program: veilpayProgram,
                        verifierProgram,
                        mint: parsedMint,
                        recipient: parsedRecipient,
                        amount: amountString,
                        mintDecimals,
                        root: rootRef.current,
                        nextNullifier,
                        onStatus,
                        onDebit,
                    });
                    runningBalance -= useAmount;
                },
            },
        ];

        for (const step of steps) {
            if (!selected[step.id as keyof typeof selected]) continue;
            updateStatus(step.id, 'running');
            try {
                await step.run();
                if (step.type === 'debit') {
                    completedDebits.add(step.id);
                }
                updateStatus(step.id, 'success');
            } catch (error) {
                const message = error instanceof Error ? error.message : 'unknown error';
                updateStatus(step.id, 'error', message);
                onStatus(`${step.label} failed: ${message}`);
                setBusy(false);
                return;
            }
        }

        onStatus('Flow tests complete.');
        setBusy(false);
    };

    return (
        <section className={styles.card}>
            <header>
                <h2>Flow Tester</h2>
                <p>Run end-to-end checks for every user flow.</p>
            </header>
            <div className={styles.inputs}>
                <label className={styles.label}>
                    Amount (tokens)
                    <input value={amount} onChange={(event) => setAmount(event.target.value)} />
                </label>
                {walletBalance !== null && mintDecimals !== null && (
                    <button
                        type="button"
                        className={styles.balanceButton}
                        onClick={() => setAmount(formatTokenAmount(walletBalance, mintDecimals))}
                    >
                        Wallet: {formatTokenAmount(walletBalance, mintDecimals)}
                    </button>
                )}
                <label className={styles.label}>
                    Recipient wallet
                    <input value={recipient} onChange={(event) => setRecipient(event.target.value)} />
                </label>
            </div>
            <div className={styles.checklist}>
                {[
                    { id: 'deposit', label: 'Deposit' },
                    { id: 'withdraw', label: 'Withdraw' },
                    { id: 'authorization', label: 'Authorization' },
                    { id: 'internal', label: 'Internal transfer' },
                    { id: 'external', label: 'External transfer' },
                ].map((item) => {
                    const state = statuses[item.id]?.status ?? 'idle';
                    return (
                        <label key={item.id} className={styles.checkRow}>
                            <input
                                type="checkbox"
                                checked={selected[item.id as keyof typeof selected]}
                                onChange={(event) =>
                                    setSelected((prev) => ({ ...prev, [item.id]: event.target.checked }))
                                }
                                disabled={busy}
                            />
                            <span className={styles.checkLabel}>{item.label}</span>
                            <span className={styles.checkStatus} data-status={state}>
                                {state === 'running' && 'Running'}
                                {state === 'success' && 'Done'}
                                {state === 'error' && 'Failed'}
                                {state === 'idle' && 'Idle'}
                            </span>
                        </label>
                    );
                })}
            </div>
            <button className={styles.button} disabled={!canRun || busy} onClick={runAll}>
                {busy ? 'Running flows...' : 'Run selected flows'}
            </button>
            {mintDecimals !== null && (
                <p className={styles.note}>Shielded balance: {formatTokenAmount(shieldedBalance, mintDecimals)}</p>
            )}
        </section>
    );
};
