import { useMemo, useState } from 'react';
import type { FC } from 'react';
import styles from './RunbookCard.module.css';
import { useAdminChecklist } from '../../hooks/useAdminChecklist';
import { Program } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import {
    airdropSol,
    initializeConfig,
    initializeMintState,
    initializeVerifierKey,
    initializeVkRegistry,
    registerMint,
    wrapSolToWsol,
} from '../../lib/adminSetup';
import { WSOL_MINT } from '../../lib/config';

type RunbookCardProps = {
    mode: 'admin' | 'user';
    connection?: Connection | null;
    veilpayProgram?: Program | null;
    verifierProgram?: Program | null;
    mintAddress?: string;
    onMintChange?: (value: string) => void;
    onStatus?: (message: string) => void;
};

type StepStatus = 'idle' | 'running' | 'success' | 'error';

export const RunbookCard: FC<RunbookCardProps> = ({
    mode,
    connection = null,
    veilpayProgram = null,
    verifierProgram = null,
    mintAddress = '',
    onMintChange,
    onStatus = () => undefined,
}) => {
    const { publicKey, sendTransaction } = useWallet();
    const [busy, setBusy] = useState(false);
    const [stepStatus, setStepStatus] = useState<Record<string, StepStatus>>({});

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);

    const setStatus = (id: string, status: StepStatus) => {
        setStepStatus((prev) => ({ ...prev, [id]: status }));
    };

    const { loading, items } = useAdminChecklist({
        connection,
        veilpayProgram,
        verifierProgram,
        mintAddress,
    });

    const runAdminSetup = async () => {
        if (!connection || !publicKey || !veilpayProgram || !verifierProgram) {
            onStatus('Connect wallet and ensure programs are ready.');
            return;
        }
        setBusy(true);
        onStatus('Running full admin setup...');

        const doneMap = new Map(items.map((item) => [item.id, item.done]));
        const steps: Array<{ id: string; run: () => Promise<boolean> }> = [
            {
                id: 'funded',
                run: () => airdropSol({ connection, publicKey, onStatus }),
            },
            {
                id: 'config',
                run: () => initializeConfig({ program: veilpayProgram, admin: publicKey, onStatus }),
            },
            {
                id: 'vk-registry',
                run: () => initializeVkRegistry({ program: veilpayProgram, admin: publicKey, onStatus }),
            },
            {
                id: 'verifier-key',
                run: () => initializeVerifierKey({ program: verifierProgram, admin: publicKey, onStatus }),
            },
        ];

        for (const step of steps) {
            if (doneMap.get(step.id)) {
                setStatus(step.id, 'success');
                continue;
            }
            setStatus(step.id, 'running');
            const ok = await step.run();
            setStatus(step.id, ok ? 'success' : 'error');
            if (!ok) {
                setBusy(false);
                return;
            }
        }

        let activeMint = parsedMint;
        if (!activeMint) {
            activeMint = WSOL_MINT;
            onMintChange?.(WSOL_MINT.toBase58());
        }
        setStatus('mint', activeMint.equals(WSOL_MINT) ? 'success' : 'error');
        if (!activeMint.equals(WSOL_MINT)) {
            onStatus('Mint must be WSOL on devnet.');
            setBusy(false);
            return;
        }

        const followups: Array<{ id: string; run: () => Promise<boolean> }> = [
            {
                id: 'register-mint',
                run: () =>
                    registerMint({
                        program: veilpayProgram,
                        admin: publicKey,
                        mint: activeMint!,
                        onStatus,
                        connection,
                    }),
            },
            {
                id: 'mint-state',
                run: () =>
                    initializeMintState({
                        program: veilpayProgram,
                        admin: publicKey,
                        mint: activeMint!,
                        connection,
                        sendTransaction,
                        onStatus,
                    }),
            },
            {
                id: 'wrap-sol',
                run: () =>
                    wrapSolToWsol({
                        connection,
                        admin: publicKey,
                        amount: '1',
                        sendTransaction,
                        onStatus,
                    }),
            },
        ];

        for (const step of followups) {
            if (doneMap.get(step.id)) {
                setStatus(step.id, 'success');
                continue;
            }
            setStatus(step.id, 'running');
            const ok = await step.run();
            setStatus(step.id, ok ? 'success' : 'error');
            if (!ok) {
                setBusy(false);
                return;
            }
        }

        setBusy(false);
        onStatus('Admin setup complete.');
    };

    return (
        <section className={styles.card}>
            {mode === 'user' ? (
                <>
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
                </>
            ) : (
                <>
                    <header>
                        <h2>Admin Runbook</h2>
                        <p>Admin bootstrap steps (auto-checking).</p>
                    </header>
                    <div className={styles.flowChecklist}>
                        {items.map((item) => {
                            const status = stepStatus[item.id] ?? (item.done ? 'success' : 'idle');
                            return (
                                <div key={item.id} className={styles.flowRow} data-status={status}>
                                    <span className={styles.flowDot} />
                                    <span>{item.label}</span>
                                    <span className={styles.flowStatus}>
                                        {status === 'running' ? 'running' : item.done ? 'done' : status}
                                    </span>
                                </div>
                            );
                        })}
                        {loading && (
                            <div className={styles.flowRow}>
                                <span className={styles.flowDot} />
                                <span>Checking status...</span>
                                <span className={styles.flowStatus}>running</span>
                            </div>
                        )}
                        {!loading && items.length === 0 && (
                            <div className={styles.flowRow}>
                                <span className={styles.flowDot} />
                                <span>Connect a wallet to begin.</span>
                                <span className={styles.flowStatus}>idle</span>
                            </div>
                        )}
                    </div>
                    <button className={styles.button} onClick={runAdminSetup} disabled={!publicKey || busy}>
                        {busy ? 'Running setup...' : 'Run full admin setup'}
                    </button>
                </>
            )}
        </section>
    );
};
