import { useCallback, useMemo, useState } from 'react';
import type { FC } from 'react';
import { WalletNotConnectedError } from '@solana/wallet-adapter-base';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { buildLutVersionedTransaction } from '../../lib/lut';
import styles from './SendSolCard.module.css';

export const SendSolCard: FC = () => {
    const { connection } = useConnection();
    const { publicKey, sendTransaction } = useWallet();
    const [status, setStatus] = useState<string>('');
    const [busy, setBusy] = useState(false);

    const disabledReason = useMemo(() => {
        if (!publicKey) return 'Connect a wallet to test transfers.';
        if (busy) return 'Processing transaction...';
        return '';
    }, [publicKey, busy]);

    const onClick = useCallback(async () => {
        if (!publicKey) throw new WalletNotConnectedError();

        setBusy(true);
        setStatus('Preparing transaction...');

        try {
            const lamports = await connection.getMinimumBalanceForRentExemption(0);

            const { tx, minContextSlot, blockhash, lastValidBlockHeight } = await buildLutVersionedTransaction({
                connection,
                payer: publicKey,
                instructions: [
                    SystemProgram.transfer({
                        fromPubkey: publicKey,
                        toPubkey: Keypair.generate().publicKey,
                        lamports,
                    }),
                ],
            });

            const signature = await sendTransaction(tx, connection, { minContextSlot });

            setStatus('Confirming on-chain...');
            await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature });
            setStatus(`Confirmed: ${signature.slice(0, 12)}...`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unexpected error';
            setStatus(`Failed: ${message}`);
        } finally {
            setBusy(false);
        }
    }, [publicKey, sendTransaction, connection]);

    return (
        <section className={styles.card}>
            <div>
                <h2 className={styles.title}>Send SOL test</h2>
                <p className={styles.description}>
                    Fires a SystemProgram transfer to a random address using the wallet adapter.
                </p>
            </div>
            <button className={styles.button} onClick={onClick} disabled={!publicKey || busy}>
                {busy ? 'Sending...' : 'Send SOL'}
            </button>
            <p className={styles.helper}>{disabledReason || status}</p>
        </section>
    );
};
