import React, { useEffect, useState } from 'react';
import { WalletHeader } from './components/WalletHeader';
import { StatusBanner } from './components/StatusBanner';
import { SetupCard } from './components/SetupCard';
import { RunbookCard } from './components/RunbookCard';
import { UserDepositCard } from './components/UserDepositCard';
import { UserWithdrawCard } from './components/UserWithdrawCard';
import { UserAuthorizationCard } from './components/UserAuthorizationCard';
import { UserTransferCard } from './components/UserTransferCard';
import { FlowTesterCard } from './components/FlowTesterCard';
import { TransactionLogCard } from './components/TransactionLogCard';
import { MultiWalletTesterCard } from './components/MultiWalletTesterCard';
import { usePrograms } from './hooks/usePrograms';
import { useNullifierCounter } from './hooks/useNullifierCounter';
import { useMintInfo } from './hooks/useMintInfo';
import { useTokenBalance } from './hooks/useTokenBalance';
import { useShieldedBalance } from './hooks/useShieldedBalance';
import { randomBytes } from './lib/crypto';
import type { TransactionRecord } from './lib/transactions';
import styles from './App.module.css';

const App: React.FC = () => {
    const { connection, veilpayProgram, verifierProgram, wallet } = usePrograms();
    const [status, setStatus] = useState('');
    const [mintAddress, setMintAddress] = useState('');
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
    const { next } = useNullifierCounter(1);
    const { decimals, loading: mintLoading } = useMintInfo(connection ?? null, mintAddress);
    const walletPubkey = wallet?.publicKey ?? null;
    const { balance: walletBalance } = useTokenBalance(connection ?? null, mintAddress, walletPubkey);
    const { balance: shieldedBalance, credit, debit } = useShieldedBalance(mintAddress, walletPubkey);

    useEffect(() => {
        const stored = localStorage.getItem('veilpay.mint');
        if (stored) {
            setMintAddress(stored);
        }
    }, []);

    useEffect(() => {
        if (mintAddress) {
            localStorage.setItem('veilpay.mint', mintAddress);
        }
    }, [mintAddress]);

    useEffect(() => {
        localStorage.setItem('veilpay.txlog', JSON.stringify(txLog));
    }, [txLog]);

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

    return (
        <div className={styles.app}>
            <div className={styles.background} />
            <main className={styles.content}>
                <WalletHeader />
                <div className={styles.viewToggle}>
                    <button
                        className={view === 'user' ? styles.toggleActive : styles.toggleButton}
                        onClick={() => setView('user')}
                    >
                        User
                    </button>
                    <button
                        className={view === 'admin' ? styles.toggleActive : styles.toggleButton}
                        onClick={() => setView('admin')}
                    >
                        Admin
                    </button>
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
                <StatusBanner status={mintLoading ? 'Loading mint info...' : status} />
                {view === 'admin' ? (
                    <section className={styles.grid}>
                        {connection && (
                            <SetupCard
                                connection={connection}
                                veilpayProgram={veilpayProgram}
                                verifierProgram={verifierProgram}
                                onStatus={setStatus}
                                mintAddress={mintAddress}
                                onMintChange={setMintAddress}
                                mintDecimals={decimals}
                            />
                        )}
                        <RunbookCard
                            mode="admin"
                            connection={connection}
                            veilpayProgram={veilpayProgram}
                            verifierProgram={verifierProgram}
                            mintAddress={mintAddress}
                            onMintChange={setMintAddress}
                            mintDecimals={decimals}
                            onStatus={setStatus}
                        />
                    </section>
                ) : view === 'tx' ? (
                    <section className={styles.grid}>
                        <TransactionLogCard
                            records={txLog}
                            selectedId={selectedTxId}
                            onSelect={setSelectedTxId}
                            onClear={clearLog}
                            walletLabels={multiWalletLabels}
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
                            onStatus={setStatus}
                            onRecord={handleRecord}
                            onRecordUpdate={handleRecordUpdate}
                            onWalletLabels={setMultiWalletLabels}
                        />
                    </section>
                ) : (
                    <section className={styles.grid}>
                        <UserDepositCard
                            veilpayProgram={veilpayProgram}
                            mintAddress={mintAddress}
                            onStatus={setStatus}
                            onRootChange={setRoot}
                            mintDecimals={decimals}
                            walletBalance={walletBalance}
                            onCredit={credit}
                            onRecord={handleRecord}
                            onRecordUpdate={handleRecordUpdate}
                        />
                        <RunbookCard mode="user" />
                        <FlowTesterCard
                            veilpayProgram={veilpayProgram}
                            verifierProgram={verifierProgram}
                            mintAddress={mintAddress}
                            root={root}
                            onRootChange={setRoot}
                            nextNullifier={next}
                            mintDecimals={decimals}
                            walletBalance={walletBalance}
                            shieldedBalance={shieldedBalance}
                            onCredit={credit}
                            onDebit={debit}
                            onStatus={setStatus}
                            onRecord={handleRecord}
                            onRecordUpdate={handleRecordUpdate}
                        />
                        <UserWithdrawCard
                            veilpayProgram={veilpayProgram}
                            verifierProgram={verifierProgram}
                            mintAddress={mintAddress}
                            onStatus={setStatus}
                            root={root}
                            nextNullifier={next}
                            mintDecimals={decimals}
                            shieldedBalance={shieldedBalance}
                            onDebit={debit}
                            onRecord={handleRecord}
                            onRecordUpdate={handleRecordUpdate}
                        />
                        <UserAuthorizationCard
                            veilpayProgram={veilpayProgram}
                            verifierProgram={verifierProgram}
                            mintAddress={mintAddress}
                            onStatus={setStatus}
                            root={root}
                            nextNullifier={next}
                            mintDecimals={decimals}
                            shieldedBalance={shieldedBalance}
                            onDebit={debit}
                            onRecord={handleRecord}
                            onRecordUpdate={handleRecordUpdate}
                        />
                        <UserTransferCard
                            veilpayProgram={veilpayProgram}
                            verifierProgram={verifierProgram}
                            mintAddress={mintAddress}
                            onStatus={setStatus}
                            root={root}
                            nextNullifier={next}
                            onRootChange={setRoot}
                            mintDecimals={decimals}
                            shieldedBalance={shieldedBalance}
                            onDebit={debit}
                            onRecord={handleRecord}
                            onRecordUpdate={handleRecordUpdate}
                        />
                    </section>
                )}
            </main>
        </div>
    );
};

export default App;
