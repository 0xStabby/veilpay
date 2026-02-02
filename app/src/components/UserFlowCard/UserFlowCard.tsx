import { useEffect, useState, useMemo } from 'react';
import type { FC } from 'react';
import styles from './UserFlowCard.module.css';
import type { Program } from '@coral-xyz/anchor';
import { UserDepositCard } from '../UserDepositCard';
import { UserReceiveCard } from '../UserReceiveCard';
import { UserWithdrawCard } from '../UserWithdrawCard';
import { UserTransferCard } from '../UserTransferCard';
import { deriveIdentityMember } from '../../lib/pda';
import { registerIdentityFlow } from '../../lib/flows';
import { useWallet } from '@solana/wallet-adapter-react';
import { FlowStepsModal } from '../FlowSteps';
import type { FlowStepStatus } from '../../lib/flowSteps';
import { initStepStatus } from '../../lib/flowSteps';

type UserFlowCardProps = {
    veilpayProgram: Program | null;
    verifierProgram: Program | null;
    mintAddress: string;
    onStatus: (message: string) => void;
    onRootChange: (next: Uint8Array) => void;
    root: Uint8Array;
    nextNullifier: () => number;
    mintDecimals: number | null;
    walletBalance: bigint | null;
    solBalance: bigint | null;
    shieldedBalance: bigint;
    onCredit: (amount: bigint) => void;
    onDebit: (amount: bigint) => void;
    onRecord?: (record: import('../../lib/transactions').TransactionRecord) => string;
    onRecordUpdate?: (id: string, patch: import('../../lib/transactions').TransactionRecordPatch) => void;
    onRescanNotes?: () => void;
    rescanning?: boolean;
    onRescanIdentity?: () => void;
    rescanningIdentity?: boolean;
    viewKeyIndices?: number[];
    onViewKeyIndicesChange?: (indices: number[]) => void;
};

type FlowTab = 'deposit' | 'withdraw' | 'transfer' | 'receive';

