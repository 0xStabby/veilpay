import type { FC } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import styles from './WalletHeader.module.css';

export const WalletHeader: FC = () => {
    return (
        <header className={styles.header}>
            <div>
                <p className={styles.kicker}>VeilPay</p>
                <h1 className={styles.title}>Private Payments Console</h1>
            </div>
            <div className={styles.actions}>
                <WalletMultiButton className={styles.primaryButton} />
            </div>
        </header>
    );
};
