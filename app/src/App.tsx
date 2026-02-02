import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { WalletHeader } from './components/WalletHeader';
import { StatusBanner } from './components/StatusBanner';
import { SetupCard } from './components/SetupCard';
import { RunbookCard } from './components/RunbookCard';
import { TransactionLogCard } from './components/TransactionLogCard';
import { MultiWalletTesterCard } from './components/MultiWalletTesterCard';
import { UserFlowCard } from './components/UserFlowCard';
import { usePrograms } from './hooks/usePrograms';
import { useNullifierCounter } from './hooks/useNullifierCounter';
import { useMintInfo } from './hooks/useMintInfo';
import { useTokenBalance } from './hooks/useTokenBalance';
import { useSolBalance } from './hooks/useSolBalance';
import { useShieldedBalance } from './hooks/useShieldedBalance';
import { randomBytes } from './lib/crypto';
import type { TransactionRecord } from './lib/transactions';
import { buildAddressLabels } from './lib/addressLabels';
import { DEBUG, STATUS_LOG, WSOL_MINT } from './lib/config';
import { rescanNotesForOwner } from './lib/noteScanner';
import { deriveViewKeypair } from './lib/notes';
import styles from './App.module.css';
import { useWallet } from '@solana/wallet-adapter-react';

const App = () => {
    const { connection, veilpayProgram, verifierProgram, wallet } = usePrograms();
    const { signMessage } = useWallet();
    const [statusLines, setStatusLines] = useState<string[]>([]);
    const [mintAddress, setMintAddress] = useState(() => WSOL_MINT.toBase58());
    const [root, setRoot] = useState(() => randomBytes(32));
    const [view, setView] = useState<'user' | 'admin' | 'tx' | 'multi'>('user');
    const [txLog, setTxLog] = useState<TransactionRecord[]>(() => {
        try {
            const stored = localStorage.getItem('veilpay.txlog');
            return stored ? (JSON.parse(stored) as TransactionRecord[]) : [];
        } catch {
            return [];
        }
    });
    const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
    const [multiWalletLabels, setMultiWalletLabels] = useState<Record<string, string>>({});
    const showAdmin = false;
    const showDebug = DEBUG;
    const showStatusLog = STATUS_LOG;
    const { next } = useNullifierCounter(1);
    const { decimals, loading: mintLoading } = useMintInfo(connection ?? null, mintAddress);
    const walletPubkey = wallet?.publicKey ?? null;
    const { balance: walletBalance } = useTokenBalance(connection ?? null, mintAddress, walletPubkey);
    const { balance: solBalance } = useSolBalance(connection ?? null, walletPubkey);
    const { balance: shieldedBalance, credit, debit, setBalance } = useShieldedBalance(mintAddress, walletPubkey);
    const [rescanBusy, setRescanBusy] = useState(false);
    const [rescanProgress, setRescanProgress] = useState<{
        phase: 'scan' | 'decrypt' | 'nullifier' | 'finalize';
        percentTx?: number;
        scannedTxs: number;
    } | null>(null);
    const [viewKeyIndices, setViewKeyIndices] = useState<number[]>([0]);
    const addressLabels = buildAddressLabels({
        mintAddress,
        veilpayProgramId: veilpayProgram?.programId ?? null,
        verifierProgramId: verifierProgram?.programId ?? null,
        walletLabels: multiWalletLabels,
        connectedWallet: walletPubkey?.toBase58(),
    });

    useEffect(() => {
        const stored = localStorage.getItem('veilpay.mint');
        setMintAddress(stored || WSOL_MINT.toBase58());
    }, []);

    useEffect(() => {
        if (!walletPubkey || !signMessage) return;
        deriveViewKeypair({ owner: walletPubkey, signMessage, index: 0 })
            .then(() => {
                handleStatus('Derived view key for note recovery.');
            })
            .catch((error: unknown) => {
                handleStatus(`Failed to derive view key: ${error instanceof Error ? error.message : 'unknown error'}`);
            });
    }, [walletPubkey, signMessage]);

    useEffect(() => {
        if (!showAdmin && view === 'admin') {
            setView('user');
        }
    }, [showAdmin, view]);

    useEffect(() => {
        if (!showDebug && view !== 'user') {
            setView('user');
        }
    }, [showDebug, view]);

    useEffect(() => {
        if (mintAddress) {
            localStorage.setItem('veilpay.mint', mintAddress);
        }
    }, [mintAddress]);

    useEffect(() => {
        localStorage.setItem('veilpay.txlog', JSON.stringify(txLog));
    }, [txLog]);

    useEffect(() => {
        if (mintLoading) {
            setStatusLines((prev) => [...prev, 'Loading mint info...'].slice(-200));
        }
    }, [mintLoading]);

    const handleStatus = (message: string) => {
        if (!message) return;
        setStatusLines((prev) => [...prev, message].slice(-200));
    };

    const handleRecord = (record: TransactionRecord) => {
        setTxLog((prev) => [record, ...prev]);
        setSelectedTxId(record.id);
        return record.id;
    };

    const handleRecordUpdate = (id: string, patch: import('./lib/transactions').TransactionRecordPatch) => {
        setTxLog((prev) =>
            prev.map((record) => {
                if (record.id !== id) return record;
                const mergedDetails = patch.details
                    ? { ...record.details, ...patch.details }
                    : record.details;
                return { ...record, ...patch, details: mergedDetails };
            })
        );
    };

    const clearLog = () => {
        setTxLog([]);
        setSelectedTxId(null);
    };

    const handleRescan = async () => {
        if (!connection || !veilpayProgram || !walletPubkey) {
            handleStatus('Connect a wallet and program before rescanning.');
            return;
        }
        if (!mintAddress) {
            handleStatus('Select a mint before rescanning.');
            return;
        }
        setRescanBusy(true);
        setRescanProgress({ phase: 'scan', scannedTxs: 0 });
        try {
            const mint = new PublicKey(mintAddress);
            const { balance } = await rescanNotesForOwner({
                program: veilpayProgram,
                mint,
                owner: walletPubkey,
                onStatus: handleStatus,
                onProgress: (progress) => {
                    setRescanProgress({
                        phase: progress.phase,
                        percentTx: progress.percentTx,
                        scannedTxs: progress.scannedTxs,
                    });
                },
                signMessage: signMessage ?? undefined,
                viewKeyIndices,
            });
            setBalance(balance);
        } catch (error) {
            handleStatus(`Rescan failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setRescanBusy(false);
            window.setTimeout(() => {
                setRescanProgress(null);
            }, 400);
        }
    };


    return (
        <div className={styles.app}>
            <div className={styles.background} />
            <main className={styles.content}>
                <WalletHeader />
                {showDebug && (
                    <div className={styles.viewToggle}>
                        <button
                            className={view === 'user' ? styles.toggleActive : styles.toggleButton}
                            onClick={() => setView('user')}
                        >
                            User
                        </button>
                        {showAdmin && (
                            <button
                                className={view === 'admin' ? styles.toggleActive : styles.toggleButton}
                                onClick={() => setView('admin')}
                            >
                                Admin
                            </button>
                        )}
                        <button
                            className={view === 'tx' ? styles.toggleActive : styles.toggleButton}
                            onClick={() => setView('tx')}
                        >
                            Tx Logs
                        </button>
                        <button
                            className={view === 'multi' ? styles.toggleActive : styles.toggleButton}
                            onClick={() => setView('multi')}
                        >
                            Multi-Wallet Test
                        </button>
                    </div>
                )}
                {showStatusLog && <StatusBanner lines={statusLines} />}
                {view === 'admin' ? (
                    <section className={styles.grid}>
                        {connection && (
                            <SetupCard
                                connection={connection}
                                veilpayProgram={veilpayProgram}
                                verifierProgram={verifierProgram}
                                onStatus={handleStatus}
                                mintAddress={mintAddress}
                                onMintChange={setMintAddress}
                            />
                        )}
                        <RunbookCard
                            mode="admin"
                            connection={connection}
                            veilpayProgram={veilpayProgram}
                            verifierProgram={verifierProgram}
                            mintAddress={mintAddress}
                            onMintChange={setMintAddress}
                            onStatus={handleStatus}
                        />
                    </section>
                ) : view === 'tx' ? (
                    <section className={styles.grid}>
                        <TransactionLogCard
                            records={txLog}
                            selectedId={selectedTxId}
                            onSelect={setSelectedTxId}
                            onClear={clearLog}
                            addressLabels={addressLabels}
                        />
                    </section>
                ) : view === 'multi' ? (
                    <section className={styles.grid}>
                        <MultiWalletTesterCard
                            connection={connection}
                            mintAddress={mintAddress}
                            mintDecimals={decimals}
                            root={root}
                            onRootChange={setRoot}
                            nextNullifier={next}
                            onStatus={handleStatus}
                            onRecord={handleRecord}
                            onRecordUpdate={handleRecordUpdate}
                            onWalletLabels={setMultiWalletLabels}
                        />
                    </section>
                ) : (
                    <section className={styles.grid}>
                        <UserFlowCard
                            veilpayProgram={veilpayProgram}
                            verifierProgram={verifierProgram}
                            mintAddress={mintAddress}
                            onStatus={handleStatus}
                            onRootChange={setRoot}
                            root={root}
                            nextNullifier={next}
                        mintDecimals={decimals}
                        walletBalance={walletBalance}
                        solBalance={solBalance}
                        shieldedBalance={shieldedBalance}
                            onCredit={credit}
                            onDebit={debit}
                            onRecord={handleRecord}
                            onRecordUpdate={handleRecordUpdate}
                            onRescanNotes={handleRescan}
                            rescanning={rescanBusy}
                            rescanNotesProgress={rescanProgress}
                            viewKeyIndices={viewKeyIndices}
                            onViewKeyIndicesChange={setViewKeyIndices}
                        />
                    </section>
                )}
            </main>
        </div>
    );
};

export default App;
