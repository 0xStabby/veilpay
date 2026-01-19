import type { FC, ReactNode } from 'react';
import styles from './InfoBanner.module.css';

type InfoBannerProps = {
    children: ReactNode;
};

export const InfoBanner: FC<InfoBannerProps> = ({ children }) => {
    return <div className={styles.banner}>{children}</div>;
};
