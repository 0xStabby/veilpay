import { useEffect, useState } from 'react';
import { WalletHeader } from './components/WalletHeader';
import { StatusBanner } from './components/StatusBanner';
import { SetupCard } from './components/SetupCard';
import { RunbookCard } from './components/RunbookCard';
import { UserDepositCard } from './components/UserDepositCard';
import { UserWithdrawCard } from './components/UserWithdrawCard';
import { UserAuthorizationCard } from './components/UserAuthorizationCard';
import { UserTransferCard } from './components/UserTransferCard';
import { usePrograms } from './hooks/usePrograms';
import { useNullifierCounter } from './hooks/useNullifierCounter';
import { useMintInfo } from './hooks/useMintInfo';
import { useTokenBalance } from './hooks/useTokenBalance';
import { useShieldedBalance } from './hooks/useShieldedBalance';
import { randomBytes } from './lib/crypto';
import styles from './App.module.css';

const App = () => {
    const { connection, veilpayProgram, verifierProgram, wallet } = usePrograms();
    const [status, setStatus] = useState('');
    const [mintAddress, setMintAddress] = useState('');
    const [root, setRoot] = useState(() => randomBytes(32));
    const [view, setView] = useState<'user' | 'admin'>('user');
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
                        />
                        <RunbookCard mode="user" />
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
                        />
                    </section>
                )}
            </main>
        </div>
    );
};

export default App;
