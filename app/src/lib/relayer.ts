import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { AnchorProvider } from '@coral-xyz/anchor';
import { RELAYER_URL } from './config';

export async function submitViaRelayer(provider: AnchorProvider, transaction: Transaction) {
    const { blockhash } = await provider.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = provider.wallet.publicKey;

    const signed = await provider.wallet.signTransaction(transaction);
    const payload = {
        transaction: Buffer.from(signed.serialize()).toString('base64'),
    };

    const response = await fetch(`${RELAYER_URL}/execute`, {
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
