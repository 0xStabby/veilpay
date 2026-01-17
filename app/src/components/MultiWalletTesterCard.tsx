import React, { FC, useEffect, useMemo, useRef, useState } from 'react';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createTransferInstruction,
    getAccount,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './MultiWalletTesterCard.module.css';
import veilpayIdl from '../idl/veilpay.json';
import verifierIdl from '../idl/verifier.json';
import { formatTokenAmount, parseTokenAmount } from '../lib/amount';
import { PubkeyBadge } from './PubkeyBadge';
import {
    runCreateAuthorizationFlow,
    runDepositFlow,
    runExternalTransferFlow,
    runInternalTransferFlow,
    runSettleAuthorizationFlow,
    runWithdrawFlow,
} from '../lib/flows';
import type { TransactionRecord, TransactionRecordPatch } from '../lib/transactions';
import { createTransactionRecord, fetchTransactionDetails } from '../lib/transactions';
import nacl from 'tweetnacl';

type MultiWalletTesterCardProps = {
    connection: import('@solana/web3.js').Connection | null;
    mintAddress: string;
    mintDecimals: number | null;
    root: Uint8Array;
    onRootChange: (next: Uint8Array) => void;
    nextNullifier: () => number;
    onStatus: (message: string) => void;
    onRecord: (record: TransactionRecord) => string;
    onRecordUpdate: (id: string, patch: TransactionRecordPatch) => void;
    onWalletLabels: (labels: Record<string, string>) => void;
};

const normalizeIdl = (idl: any) => {
    if (!idl || !Array.isArray(idl.accounts) || !Array.isArray(idl.types)) {
        return idl;
    }
    const typeMap = new Map<string, any>(idl.types.map((entry: any) => [entry.name, entry.type]));
    const accounts = idl.accounts
        .map((account: any) => {
            if (account.type) return account;
            const type = typeMap.get(account.name);
            return type ? { ...account, type } : null;
        })
        .filter(Boolean);
    return { ...idl, accounts };
};

function loadKeypair(storageKey: string): Keypair | null {
    try {
        const stored = localStorage.getItem(storageKey);
        if (!stored) return null;
        const bytes = Uint8Array.from(JSON.parse(stored));
        return Keypair.fromSecretKey(bytes);
    } catch {
        return null;
    }
}

function saveKeypair(storageKey: string, keypair: Keypair) {
    localStorage.setItem(storageKey, JSON.stringify(Array.from(keypair.secretKey)));
}

