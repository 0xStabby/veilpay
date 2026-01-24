import { useState } from 'react';
import type { FC } from 'react';
import styles from './UserFlowCard.module.css';
import type { Program } from '@coral-xyz/anchor';
import { UserDepositCard } from '../UserDepositCard';
import { UserReceiveCard } from '../UserReceiveCard';
import { UserWithdrawCard } from '../UserWithdrawCard';
import { UserTransferCard } from '../UserTransferCard';

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
                                {rescanning ? 'Rescanning...' : 'Rescan notes'}
                            </button>
                        )}
                        {onRescanIdentity && (
                            <button
                                className={styles.actionButton}
                                onClick={onRescanIdentity}
                                type="button"
                                disabled={rescanningIdentity}
                            >
                                {rescanningIdentity ? 'Rescanning...' : 'Rescan identity'}
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