export const UserFlowCard: FC<UserFlowCardProps> = ({
    veilpayProgram,
    verifierProgram,
    mintAddress,
    onStatus,
    onRootChange,
    root,
    nextNullifier,
    mintDecimals,
    walletBalance,
    solBalance,
    shieldedBalance,
    onCredit,
    onDebit,
    onRecord,
    onRecordUpdate,
    onRescanNotes,
    rescanning = false,
    onRescanIdentity,
    rescanningIdentity = false,
    viewKeyIndices,
    onViewKeyIndicesChange,
}) => {
    const [activeTab, setActiveTab] = useState<FlowTab>('deposit');
    const [registrationState, setRegistrationState] = useState<'loading' | 'registered' | 'unregistered'>(
        'loading'
    );
    const [registerBusy, setRegisterBusy] = useState(false);
    const [registerModalOpen, setRegisterModalOpen] = useState(false);
    const { publicKey, signMessage } = useWallet();
    const registerSteps = useMemo(
        () => [
            { id: 'sync', label: 'Sync identity registry' },
            { id: 'sign', label: 'Sign message to create identity', requiresSignature: true },
            { id: 'submit', label: 'Sign & confirm registration', requiresSignature: true },
        ],
        []
    );
    const [registerStatus, setRegisterStatus] = useState<Record<string, FlowStepStatus>>(() =>
        initStepStatus(registerSteps)
    );

    useEffect(() => {
        let alive = true;
        const checkRegistration = async () => {
            if (!veilpayProgram || !publicKey) {
                if (alive) setRegistrationState('unregistered');
                return;
            }
            setRegistrationState('loading');
            try {
                const identityMember = deriveIdentityMember(veilpayProgram.programId, publicKey);
                const info = await veilpayProgram.provider.connection.getAccountInfo(identityMember);
                if (!alive) return;
                setRegistrationState(info ? 'registered' : 'unregistered');
            } catch {
                if (!alive) return;
                setRegistrationState('unregistered');
            }
        };
        void checkRegistration();
        return () => {
            alive = false;
        };
    }, [veilpayProgram, publicKey]);

    const handleRegister = async () => {
        if (!veilpayProgram || !publicKey) {
            onStatus('Connect a wallet before registering.');
            return;
        }
        if (!signMessage) {
            onStatus('Wallet must support message signing to register.');
            return;
        }
        setRegisterBusy(true);
        setRegisterModalOpen(true);
        setRegisterStatus(initStepStatus(registerSteps));
        try {
            await registerIdentityFlow({
                program: veilpayProgram,
                owner: publicKey,
                onStatus,
                signMessage,
                onStep: (stepId, status) => setRegisterStatus((prev) => ({ ...prev, [stepId]: status })),
            });
            setRegistrationState('registered');
            onStatus('Registration complete.');
        } catch (error) {
            onStatus(`Registration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setRegisterBusy(false);
            setRegisterModalOpen(false);
        }
    };

    if (registrationState !== 'registered') {
        return (
            <section className={styles.card}>
                <header className={styles.headerSimple}>
                    <h3 className={styles.title}>Register</h3>
                    <p className={styles.subtitle}>Create your identity before using VeilPay flows.</p>
                </header>
                <FlowStepsModal
                    open={registerModalOpen}
                    title="Registration in progress"
                    steps={registerSteps}
                    status={registerStatus}
                    allowClose={!registerBusy}
                    onClose={() => setRegisterModalOpen(false)}
                />
                <button
                    className={styles.registerButton}
                    type="button"
                    onClick={handleRegister}
                    disabled={registerBusy || registrationState === 'loading' || !publicKey}
                >
                    {registerBusy ? 'Registering...' : registrationState === 'loading' ? 'Checking...' : 'Register'}
                </button>
            </section>
        );
    }

    return (
        <section className={styles.card}>
            <header className={styles.header}>
                <div className={styles.tabs}>
                    {[
                        { id: 'deposit', label: 'Deposit' },
                        { id: 'receive', label: 'Receive' },
                        { id: 'transfer', label: 'Transfers' },
                        { id: 'withdraw', label: 'Withdraw' },
                    ].map((tab) => (
                        <button
                            key={tab.id}
                            className={activeTab === tab.id ? styles.tabActive : styles.tab}
                            onClick={() => setActiveTab(tab.id as FlowTab)}
                            type="button"
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
                {(onRescanNotes || onRescanIdentity) && (
                    <div className={styles.actions}>
                        {onRescanNotes && (
                            <button
                                className={styles.actionButton}
                                onClick={onRescanNotes}
                                type="button"
                                disabled={rescanning}
                            >
                                {rescanning ? (
                                    <span className={styles.actionLabel}>
                                        Rescanning
                                        <span className={styles.loadingDots} aria-hidden />
                                    </span>
                                ) : (
                                    'Rescan notes'
                                )}
                            </button>
                        )}
                        {onRescanIdentity && (
                            <button
                                className={styles.actionButton}
                                onClick={onRescanIdentity}
                                type="button"
                                disabled={rescanningIdentity}
                            >
                                {rescanningIdentity ? (
                                    <span className={styles.actionLabel}>
                                        Rescanning
                                        <span className={styles.loadingDots} aria-hidden />
                                    </span>
                                ) : (
                                    'Rescan identity'
                                )}
                            </button>
                        )}
                    </div>
                )}
            </header>

            <div className={styles.content}>
                {activeTab === 'deposit' && (
                    <UserDepositCard
                        embedded
                        veilpayProgram={veilpayProgram}
                        mintAddress={mintAddress}
                        onStatus={onStatus}
                        onRootChange={onRootChange}
                        mintDecimals={mintDecimals}
                        walletBalance={walletBalance}
                        solBalance={solBalance}
                        onCredit={onCredit}
                        onRecord={onRecord}
                        onRecordUpdate={onRecordUpdate}
                    />
                )}
                {activeTab === 'receive' && (
                    <UserReceiveCard
                        embedded
                        onStatus={onStatus}
                        viewKeyIndices={viewKeyIndices}
                        onViewKeyIndicesChange={onViewKeyIndicesChange}
                    />
                )}
                {activeTab === 'withdraw' && (
                    <UserWithdrawCard
                        embedded
                        veilpayProgram={veilpayProgram}
                        verifierProgram={verifierProgram}
                        mintAddress={mintAddress}
                        onStatus={onStatus}
                        root={root}
                        nextNullifier={nextNullifier}
                        mintDecimals={mintDecimals}
                        shieldedBalance={shieldedBalance}
                        onDebit={onDebit}
                        onRootChange={onRootChange}
                        onRecord={onRecord}
                        onRecordUpdate={onRecordUpdate}
                    />
                )}
                {activeTab === 'transfer' && (
                    <UserTransferCard
                        embedded
                        veilpayProgram={veilpayProgram}
                        verifierProgram={verifierProgram}
                        mintAddress={mintAddress}
                        onStatus={onStatus}
                        root={root}
                        nextNullifier={nextNullifier}
                        onRootChange={onRootChange}
                        mintDecimals={mintDecimals}
                        shieldedBalance={shieldedBalance}
                        onDebit={onDebit}
                        onRecord={onRecord}
                        onRecordUpdate={onRecordUpdate}
                    />
                )}
            </div>
        </section>
    );
};
