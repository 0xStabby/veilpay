import { useEffect, useMemo, useRef, useState } from 'react';
import type { FC } from 'react';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import nacl from 'tweetnacl';
import {
    Keypair,
    PublicKey,
    SystemProgram,
    TransactionInstruction,
    VersionedTransaction,
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    createTransferInstruction,
    getAccount,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './MultiWalletTesterCard.module.css';
import veilpayIdl from '../../idl/veilpay.json';
import verifierIdl from '../../idl/verifier.json';
import { formatTokenAmount, parseTokenAmount } from '../../lib/amount';
import { AIRDROP_URL, IS_DEVNET, WSOL_MINT } from '../../lib/config';
import { buildLutVersionedTransaction } from '../../lib/lut';
import { PubkeyBadge } from '../PubkeyBadge';
import { wrapSolToWsol } from '../../lib/adminSetup';
import { runDepositFlow, runExternalTransferFlow, runInternalTransferFlow } from '../../lib/flows';
import { rescanNotesForOwner } from '../../lib/noteScanner';
import { deriveViewKeypair, serializeViewKey } from '../../lib/notes';
import type { TransactionRecord, TransactionRecordPatch } from '../../lib/transactions';
import { createTransactionRecord, fetchTransactionDetails } from '../../lib/transactions';

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
    const [fundAmount, setFundAmount] = useState('0.3');
    const [wrapAmount, setWrapAmount] = useState('1');
    const [solBalance, setSolBalance] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [stepStatus, setStepStatus] = useState<Record<string, 'idle' | 'running' | 'success' | 'error'>>({});
    const rootRef = useRef(root);
    const isLocalMode = import.meta.env.MODE === 'localnet';
    const isDevnetMode = import.meta.env.MODE === 'devnet';
    const isTestMode = isLocalMode || isDevnetMode;
    const hideFundTokens = IS_DEVNET || Boolean(AIRDROP_URL) || isLocalMode;
    const [selected, setSelected] = useState({
        airdropWallets: true,
        deposit: true,
        withdraw: true,
        internal: true,
        external: true,
        wrapSol: true,
        fundWallets: true,
        cleanupWallets: true,
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
            signTransaction: async (tx: Transaction | VersionedTransaction) => {
                if (tx instanceof VersionedTransaction) {
                    tx.sign([keypair]);
                    return tx;
                }
                tx.partialSign(keypair);
                return tx;
            },
            signAllTransactions: async (txs: Array<Transaction | VersionedTransaction>) => {
                return txs.map((tx) => {
                    if (tx instanceof VersionedTransaction) {
                        tx.sign([keypair]);
                        return tx;
                    }
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

    const ensureRecipientSecretFor = async (keypair: Keypair) => {
        await deriveViewKeypair({
            owner: keypair.publicKey,
            signMessage: async (message) => nacl.sign.detached(message, keypair.secretKey),
            index: 0,
        });
    };

    const signMessageFor = (keypair: Keypair) => async (message: Uint8Array) =>
        nacl.sign.detached(message, keypair.secretKey);

    const refreshSolBalance = async () => {
        if (!connection || !publicKey) {
            setSolBalance(null);
            return;
        }
        try {
            const balance = await connection.getBalance(publicKey);
            setSolBalance(balance);
        } catch {
            setSolBalance(null);
        }
    };

    useEffect(() => {
        refreshSolBalance();
    }, [connection, publicKey, busy]);

    const requiredLamports = useMemo(() => {
        const fundLamports = 200_000_000 * 3;
        const wrapSol = selected.wrapSol && parsedMint?.equals(WSOL_MINT);
        const parsedWrap = Number.parseFloat(wrapAmount);
        const wrapLamports =
            wrapSol && Number.isFinite(parsedWrap) ? Math.max(0, Math.floor(parsedWrap * 1e9)) : 0;
        const feeBuffer = 20_000_000;
        return fundLamports + wrapLamports + feeBuffer;
    }, [parsedMint, selected.wrapSol, wrapAmount]);

    const showSolWarning =
        IS_DEVNET && publicKey && solBalance !== null && solBalance < requiredLamports;

    const formatSol = (lamports: number) => (lamports / 1e9).toFixed(3);

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

    const handleAirdropForConnected = async () => {
        if (!connection || !publicKey) return;
        setBusy(true);
        try {
            if (AIRDROP_URL) {
                onStatus('Open the faucet to fund your wallet.');
                window.open(AIRDROP_URL, '_blank', 'noopener,noreferrer');
                return;
            }
            onStatus('Requesting airdrop...');
            const signature = await connection.requestAirdrop(publicKey, 2 * 1e9);
            await connection.confirmTransaction(signature, 'confirmed');
            onStatus('Airdrop complete.');
        } finally {
            setBusy(false);
            await refreshSolBalance();
        }
    };

    const fundGeneratedWalletTokens = async (status: (message: string) => void = onStatus) => {
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
            throw new Error('Provide a mint and connect a wallet before funding tokens.');
        }
        status('Funding tokens to Wallet A/B/C...');
        const adminAta = await getAssociatedTokenAddress(parsedMint, publicKey);
        const ataA = await getAssociatedTokenAddress(parsedMint, walletA.publicKey);
        const ataB = await getAssociatedTokenAddress(parsedMint, walletB.publicKey);
        const ataC = await getAssociatedTokenAddress(parsedMint, walletC.publicKey);

        const instructions = [];
        const ensureAta = async (owner: PublicKey, ata: PublicKey, payer: PublicKey) => {
            try {
                await getAccount(connection, ata);
            } catch {
                instructions.push(createAssociatedTokenAccountInstruction(payer, ata, owner, parsedMint));
            }
        };

        await ensureAta(publicKey, adminAta, publicKey);
        await ensureAta(walletA.publicKey, ataA, publicKey);
        await ensureAta(walletB.publicKey, ataB, publicKey);
        await ensureAta(walletC.publicKey, ataC, publicKey);

        let perWalletUnits = parseTokenAmount(fundAmount, mintDecimals);
        const adminAccount = await getAccount(connection, adminAta);
        const totalNeeded = perWalletUnits * 3n;
        if (adminAccount.amount < totalNeeded) {
            const maxPerWallet = adminAccount.amount / 3n;
            if (maxPerWallet <= 0n) {
                throw new Error('Insufficient token balance to fund generated wallets.');
            }
            if (maxPerWallet < perWalletUnits) {
                status(
                    `Funding amount reduced to ${formatTokenAmount(maxPerWallet, mintDecimals)} per wallet (insufficient balance).`
                );
                perWalletUnits = maxPerWallet;
            }
        }

        instructions.push(createTransferInstruction(adminAta, ataA, publicKey, perWalletUnits, [], TOKEN_PROGRAM_ID));
        instructions.push(createTransferInstruction(adminAta, ataB, publicKey, perWalletUnits, [], TOKEN_PROGRAM_ID));
        instructions.push(createTransferInstruction(adminAta, ataC, publicKey, perWalletUnits, [], TOKEN_PROGRAM_ID));

        const { tx, minContextSlot } = await buildLutVersionedTransaction({
            connection,
            payer: publicKey,
            instructions,
        });
        await sendTransaction(tx, connection, { minContextSlot });
        status('Funded tokens to Wallet A/B/C.');
    };

    const handleFundTokens = async () => {
        setBusy(true);
        try {
            await fundGeneratedWalletTokens();
        } finally {
            setBusy(false);
        }
    };

    const fundGeneratedWallets = async (status: (message: string) => void = onStatus) => {
        if (!connection || !publicKey || !sendTransaction || !walletA || !walletB || !walletC) {
            throw new Error('Connect a wallet and generate test wallets first.');
        }
        status('Funding wallets A/B/C from connected wallet...');
        const lamportsPerWallet = 200_000_000;
        const { tx, minContextSlot } = await buildLutVersionedTransaction({
            connection,
            payer: publicKey,
            instructions: [
                SystemProgram.transfer({
                    fromPubkey: publicKey,
                    toPubkey: walletA.publicKey,
                    lamports: lamportsPerWallet,
                }),
                SystemProgram.transfer({
                    fromPubkey: publicKey,
                    toPubkey: walletB.publicKey,
                    lamports: lamportsPerWallet,
                }),
                SystemProgram.transfer({
                    fromPubkey: publicKey,
                    toPubkey: walletC.publicKey,
                    lamports: lamportsPerWallet,
                }),
            ],
        });
        await sendTransaction(tx, connection, { minContextSlot });
        status('Funded wallets A/B/C.');
        await refreshSolBalance();
        if (parsedMint && mintDecimals !== null) {
            await fundGeneratedWalletTokens(status);
        }
    };

    const wrapSolForFunding = async (status: (message: string) => void = onStatus) => {
        if (!connection || !publicKey || !sendTransaction) {
            throw new Error('Connect a wallet before wrapping SOL.');
        }
        if (!parsedMint?.equals(WSOL_MINT)) {
            status('Wrap step skipped: mint is not WSOL.');
            return;
        }
        const ok = await wrapSolToWsol({
            connection,
            admin: publicKey,
            amount: wrapAmount,
            sendTransaction,
            onStatus: status,
        });
        if (!ok) {
            throw new Error('Wrap SOL failed.');
        }
        await refreshSolBalance();
    };

    const wrapSolForWallet = async (
        keypair: Keypair,
        lamports: number,
        status: (message: string) => void = onStatus
    ) => {
        if (!connection) {
            throw new Error('Missing connection for wrapping SOL.');
        }
        if (!parsedMint?.equals(WSOL_MINT)) {
            status('Wrap step skipped: mint is not WSOL.');
            return;
        }
        if (lamports <= 0) {
            status('Wrap step skipped: amount is zero.');
            return;
        }
        const ata = await getAssociatedTokenAddress(parsedMint, keypair.publicKey);
        const instructions: TransactionInstruction[] = [];
        try {
            await getAccount(connection, ata);
        } catch {
            instructions.push(createAssociatedTokenAccountInstruction(keypair.publicKey, ata, keypair.publicKey, parsedMint));
        }
        instructions.push(
            SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: ata,
                lamports,
            })
        );
        instructions.push(createSyncNativeInstruction(ata));
        const { tx, blockhash, lastValidBlockHeight } = await buildLutVersionedTransaction({
            connection,
            payer: keypair.publicKey,
            instructions,
        });
        tx.sign([keypair]);
        const signature = await connection.sendRawTransaction(tx.serialize());
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    };

    const airdropAndWrapWallets = async (status: (message: string) => void = onStatus) => {
        if (!connection || !walletA || !walletB || !walletC) {
            throw new Error('Generate test wallets before airdropping.');
        }
        status('Airdropping SOL to wallets A/B/C...');
        const lamports = 2 * 1e9;
        const signatures = await Promise.all([
            connection.requestAirdrop(walletA.publicKey, lamports),
            connection.requestAirdrop(walletB.publicKey, lamports),
            connection.requestAirdrop(walletC.publicKey, lamports),
        ]);
        await Promise.all(signatures.map((sig) => connection.confirmTransaction(sig, 'confirmed')));
        status('Airdrop complete. Wrapping SOL to WSOL...');
        const wrapLamports = Math.max(0, Math.floor(Number.parseFloat(wrapAmount) * 1e9));
        if (wrapLamports > 0) {
            await wrapSolForWallet(walletA, wrapLamports, status);
            await wrapSolForWallet(walletB, wrapLamports, status);
            await wrapSolForWallet(walletC, wrapLamports, status);
        }
        status('Airdrop + wrap complete.');
    };

    const waitForWalletAFunding = async (status: (message: string) => void = onStatus) => {
        if (!connection || !walletA) return;
        const maxAttempts = 15;
        const delayMs = 1000;
        status('Waiting for Wallet A funding to land...');
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const solBalance = await connection.getBalance(walletA.publicKey);
            let tokenBalance = 0n;
            if (parsedMint && mintDecimals !== null) {
                const ata = await getAssociatedTokenAddress(parsedMint, walletA.publicKey);
                try {
                    const account = await getAccount(connection, ata);
                    tokenBalance = account.amount;
                } catch {
                    tokenBalance = 0n;
                }
            }
            const hasSol = solBalance > 0;
            const hasTokens = !parsedMint || mintDecimals === null || tokenBalance > 0n;
            if (hasSol && hasTokens) {
                status('Wallet A funded.');
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        throw new Error('Wallet A funding not confirmed yet. Try again in a moment.');
    };

    const cleanupWallet = async (keypair: Keypair) => {
        if (!connection || !publicKey) {
            throw new Error('Connect a wallet before cleanup.');
        }
        const sendWithKeypair = async (instructions: TransactionInstruction[]) => {
            const { tx, blockhash, lastValidBlockHeight } = await buildLutVersionedTransaction({
                connection,
                payer: keypair.publicKey,
                instructions,
            });
            tx.sign([keypair]);
            const signature = await connection.sendRawTransaction(tx.serialize());
            await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        };

        if (parsedMint) {
            const walletAta = await getAssociatedTokenAddress(parsedMint, keypair.publicKey);
            const adminAta = await getAssociatedTokenAddress(parsedMint, publicKey);
            try {
                const walletAccount = await getAccount(connection, walletAta);
                const instructions = [];
                try {
                    await getAccount(connection, adminAta);
                } catch {
                    instructions.push(
                        createAssociatedTokenAccountInstruction(keypair.publicKey, adminAta, publicKey, parsedMint)
                    );
                }
                if (walletAccount.amount > 0n) {
                    instructions.push(
                        createTransferInstruction(walletAta, adminAta, keypair.publicKey, walletAccount.amount, [], TOKEN_PROGRAM_ID)
                    );
                }
                instructions.push(createCloseAccountInstruction(walletAta, publicKey, keypair.publicKey));
                if (instructions.length > 0) {
                    await sendWithKeypair(instructions);
                }
            } catch {
                // No token account to clean up.
            }
        }

        const balance = await connection.getBalance(keypair.publicKey, 'confirmed');
        if (balance > 0) {
            const feeProbe = await buildLutVersionedTransaction({
                connection,
                payer: keypair.publicKey,
                instructions: [
                    SystemProgram.transfer({
                        fromPubkey: keypair.publicKey,
                        toPubkey: publicKey,
                        lamports: 0,
                    }),
                ],
            });
            const fee = await connection.getFeeForMessage(feeProbe.tx.message);
            const feeLamports = fee.value ?? 0;
            const lamports = balance - feeLamports;
            if (lamports > 0) {
                const { tx, blockhash, lastValidBlockHeight } = await buildLutVersionedTransaction({
                    connection,
                    payer: keypair.publicKey,
                    instructions: [
                        SystemProgram.transfer({
                            fromPubkey: keypair.publicKey,
                            toPubkey: publicKey,
                            lamports,
                        }),
                    ],
                });
                tx.sign([keypair]);
                const signature = await connection.sendRawTransaction(tx.serialize());
                await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
            }
        }
    };

    const cleanupGeneratedWallets = async (status: (message: string) => void = onStatus) => {
        if (!connection || !walletA || !walletB || !walletC || !publicKey) {
            throw new Error('Connect a wallet and generate test wallets first.');
        }
        status('Returning tokens + SOL to connected wallet...');
        await cleanupWallet(walletA);
        await cleanupWallet(walletB);
        await cleanupWallet(walletC);
        status('Cleanup complete.');
        await refreshSolBalance();
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
        const stepStatus = (label: string) => (message: string) => onStatus(`[${label}] ${message}`);
        try {
            onStatus('Running multi-wallet flow...');
            if (isLocalMode && !IS_DEVNET && selected.airdropWallets) {
                setStatus('airdrop-wallets', 'running');
                try {
                    const logStep = stepStatus('Airdrop + wrap');
                    await airdropAndWrapWallets(logStep);
                    await waitForWalletAFunding(logStep);
                    setStatus('airdrop-wallets', 'success');
                } catch {
                    setStatus('airdrop-wallets', 'error');
                    throw new Error('Airdrop + wrap failed.');
                }
            }
            if (isDevnetMode && IS_DEVNET && selected.fundWallets) {
                if (selected.wrapSol) {
                    setStatus('wrap-sol', 'running');
                    try {
                        await wrapSolForFunding(stepStatus('Wrap SOL'));
                        setStatus('wrap-sol', 'success');
                    } catch {
                        setStatus('wrap-sol', 'error');
                        throw new Error('Wrap SOL failed.');
                    }
                }
                setStatus('fund-wallets', 'running');
                try {
                    const logStep = stepStatus('Fund wallets');
                    await fundGeneratedWallets(logStep);
                    await waitForWalletAFunding(logStep);
                    setStatus('fund-wallets', 'success');
                } catch {
                    setStatus('fund-wallets', 'error');
                    throw new Error('Funding wallets failed.');
                }
            }
            let baseUnits = parseTokenAmount(amount, mintDecimals);
            if (selected.deposit) {
                const walletAta = await getAssociatedTokenAddress(parsedMint, walletA.publicKey);
                let walletBalance = 0n;
                try {
                    const walletAccount = await getAccount(connection, walletAta);
                    walletBalance = walletAccount.amount;
                } catch {
                    walletBalance = 0n;
                }
                if (walletBalance <= 0n) {
                    throw new Error('Wallet A has no tokens available for the deposit step.');
                }
                if (walletBalance < baseUnits) {
                    onStatus(
                        `Reducing flow amount to ${formatTokenAmount(walletBalance, mintDecimals)} to match Wallet A balance.`
                    );
                    baseUnits = walletBalance;
                }
            }
            const spendSteps = ['withdraw', 'external'].filter(
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
                const depositAsset = parsedMint.equals(WSOL_MINT) ? 'sol' : 'wsol';
                const result = await runDepositFlow({
                    program: programsA.veilpay,
                    mint: parsedMint,
                    amount: amountString,
                    mintDecimals,
                    depositAsset,
                    onStatus: stepStatus('Deposit A'),
                    onRootChange: (next) => {
                        rootRef.current = next;
                        onRootChange(next);
                    },
                    onCredit: () => undefined,
                    signMessage: signMessageFor(walletA),
                    rescanNotes: async () => {
                        await rescanNotesForOwner({
                            program: programsA.veilpay,
                            mint: parsedMint,
                            owner: walletA.publicKey,
                            onStatus: stepStatus('Rescan A'),
                            signMessage: signMessageFor(walletA),
                        });
                    },
                    ensureRecipientSecret: async () => {
                        await ensureRecipientSecretFor(walletA);
                    },
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
                const recipientViewKeyB = serializeViewKey(
                    (
                        await deriveViewKeypair({
                            owner: walletB.publicKey,
                            signMessage: signMessageFor(walletB),
                            index: 0,
                        })
                    ).pubkey
                );
                const result = await runInternalTransferFlow({
                    program: programsA.veilpay,
                    verifierProgram: programsA.verifier,
                    mint: parsedMint,
                    recipientViewKey: recipientViewKeyB,
                    amount: spendAmountString,
                    mintDecimals,
                    root: rootRef.current,
                    nextNullifier,
                    onStatus: stepStatus('Internal A→B'),
                    onRootChange: (next) => {
                        rootRef.current = next;
                        onRootChange(next);
                    },
                    ensureRecipientSecret: async () => {
                        await ensureRecipientSecretFor(walletA);
                    },
                    signMessage: signMessageFor(walletA),
                });
                await recordTx('wallet-a:internal', result.signature, false, {
                    mint: parsedMint.toBase58(),
                    recipient: recipientViewKeyB,
                    wallet: walletA.publicKey.toBase58(),
                });
                setStatus('internal-a-b', 'success');
            }


            if (selected.internal) {
                setStatus('internal-b-c', 'running');
                const recipientViewKeyC = serializeViewKey(
                    (
                        await deriveViewKeypair({
                            owner: walletC.publicKey,
                            signMessage: signMessageFor(walletC),
                            index: 0,
                        })
                    ).pubkey
                );
                const result = await runInternalTransferFlow({
                    program: programsB.veilpay,
                    verifierProgram: programsB.verifier,
                    mint: parsedMint,
                    recipientViewKey: recipientViewKeyC,
                    amount: spendAmountString,
                    mintDecimals,
                    root: rootRef.current,
                    nextNullifier,
                    onStatus: stepStatus('Internal B→C'),
                    onRootChange: (next) => {
                        rootRef.current = next;
                        onRootChange(next);
                    },
                    ensureRecipientSecret: async () => {
                        await ensureRecipientSecretFor(walletB);
                    },
                    signMessage: signMessageFor(walletB),
                });
                await recordTx('wallet-b:internal', result.signature, false, {
                    mint: parsedMint.toBase58(),
                    recipient: recipientViewKeyC,
                    wallet: walletB.publicKey.toBase58(),
                });
                setStatus('internal-b-c', 'success');
            }

            if (selected.withdraw) {
                setStatus('withdraw', 'running');
                const deliverAsset = parsedMint.equals(WSOL_MINT) ? 'sol' : 'wsol';
                const result = await runExternalTransferFlow({
                    program: programsC.veilpay,
                    verifierProgram: programsC.verifier,
                    mint: parsedMint,
                    recipient: walletC.publicKey,
                    amount: spendAmountString,
                    mintDecimals,
                    deliverAsset,
                    root: rootRef.current,
                    nextNullifier,
                    onStatus: stepStatus('Withdraw C'),
                    onDebit: () => undefined,
                    onRootChange: (next) => {
                        rootRef.current = next;
                        onRootChange(next);
                    },
                    ensureRecipientSecret: async () => {
                        await ensureRecipientSecretFor(walletC);
                    },
                    signMessage: signMessageFor(walletC),
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
                    deliverAsset: parsedMint.equals(WSOL_MINT) ? 'sol' : 'wsol',
                    root: rootRef.current,
                    nextNullifier,
                    onStatus: stepStatus('External B→C'),
                    onDebit: () => undefined,
                    onRootChange: (next) => {
                        rootRef.current = next;
                        onRootChange(next);
                    },
                    ensureRecipientSecret: async () => {
                        await ensureRecipientSecretFor(walletB);
                    },
                    signMessage: signMessageFor(walletB),
                });
                await recordTx('wallet-b:external', result.signature, true, {
                    mint: parsedMint.toBase58(),
                    amount: spendAmountString,
                    recipient: target.toBase58(),
                    wallet: walletB.publicKey.toBase58(),
                });
                setStatus('external', 'success');
            }

            if (isTestMode && selected.cleanupWallets) {
                setStatus('cleanup-wallets', 'running');
                try {
                    await cleanupGeneratedWallets(stepStatus('Cleanup'));
                    setStatus('cleanup-wallets', 'success');
                } catch {
                    setStatus('cleanup-wallets', 'error');
                    throw new Error('Cleanup wallets failed.');
                }
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
                {isTestMode && (
                    <label className={styles.label}>
                        Wrap amount (SOL)
                        <input value={wrapAmount} onChange={(event) => setWrapAmount(event.target.value)} />
                    </label>
                )}
            </div>
            {showSolWarning && (
                <div className={styles.warningBanner}>
                    <div>
                        Insufficient SOL for the multi-wallet flow. Need about {formatSol(requiredLamports)} SOL, have{' '}
                        {formatSol(solBalance ?? 0)} SOL.
                    </div>
                    <div className={styles.warningActions}>
                        <button
                            className={styles.button}
                            onClick={handleAirdropForConnected}
                            disabled={busy || !connection || !publicKey}
                        >
                            Airdrop SOL
                        </button>
                    </div>
                </div>
            )}

            <div className={styles.flowList}>
                {[
                    ...(isTestMode
                        ? [
                              ...(IS_DEVNET
                                  ? [
                                        { id: 'wrap-sol', label: 'Wrap SOL for funding', toggle: 'wrapSol' },
                                        { id: 'fund-wallets', label: 'Fund wallets from connected', toggle: 'fundWallets' },
                                    ]
                                  : [{ id: 'airdrop-wallets', label: 'Airdrop + wrap wallets', toggle: 'airdropWallets' }]),
                          ]
                        : []),
                    { id: 'deposit', label: 'Deposit A' },
                    { id: 'internal-a-b', label: 'Internal A→B', toggle: 'internal' },
                    { id: 'internal-b-c', label: 'Internal B→C', toggle: 'internal' },
                    { id: 'withdraw', label: 'Withdraw C' },
                    { id: 'external', label: 'External B→C', toggle: 'external' },
                    ...(isTestMode
                        ? [
                              { id: 'cleanup-wallets', label: 'Return tokens + SOL to connected', toggle: 'cleanupWallets' },
                          ]
                        : []),
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
                {!hideFundTokens && (
                    <button
                        className={styles.button}
                        onClick={handleFundTokens}
                        disabled={!walletA || !walletB || !walletC || busy || !parsedMint || mintDecimals === null}
                    >
                        Fund tokens
                    </button>
                )}
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
        </section>
    );
};
