import { useEffect, useMemo, useRef, useState } from 'react';
import type { FC } from 'react';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './FlowTesterCard.module.css';
import { formatTokenAmount, parseTokenAmount } from '../../lib/amount';
import { Buffer } from 'buffer';
import { runDepositFlow, runExternalTransferFlow, runInternalTransferFlow } from '../../lib/flows';
import { WSOL_MINT } from '../../lib/config';
import { deriveViewKeypair, parseViewKey, serializeViewKey } from '../../lib/notes';

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
    onRecord?: (record: import('../../lib/transactions').TransactionRecord) => string;
    onRecordUpdate?: (id: string, patch: import('../../lib/transactions').TransactionRecordPatch) => void;
};

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
    onRecord,
    onRecordUpdate,
}) => {
    const { publicKey, signMessage } = useWallet();
    const [amount, setAmount] = useState('');
    const [recipient, setRecipient] = useState('');
    const [internalRecipientViewKey, setInternalRecipientViewKey] = useState('');
    const [selected, setSelected] = useState(() => ({
        deposit: true,
        withdraw: true,
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

    useEffect(() => {
        const updateViewKey = async () => {
            if (!publicKey || !signMessage) return;
            try {
                const viewKey = await deriveViewKeypair({
                    owner: publicKey,
                    signMessage,
                    index: 0,
                });
                setInternalRecipientViewKey(serializeViewKey(viewKey.pubkey));
            } catch {
                // ignore derivation errors until user requests
            }
        };
        if (!internalRecipientViewKey) {
            void updateViewKey();
        }
    }, [publicKey, signMessage, internalRecipientViewKey]);

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

    const parsedInternalRecipientViewKey = useMemo(() => {
        if (!internalRecipientViewKey) return null;
        try {
            return parseViewKey(internalRecipientViewKey);
        } catch {
            return null;
        }
    }, [internalRecipientViewKey]);

    const handleRootUpdate = (next: Uint8Array) => {
        rootRef.current = next;
        onRootChange(next);
    };

    const updateStatus = (id: string, status: FlowStatus, message?: string) => {
        setStatuses((prev) => ({ ...prev, [id]: { status, message } }));
    };

    const canRun = Boolean(
        veilpayProgram &&
            parsedMint &&
            mintDecimals !== null &&
            parsedRecipient &&
            (!selected.internal || parsedInternalRecipientViewKey)
    );

    const runAll = async () => {
        if (!veilpayProgram || !parsedMint || mintDecimals === null || !parsedRecipient) return;
        if (!publicKey) {
            onStatus('Connect a wallet first.');
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

        const ensureRecipientSecret = async () => {
            if (!publicKey || !signMessage) {
                throw new Error('Connect a wallet that can sign a message to derive view keys.');
            }
        };

        const steps = [
            {
                id: 'deposit',
                label: 'Deposit',
                type: 'credit' as const,
                run: async () => {
                    const depositAsset = parsedMint.equals(WSOL_MINT) ? 'sol' : 'wsol';
                    const result = await runDepositFlow({
                        program: veilpayProgram,
                        mint: parsedMint,
                        amount,
                        mintDecimals,
                        depositAsset,
                        onStatus,
                        onRootChange: handleRootUpdate,
                        onCredit,
                        signMessage: signMessage ?? undefined,
                        ensureRecipientSecret,
                    });
                    runningBalance += requestedAmount;
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
                },
            },
            {
                id: 'withdraw',
                label: 'Withdraw',
                type: 'debit' as const,
                run: async () => {
                    const { useAmount, amountString } = computeDebitAmount('Withdraw');
                    const deliverAsset = parsedMint.equals(WSOL_MINT) ? 'sol' : 'wsol';
                    const result = await runExternalTransferFlow({
                        program: veilpayProgram,
                        verifierProgram,
                        mint: parsedMint,
                        recipient: publicKey,
                        amount: amountString,
                        mintDecimals,
                        deliverAsset,
                        root: rootRef.current,
                        nextNullifier,
                        onStatus,
                        onDebit,
                        onRootChange: handleRootUpdate,
                        ensureRecipientSecret,
                        signMessage: signMessage ?? undefined,
                    });
                    runningBalance -= useAmount;
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
                                    amount: amountString,
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
                },
            },
            {
                id: 'internal',
                label: 'Internal transfer',
                type: 'neutral' as const,
                run: async () => {
                    if (!internalRecipientViewKey) {
                        throw new Error('Enter a recipient view key for internal transfers.');
                    }
                    const result = await runInternalTransferFlow({
                        program: veilpayProgram,
                        verifierProgram,
                        mint: parsedMint,
                        recipientViewKey: internalRecipientViewKey,
                        root: rootRef.current,
                        nextNullifier,
                        onStatus,
                        onRootChange: handleRootUpdate,
                        ensureRecipientSecret,
                        signMessage: signMessage ?? undefined,
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
                                    recipient: internalRecipientViewKey,
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
                },
            },
            {
                id: 'external',
                label: 'External transfer',
                type: 'debit' as const,
                run: async () => {
                    const { useAmount, amountString } = computeDebitAmount('External transfer');
                    const result = await runExternalTransferFlow({
                        program: veilpayProgram,
                        verifierProgram,
                        mint: parsedMint,
                        recipient: parsedRecipient,
                        amount: amountString,
                        mintDecimals,
                        deliverAsset: parsedMint.equals(WSOL_MINT) ? 'sol' : 'wsol',
                        root: rootRef.current,
                        nextNullifier,
                        onStatus,
                        onDebit,
                        onRootChange: handleRootUpdate,
                        ensureRecipientSecret,
                        signMessage: signMessage ?? undefined,
                    });
                    runningBalance -= useAmount;
                    if (onRecord) {
                        const { createTransactionRecord } = await import('../../lib/transactions');
                        const recordId = onRecord(
                            createTransactionRecord('transfer:external', {
                                signature: result.signature,
                                relayer: true,
                                status: 'confirmed',
                                details: {
                                    mint: parsedMint.toBase58(),
                                    recipient: parsedRecipient.toBase58(),
                                    amount: amountString,
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
                    <input
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        placeholder="0.00"
                    />
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
                <label className={styles.label}>
                    Internal recipient view key
                    <input
                        value={internalRecipientViewKey}
                        onChange={(event) => setInternalRecipientViewKey(event.target.value)}
                        placeholder="recipient view key (x:y hex)"
                    />
                </label>
            </div>
            <div className={styles.checklist}>
                {[
                    { id: 'deposit', label: 'Deposit' },
                    { id: 'withdraw', label: 'Withdraw' },
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
