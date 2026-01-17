import React, { FC } from 'react';
import styles from './RunbookCard.module.css';
import { useAdminChecklist } from '../hooks/useAdminChecklist';
import { Program } from '@coral-xyz/anchor';
import { Connection } from '@solana/web3.js';

type RunbookCardProps = {
    mode: 'admin' | 'user';
    connection?: Connection | null;
    veilpayProgram?: Program | null;
    verifierProgram?: Program | null;
    mintAddress?: string;
};

export const RunbookCard: FC<RunbookCardProps> = ({
    mode,
    connection = null,
    veilpayProgram = null,
    verifierProgram = null,
    mintAddress = '',
}) => {
    if (mode === 'user') {
        return (
            <section className={styles.card}>
                <header>
                    <h2>User Guide</h2>
                    <p>Quick steps for everyday payments.</p>
                </header>
                <div className={styles.section}>
                    <ul className={styles.list}>
                        <li>Deposit: enter amount, confirm.</li>
                        <li>Withdraw: enter amount + recipient wallet.</li>
                        <li>Authorization: set payee + amount, create and settle.</li>
                        <li>Internal transfer: send privately to another VeilPay user.</li>
                        <li>External transfer: send to any wallet.</li>
                    </ul>
                </div>
                <div className={styles.note}>
                    <p>Notes: proofs run in-browser; actions may take a few seconds.</p>
                </div>
            </section>
        );
    }

    const { loading, items } = useAdminChecklist({
        connection,
        veilpayProgram,
        verifierProgram,
        mintAddress,
    });

    return (
        <section className={styles.card}>
            <header>
                <h2>Admin Runbook</h2>
                <p>Localnet bootstrap steps (auto-checking).</p>
            </header>
            <div className={styles.section}>
                <ol className={styles.list}>
                    {items.map((item) => (
                        <li key={item.id} className={item.done ? styles.done : styles.pending}>
                            <span className={styles.status}>{item.done ? '✓' : '•'}</span>
                            <span>{item.label}</span>
                        </li>
                    ))}
                    {loading && <li className={styles.pending}>Checking status...</li>}
                    {!loading && items.length === 0 && <li className={styles.pending}>Connect a wallet to begin.</li>}
                </ol>
            </div>
        </section>
    );
};
