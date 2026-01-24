import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './UserReceiveCard.module.css';
import { deriveViewKeypair, serializeViewKey } from '../../lib/notes';

type UserReceiveCardProps = {
    onStatus: (message: string) => void;
    embedded?: boolean;
    viewKeyIndices?: number[];
    onViewKeyIndicesChange?: (indices: number[]) => void;
};

export const UserReceiveCard: FC<UserReceiveCardProps> = ({
    onStatus,
    embedded = false,
    viewKeyIndices,
    onViewKeyIndicesChange,
}) => {
    const { publicKey, signMessage } = useWallet();
    const [page, setPage] = useState(0);
    const [jumpIndex, setJumpIndex] = useState('');


    const selectedSet = useMemo(
        () => new Set(viewKeyIndices && viewKeyIndices.length > 0 ? viewKeyIndices : [0]),
        [viewKeyIndices]
    );
    const pageStart = page * 10;
    const indices = Array.from({ length: 10 }, (_, i) => pageStart + i);

    const toggleIndex = (index: number) => {
        const current = Array.from(selectedSet);
        if (selectedSet.has(index)) {
            const next = current.filter((value) => value !== index);
            onViewKeyIndicesChange?.(next.length ? next : [0]);
            onStatus(`Removed view key index ${index} from scan list.`);
        } else {
            const next = [...current, index].sort((a, b) => a - b);
            onViewKeyIndicesChange?.(next);
            onStatus(`Added view key index ${index} to scan list.`);
        }
    };

    const handleCopyIndex = async (index: number) => {
        if (!publicKey || !signMessage) {
            onStatus('Connect a wallet that can sign a message to derive view keys.');
            return;
        }
        try {
            const viewKey = await deriveViewKeypair({
                owner: publicKey,
                signMessage,
                index,
            });
            const encoded = serializeViewKey(viewKey.pubkey);
            await navigator.clipboard.writeText(encoded);
            onStatus(`Copied view key index ${index} to clipboard.`);
        } catch (error) {
            onStatus(`Failed to derive view key: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    };

    const handleJump = () => {
        const value = Number(jumpIndex);
        if (!Number.isInteger(value) || value < 0) {
            onStatus('Invalid index to jump to.');
            return;
        }
        setPage(Math.floor(value / 10));
        setJumpIndex('');
    };

    return (
        <section className={embedded ? styles.embedded : styles.card}>
            <header>
                {embedded ? <h3>Receive</h3> : <h2>Receive</h2>}
                <p>Select which receive keys to scan. Copy a key to share it for internal transfers.</p>
            </header>
            <div className={styles.column}>
                <div className={styles.label}>
                    <span>View key scan list</span>
                    <div className={styles.list}>
                        {indices.map((index) => (
                            <div key={index} className={styles.listRow}>
                                <button
                                    type="button"
                                    className={selectedSet.has(index) ? styles.toggleOn : styles.toggleOff}
                                    onClick={() => toggleIndex(index)}
                                >
                                    {selectedSet.has(index) ? 'Scan' : 'Skip'}
                                </button>
                                <span className={styles.indexLabel}>Index {index}</span>
                                <button
                                    type="button"
                                    className={styles.buttonSecondary}
                                    onClick={() => handleCopyIndex(index)}
                                    disabled={!signMessage}
                                >
                                    Copy key
                                </button>
                            </div>
                        ))}
                    </div>
                    <div className={styles.pager}>
                        <button
                            type="button"
                            className={styles.buttonSecondary}
                            onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                            disabled={page === 0}
                        >
                            Prev
                        </button>
                        <span className={styles.pageLabel}>Page {page + 1}</span>
                        <button
                            type="button"
                            className={styles.buttonSecondary}
                            onClick={() => setPage((prev) => prev + 1)}
                        >
                            Next
                        </button>
                        <input
                            value={jumpIndex}
                            onChange={(event) => setJumpIndex(event.target.value)}
                            placeholder="go to index"
                        />
                        <button type="button" className={styles.buttonSecondary} onClick={handleJump}>
                            Go
                        </button>
                    </div>
                </div>
            </div>
        </section>
    );
};
