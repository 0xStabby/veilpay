import React, { FC, useEffect, useMemo, useState } from 'react';
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
import { runDepositFlow, runExternalTransferFlow, runInternalTransferFlow, runWithdrawFlow } from '../lib/flows';
import type { TransactionRecord, TransactionRecordPatch } from '../lib/transactions';
import { createTransactionRecord, fetchTransactionDetails } from '../lib/transactions';

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
}) => {
    const { publicKey, sendTransaction } = useWallet();
    const [walletA, setWalletA] = useState<Keypair | null>(null);
    const [walletB, setWalletB] = useState<Keypair | null>(null);
    const [walletC, setWalletC] = useState<Keypair | null>(null);
    const [amount, setAmount] = useState('1');
    const [fundAmount, setFundAmount] = useState('10');
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState({
        deposit: true,
        withdraw: true,
        internal: true,
        external: true,
    });

    useEffect(() => {
        const restoredA = loadKeypair('veilpay.walletA');
        const restoredB = loadKeypair('veilpay.walletB');
        const restoredC = loadKeypair('veilpay.walletC');
        if (restoredA) setWalletA(restoredA);
        if (restoredB) setWalletB(restoredB);
        if (restoredC) setWalletC(restoredC);
    }, []);

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
        onStatus('Generated Wallet A, B, and C.');
    };

    const handleReset = () => {
        setWalletA(null);
        setWalletB(null);
        setWalletC(null);
        localStorage.removeItem('veilpay.walletA');
        localStorage.removeItem('veilpay.walletB');
        localStorage.removeItem('veilpay.walletC');
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
            const amountString = formatTokenAmount(baseUnits, mintDecimals);

            if (selected.deposit) {
                const result = await runDepositFlow({
                    program: programsA.veilpay,
                    mint: parsedMint,
                    amount: amountString,
                    mintDecimals,
                    onStatus,
                    onRootChange,
                    onCredit: () => undefined,
                });
                await recordTx('wallet-a:deposit', result.signature, false, {
                    mint: parsedMint.toBase58(),
                    amount: amountString,
                    wallet: walletA.publicKey.toBase58(),
                });
            }

            if (selected.internal) {
                const result = await runInternalTransferFlow({
                    program: programsA.veilpay,
                    verifierProgram: programsA.verifier,
                    mint: parsedMint,
                    recipient: walletB.publicKey,
                    root,
                    nextNullifier,
                    onStatus,
                    onRootChange,
                });
                await recordTx('wallet-a:internal', result.signature, false, {
                    mint: parsedMint.toBase58(),
                    recipient: walletB.publicKey.toBase58(),
                    wallet: walletA.publicKey.toBase58(),
                });
            }

            if (selected.internal) {
                const result = await runInternalTransferFlow({
                    program: programsB.veilpay,
                    verifierProgram: programsB.verifier,
                    mint: parsedMint,
                    recipient: walletC.publicKey,
                    root,
                    nextNullifier,
                    onStatus,
                    onRootChange,
                });
                await recordTx('wallet-b:internal', result.signature, false, {
                    mint: parsedMint.toBase58(),
                    recipient: walletC.publicKey.toBase58(),
                    wallet: walletB.publicKey.toBase58(),
                });
            }

            if (selected.withdraw) {
                const result = await runWithdrawFlow({
                    program: programsC.veilpay,
                    verifierProgram: programsC.verifier,
                    mint: parsedMint,
                    recipient: walletC.publicKey,
                    amount: amountString,
                    mintDecimals,
                    root,
                    nextNullifier,
                    onStatus,
                    onDebit: () => undefined,
                });
                await recordTx('wallet-c:withdraw', result.signature, true, {
                    mint: parsedMint.toBase58(),
                    amount: amountString,
                    recipient: walletC.publicKey.toBase58(),
                    wallet: walletC.publicKey.toBase58(),
                });
            }

            if (selected.external) {
                const target = walletC?.publicKey ?? walletA.publicKey;
                const result = await runExternalTransferFlow({
                    program: programsB.veilpay,
                    verifierProgram: programsB.verifier,
                    mint: parsedMint,
                    recipient: target,
                    amount: amountString,
                    mintDecimals,
                    root,
                    nextNullifier,
                    onStatus,
                    onDebit: () => undefined,
                });
                await recordTx('wallet-b:external', result.signature, true, {
                    mint: parsedMint.toBase58(),
                    amount: amountString,
                    recipient: target.toBase58(),
                    wallet: walletB.publicKey.toBase58(),
                });
            }

            onStatus('Completed multi-wallet flow.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={styles.card}>
            <header>
                <h2>Multi-Wallet Flow Tester</h2>
                <p>Deposit A → transfer A→B → transfer B→C → withdraw by Wallet C.</p>
            </header>
            <div className={styles.walletRow}>
                <div>
                    <span>Wallet A</span>
                    {walletA ? <PubkeyBadge value={walletA.publicKey.toBase58()} /> : <em>not generated</em>}
                </div>
                <div>
                    <span>Wallet B</span>
                    {walletB ? <PubkeyBadge value={walletB.publicKey.toBase58()} /> : <em>not generated</em>}
                </div>
                <div>
                    <span>Wallet C</span>
                    {walletC ? <PubkeyBadge value={walletC.publicKey.toBase58()} /> : <em>not generated</em>}
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

            <div className={styles.checklist}>
                {[
                    { id: 'deposit', label: 'Deposit' },
                    { id: 'withdraw', label: 'Withdraw' },
                    { id: 'internal', label: 'Internal transfer' },
                    { id: 'external', label: 'External transfer' },
                ].map((item) => (
                    <label key={item.id} className={styles.checkRow}>
                        <input
                            type="checkbox"
                            checked={selected[item.id as keyof typeof selected]}
                            onChange={(event) =>
                                setSelected((prev) => ({ ...prev, [item.id]: event.target.checked }))
                            }
                            disabled={busy}
                        />
                        <span>{item.label}</span>
                    </label>
                ))}
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
                Note: Authorization flows require wallet message signing, so they remain in the main Flow Tester.
            </p>
        </section>
    );
};
