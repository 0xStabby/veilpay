import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { AnchorProvider } from '@coral-xyz/anchor';
import { RELAYER_URL } from './config';

export async function submitViaRelayerUnsigned(
    provider: AnchorProvider,
    transaction: Transaction | VersionedTransaction
) {
    const { blockhash } = await provider.connection.getLatestBlockhash();
    if (transaction instanceof VersionedTransaction) {
        transaction.message.recentBlockhash = blockhash;
    } else {
        transaction.recentBlockhash = blockhash;
    }

    const serialized =
        transaction instanceof VersionedTransaction
            ? transaction.serialize()
            : transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
    const payload = {
        transaction: Buffer.from(serialized).toString('base64'),
    };

    const response = await fetch(`${RELAYER_URL}/execute-relayed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Relayer error: ${text}`);
    }

    return await response.json();
}
