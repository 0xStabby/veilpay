import { useEffect, useRef } from 'react';
import type { FC } from 'react';
import styles from './StatusBanner.module.css';

type StatusBannerProps = {
    lines: string[];
};

export const StatusBanner: FC<StatusBannerProps> = ({ lines }) => {
    if (!lines.length) return null;
    const logRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const el = logRef.current;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }, [lines.length]);

    return (
        <div className={styles.banner}>
            <div ref={logRef} className={styles.log}>
                {lines.map((line, index) => (
                    <div key={`${index}-${line}`} className={styles.logLine}>
                        {line}
                    </div>
                ))}
            </div>
        </div>
    );
};