export const MultiWalletTesterCard: FC<MultiWalletTesterCardProps> = ({
    connection,
    mintAddress,
    mintDecimals,
    root,
    onRootChange,
    nextNullifier,
    onStatus,
    onRecord,
    onRecordUpdate,
    onWalletLabels,
}) => {
    const { publicKey, sendTransaction } = useWallet();
    const [walletA, setWalletA] = useState<Keypair | null>(null);
    const [walletB, setWalletB] = useState<Keypair | null>(null);
    const [walletC, setWalletC] = useState<Keypair | null>(null);
    const [amount, setAmount] = useState('1');
    const [fundAmount, setFundAmount] = useState('10');
    const [busy, setBusy] = useState(false);
    const [stepStatus, setStepStatus] = useState<Record<string, 'idle' | 'running' | 'success' | 'error'>>({});
    const rootRef = useRef(root);
    const [selected, setSelected] = useState({
        deposit: true,
        withdraw: true,
        internal: true,
        external: true,
        authorization: true,
    });

    useEffect(() => {
        const restoredA = loadKeypair('veilpay.walletA');
        const restoredB = loadKeypair('veilpay.walletB');
        const restoredC = loadKeypair('veilpay.walletC');
        if (restoredA) setWalletA(restoredA);
        if (restoredB) setWalletB(restoredB);
        if (restoredC) setWalletC(restoredC);
        if (restoredA || restoredB || restoredC) {
            const labels: Record<string, string> = {};
            if (restoredA) labels[restoredA.publicKey.toBase58()] = 'Wallet A';
            if (restoredB) labels[restoredB.publicKey.toBase58()] = 'Wallet B';
            if (restoredC) labels[restoredC.publicKey.toBase58()] = 'Wallet C';
            onWalletLabels(labels);
        }
    }, []);

    useEffect(() => {
        rootRef.current = root;
    }, [root]);

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);

    const buildProvider = (keypair: Keypair) => {
        if (!connection) return null;
        const wallet = {
            publicKey: keypair.publicKey,
            signTransaction: async (tx: Transaction) => {
                tx.partialSign(keypair);
                return tx;
            },
            signAllTransactions: async (txs: Transaction[]) => {
                return txs.map((tx) => {
                    tx.partialSign(keypair);
                    return tx;
                });
            },
        };
        return new AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
    };

    const buildPrograms = (keypair: Keypair) => {
        const provider = buildProvider(keypair);
        if (!provider) return null;
        return {
            veilpay: new Program(normalizeIdl(veilpayIdl) as any, provider),
            verifier: new Program(normalizeIdl(verifierIdl) as any, provider),
        };
    };

    const handleGenerate = () => {
        const kpA = Keypair.generate();
        const kpB = Keypair.generate();
        const kpC = Keypair.generate();
        setWalletA(kpA);
        setWalletB(kpB);
        setWalletC(kpC);
        saveKeypair('veilpay.walletA', kpA);
        saveKeypair('veilpay.walletB', kpB);
        saveKeypair('veilpay.walletC', kpC);
        onWalletLabels({
            [kpA.publicKey.toBase58()]: 'Wallet A',
            [kpB.publicKey.toBase58()]: 'Wallet B',
            [kpC.publicKey.toBase58()]: 'Wallet C',
        });
        onStatus('Generated Wallet A, B, and C.');
    };

    const handleReset = () => {
        setWalletA(null);
        setWalletB(null);
        setWalletC(null);
        localStorage.removeItem('veilpay.walletA');
        localStorage.removeItem('veilpay.walletB');
        localStorage.removeItem('veilpay.walletC');
        onWalletLabels({});
    };

    const handleAirdrop = async () => {
        if (!connection || !walletA || !walletB || !walletC) return;
        setBusy(true);
        try {
            onStatus('Airdropping SOL to Wallet A/B/C...');
            const sigA = await connection.requestAirdrop(walletA.publicKey, 1e9);
            const sigB = await connection.requestAirdrop(walletB.publicKey, 1e9);
            const sigC = await connection.requestAirdrop(walletC.publicKey, 1e9);
            await connection.confirmTransaction(sigA, 'confirmed');
            await connection.confirmTransaction(sigB, 'confirmed');
            await connection.confirmTransaction(sigC, 'confirmed');
            onStatus('Airdrop complete for all wallets.');
        } finally {
            setBusy(false);
        }
    };

    const handleFundTokens = async () => {
        if (
            !connection ||
            !publicKey ||
            !sendTransaction ||
            !parsedMint ||
            !walletA ||
            !walletB ||
            !walletC ||
            mintDecimals === null
        ) {
            return;
        }
        setBusy(true);
        try {
            onStatus('Funding tokens to Wallet A/B/C...');
            const adminAta = await getAssociatedTokenAddress(parsedMint, publicKey);
            const ataA = await getAssociatedTokenAddress(parsedMint, walletA.publicKey);
            const ataB = await getAssociatedTokenAddress(parsedMint, walletB.publicKey);
            const ataC = await getAssociatedTokenAddress(parsedMint, walletC.publicKey);

            const instructions = [];
            const ensureAta = async (owner: PublicKey, ata: PublicKey) => {
                try {
                    await getAccount(connection, ata);
                } catch {
                    instructions.push(createAssociatedTokenAccountInstruction(publicKey, ata, owner, parsedMint));
                }
            };

            await ensureAta(publicKey, adminAta);
            await ensureAta(walletA.publicKey, ataA);
            await ensureAta(walletB.publicKey, ataB);
            await ensureAta(walletC.publicKey, ataC);

            const baseUnits = parseTokenAmount(fundAmount, mintDecimals);
            instructions.push(createTransferInstruction(adminAta, ataA, publicKey, baseUnits, [], TOKEN_PROGRAM_ID));
            instructions.push(createTransferInstruction(adminAta, ataB, publicKey, baseUnits, [], TOKEN_PROGRAM_ID));
            instructions.push(createTransferInstruction(adminAta, ataC, publicKey, baseUnits, [], TOKEN_PROGRAM_ID));

            await sendTransaction(new Transaction().add(...instructions), connection);
            onStatus('Funded tokens to Wallet A/B/C.');
        } finally {
            setBusy(false);
        }
    };

    const recordTx = async (label: string, signature: string, relayer: boolean, details: Record<string, unknown>) => {
        const id = onRecord(
            createTransactionRecord(label, {
                signature,
                relayer,
                status: 'confirmed',
                details,
            })
        );
        if (connection) {
            const txDetails = await fetchTransactionDetails(connection, signature);
            if (txDetails) {
                onRecordUpdate(id, { details: { tx: txDetails } });
            }
        }
    };

    const setStatus = (id: string, status: 'idle' | 'running' | 'success' | 'error') => {
        setStepStatus((prev) => ({ ...prev, [id]: status }));
    };

    const runMultiWalletFlow = async () => {
        if (!connection || mintDecimals === null || !parsedMint) return;
        if (!walletA || !walletB || !walletC) return;
        const programsA = buildPrograms(walletA);
        const programsB = buildPrograms(walletB);
        const programsC = buildPrograms(walletC);
        if (!programsA || !programsB || !programsC) return;
        setBusy(true);
        try {
            onStatus('Running multi-wallet flow...');
            const baseUnits = parseTokenAmount(amount, mintDecimals);
            const spendSteps = ['withdraw', 'external', 'authorization'].filter(
                (key) => selected[key as keyof typeof selected]
            ).length;
            const perSpendRaw = spendSteps > 0 ? baseUnits / BigInt(spendSteps) : baseUnits;
            const perSpend = perSpendRaw > 0n ? perSpendRaw : baseUnits;
            const amountString = formatTokenAmount(baseUnits, mintDecimals);
            const spendAmountString = formatTokenAmount(perSpend > 0n ? perSpend : baseUnits, mintDecimals);
            if (perSpendRaw === 0n && spendSteps > 0) {
                onStatus('Flow amount is too small to split; using full amount for each spend.');
            }

            if (selected.deposit) {
                setStatus('deposit', 'running');
                const result = await runDepositFlow({
                    program: programsA.veilpay,
                    mint: parsedMint,
                    amount: amountString,
                    mintDecimals,
                    onStatus,
                    onRootChange: (next) => {
                        rootRef.current = next;
                        onRootChange(next);
                    },
                    onCredit: () => undefined,
                });
                await recordTx('wallet-a:deposit', result.signature, false, {
                    mint: parsedMint.toBase58(),
                    amount: amountString,
                    wallet: walletA.publicKey.toBase58(),
                });
                setStatus('deposit', 'success');
            }

            if (selected.internal) {
                setStatus('internal-a-b', 'running');
                const result = await runInternalTransferFlow({
                    program: programsA.veilpay,
                    verifierProgram: programsA.verifier,
                    mint: parsedMint,
                    recipient: walletB.publicKey,
                    root: rootRef.current,
                    nextNullifier,
                    onStatus,
                    onRootChange: (next) => {
                        rootRef.current = next;
                        onRootChange(next);
                    },
                });
                await recordTx('wallet-a:internal', result.signature, false, {
                    mint: parsedMint.toBase58(),
                    recipient: walletB.publicKey.toBase58(),
                    wallet: walletA.publicKey.toBase58(),
                });
                setStatus('internal-a-b', 'success');
            }

            if (selected.authorization) {
                setStatus('authorization', 'running');
                const createResult = await runCreateAuthorizationFlow({
                    program: programsA.veilpay,
                    mint: parsedMint,
                    payer: walletA.publicKey,
                    signMessage: async (message: Uint8Array) =>
                        nacl.sign.detached(message, walletA.secretKey),
                    payee: walletB.publicKey,
                    amount: spendAmountString,
                    expirySlots: '200',
                    onStatus,
                });
                await recordTx('wallet-a:auth-create', createResult.signature, false, {
                    mint: parsedMint.toBase58(),
                    payee: walletB.publicKey.toBase58(),
                    amount: spendAmountString,
                    wallet: walletA.publicKey.toBase58(),
                });
                const settleResult = await runSettleAuthorizationFlow({
                    program: programsB.veilpay,
                    verifierProgram: programsB.verifier,
                    mint: parsedMint,
                    payee: walletB.publicKey,
                    amount: spendAmountString,
                    mintDecimals,
                    root,
                    nextNullifier,
                    intentHash: createResult.intentHash,
                    onStatus,
                    onDebit: () => undefined,
                });
                await recordTx('wallet-b:auth-settle', settleResult.signature, true, {
                    mint: parsedMint.toBase58(),
                    payee: walletB.publicKey.toBase58(),
                    amount: spendAmountString,
                    wallet: walletB.publicKey.toBase58(),
                });
                setStatus('authorization', 'success');
            }

            if (selected.internal) {
                setStatus('internal-b-c', 'running');
                const result = await runInternalTransferFlow({
                    program: programsB.veilpay,
                    verifierProgram: programsB.verifier,
                    mint: parsedMint,
                    recipient: walletC.publicKey,
                    root: rootRef.current,
                    nextNullifier,
                    onStatus,
                    onRootChange: (next) => {
                        rootRef.current = next;
                        onRootChange(next);
                    },
                });
                await recordTx('wallet-b:internal', result.signature, false, {
                    mint: parsedMint.toBase58(),
                    recipient: walletC.publicKey.toBase58(),
                    wallet: walletB.publicKey.toBase58(),
                });
                setStatus('internal-b-c', 'success');
            }

            if (selected.withdraw) {
                setStatus('withdraw', 'running');
                const result = await runWithdrawFlow({
                    program: programsC.veilpay,
                    verifierProgram: programsC.verifier,
                    mint: parsedMint,
                    recipient: walletC.publicKey,
                    amount: spendAmountString,
                    mintDecimals,
                    root: rootRef.current,
                    nextNullifier,
                    onStatus,
                    onDebit: () => undefined,
                });
                await recordTx('wallet-c:withdraw', result.signature, true, {
                    mint: parsedMint.toBase58(),
                    amount: spendAmountString,
                    recipient: walletC.publicKey.toBase58(),
                    wallet: walletC.publicKey.toBase58(),
                });
                setStatus('withdraw', 'success');
            }

            if (selected.external) {
                setStatus('external', 'running');
                const target = walletC?.publicKey ?? walletA.publicKey;
                const result = await runExternalTransferFlow({
                    program: programsB.veilpay,
                    verifierProgram: programsB.verifier,
                    mint: parsedMint,
                    recipient: target,
                    amount: spendAmountString,
                    mintDecimals,
                    root: rootRef.current,
                    nextNullifier,
                    onStatus,
                    onDebit: () => undefined,
                });
                await recordTx('wallet-b:external', result.signature, true, {
                    mint: parsedMint.toBase58(),
                    amount: spendAmountString,
                    recipient: target.toBase58(),
                    wallet: walletB.publicKey.toBase58(),
                });
                setStatus('external', 'success');
            }

            onStatus('Completed multi-wallet flow.');
        } catch (error) {
            onStatus(`Multi-wallet flow failed: ${error instanceof Error ? error.message : 'unknown error'}`);
            setStepStatus((prev) =>
                Object.fromEntries(Object.entries(prev).map(([key, value]) => [key, value === 'running' ? 'error' : value]))
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={styles.card}>
            <header>
                <h2>Multi-Wallet Flow Tester</h2>
                <p>Run flows with three local wallets to verify unlinkability.</p>
            </header>
            <div className={styles.walletRow}>
                <div>
                    <span>Wallet A</span>
                    {walletA ? <PubkeyBadge value={walletA.publicKey.toBase58()} hoverLabel="Wallet A" /> : <em>not generated</em>}
                </div>
                <div>
                    <span>Wallet B</span>
                    {walletB ? <PubkeyBadge value={walletB.publicKey.toBase58()} hoverLabel="Wallet B" /> : <em>not generated</em>}
                </div>
                <div>
                    <span>Wallet C</span>
                    {walletC ? <PubkeyBadge value={walletC.publicKey.toBase58()} hoverLabel="Wallet C" /> : <em>not generated</em>}
                </div>
                <div className={styles.walletActions}>
                    <button className={styles.button} onClick={handleGenerate} disabled={busy}>
                        Generate wallets
                    </button>
                    <button className={styles.buttonGhost} onClick={handleReset} disabled={busy}>
                        Reset
                    </button>
                </div>
            </div>

            <div className={styles.controls}>
                <label className={styles.label}>
                    Flow amount (tokens)
                    <input value={amount} onChange={(event) => setAmount(event.target.value)} />
                </label>
                <label className={styles.label}>
                    Fund amount (tokens)
                    <input value={fundAmount} onChange={(event) => setFundAmount(event.target.value)} />
                </label>
            </div>

            <div className={styles.flowList}>
                {[
                    { id: 'deposit', label: 'Deposit A' },
                    { id: 'internal-a-b', label: 'Internal A→B', toggle: 'internal' },
                    { id: 'authorization', label: 'Auth A→B', toggle: 'authorization' },
                    { id: 'internal-b-c', label: 'Internal B→C', toggle: 'internal' },
                    { id: 'withdraw', label: 'Withdraw C' },
                    { id: 'external', label: 'External B→C', toggle: 'external' },
                ].map((step) => {
                    const toggleKey = step.toggle as keyof typeof selected | undefined;
                    const isChecked = toggleKey ? selected[toggleKey] : selected[step.id as keyof typeof selected] ?? true;
                    return (
                        <label key={step.id} className={styles.flowRow} data-status={stepStatus[step.id] ?? 'idle'}>
                            <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(event) => {
                                    if (!toggleKey) {
                                        setSelected((prev) => ({ ...prev, [step.id]: event.target.checked }));
                                        return;
                                    }
                                    setSelected((prev) => ({ ...prev, [toggleKey]: event.target.checked }));
                                }}
                                disabled={busy}
                            />
                            <span>{step.label}</span>
                            <span className={styles.flowStatus}>{stepStatus[step.id] ?? 'idle'}</span>
                        </label>
                    );
                })}
            </div>

            <div className={styles.actionRow}>
                <button
                    className={styles.button}
                    onClick={handleAirdrop}
                    disabled={!walletA || !walletB || !walletC || busy || !connection}
                >
                    Airdrop SOL
                </button>
                <button
                    className={styles.button}
                    onClick={handleFundTokens}
                    disabled={!walletA || !walletB || !walletC || busy || !parsedMint || mintDecimals === null}
                >
                    Fund tokens
                </button>
            </div>

            <div className={styles.actionRow}>
                <button
                    className={styles.button}
                    onClick={runMultiWalletFlow}
                    disabled={!walletA || !walletB || busy || !parsedMint || mintDecimals === null}
                >
                    Run multi-wallet flow
                </button>
            </div>
            <p className={styles.note}>
                Uses local wallets for signing, so authorization flows are supported here as well.
            </p>
        </section>
    );
};
