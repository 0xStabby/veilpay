import React, { FC, useMemo, useState } from 'react';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import styles from './UserDepositCard.module.css';
import { formatTokenAmount } from '../lib/amount';
import { runDepositFlow } from '../lib/flows';

const DEFAULT_AMOUNT = '50000';

type UserDepositCardProps = {
    veilpayProgram: Program | null;
    mintAddress: string;
    onStatus: (message: string) => void;
    onRootChange: (next: Uint8Array) => void;
    mintDecimals: number | null;
    walletBalance: bigint | null;
    onCredit: (amount: bigint) => void;
};

export const UserDepositCard: FC<UserDepositCardProps> = ({
    veilpayProgram,
    mintAddress,
    onStatus,
    onRootChange,
    mintDecimals,
    walletBalance,
    onCredit,
}) => {
    const [amount, setAmount] = useState(DEFAULT_AMOUNT);
    const [busy, setBusy] = useState(false);

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);

    const handleDeposit = async () => {
        if (!veilpayProgram || !parsedMint || mintDecimals === null) return;
        setBusy(true);
        try {
            await runDepositFlow({
                program: veilpayProgram,
                mint: parsedMint,
                amount,
                mintDecimals,
                onStatus,
                onRootChange,
                onCredit,
            });
        } catch (error) {
            onStatus(`Deposit failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={styles.card}>
            <header>
                <h2>Deposit</h2>
                <p>Move funds into your private balance.</p>
            </header>
            <div className={styles.labelRow}>
                <label className={styles.label}>
                    Amount (tokens)
                    <input value={amount} onChange={(event) => setAmount(event.target.value)} />
                </label>
                {walletBalance !== null && mintDecimals !== null && (
                    <button
                        type="button"
                        className={styles.balanceButton}
                        onClick={() => setAmount(formatTokenAmount(walletBalance, mintDecimals))}
                    >
                        Wallet: {formatTokenAmount(walletBalance, mintDecimals)}
                    </button>
                )}
            </div>
            <button className={styles.button} disabled={!parsedMint || mintDecimals === null || busy} onClick={handleDeposit}>
                Deposit
            </button>
        </section>
    );
};
