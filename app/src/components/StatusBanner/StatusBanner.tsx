import { useEffect, useRef, useState } from 'react';
import type { FC } from 'react';
import styles from './StatusBanner.module.css';

type StatusBannerProps = {
    lines: string[];
};

export const StatusBanner: FC<StatusBannerProps> = ({ lines }) => {
    if (!lines.length) return null;
    const logRef = useRef<HTMLDivElement | null>(null);
    const [copied, setCopied] = useState(false);
    const [collapsed, setCollapsed] = useState(true);
    const copyResetRef = useRef<number | null>(null);

    const handleCopy = async () => {
        const text = lines.join('\n');
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            }
            setCopied(true);
            if (copyResetRef.current) {
                window.clearTimeout(copyResetRef.current);
            }
            copyResetRef.current = window.setTimeout(() => {
                setCopied(false);
                copyResetRef.current = null;
            }, 1500);
        } catch {
            setCopied(false);
        }
    };

    useEffect(() => {
        const el = logRef.current;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }, [lines.length]);

    useEffect(() => {
        return () => {
            if (copyResetRef.current) {
                window.clearTimeout(copyResetRef.current);
            }
        };
    }, []);

    return (
        <>
            {collapsed ? (
                <div className={styles.collapsedDock}>
                    <button
                        className={styles.collapsedButton}
                        onClick={() => setCollapsed(false)}
                        type="button"
                    >
                        Show log
                    </button>
                </div>
            ) : (
                <>
                    <div className={styles.banner} data-collapsed="false">
                        <div className={styles.header}>
                            <span className={styles.title}>Log</span>
                            <div className={styles.actions}>
                                <button className={styles.copyButton} onClick={handleCopy} type="button">
                                    {copied ? 'Copied' : 'Copy'}
                                </button>
                            </div>
                        </div>
                        <div ref={logRef} className={styles.log}>
                            {lines.map((line, index) => (
                                <div key={`${index}-${line}`} className={styles.logLine}>
                                    {line}
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className={styles.collapsedDock}>
                        <button
                            className={styles.collapsedButton}
                            onClick={() => setCollapsed(true)}
                            type="button"
                        >
                            Hide log
                        </button>
                    </div>
                </>
            )}
        </>
    );
};
