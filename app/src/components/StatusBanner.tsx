import type { FC } from 'react';
import styles from './StatusBanner.module.css';

type StatusBannerProps = {
    status: string;
};

export const StatusBanner: FC<StatusBannerProps> = ({ status }) => {
    if (!status) return null;

    return (
        <div className={styles.banner}>
            <span>{status}</span>
        </div>
    );
};
