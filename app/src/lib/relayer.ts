import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { AnchorProvider } from '@coral-xyz/anchor';
import { RELAYER_URL } from './config';

const buildRelayerMessage = (
    payloadBase64: string,
    signer: PublicKey,
    expiresAt: number,
    lookupTableAddresses?: string[]
) => {
    const text = [
        'VeilPay relayer intent',
        `signer:${signer.toBase58()}`,
        `expiresAt:${expiresAt}`,
        `transaction:${payloadBase64}`,
    ];
    if (lookupTableAddresses && lookupTableAddresses.length > 0) {
        text.push(`lookupTableAddresses:${lookupTableAddresses.join(',')}`);
    }
    const messageText = text.join('\n');
    return new TextEncoder().encode(messageText);
};

export async function submitViaRelayerSigned(
    provider: AnchorProvider,
    transaction: Transaction | VersionedTransaction,
    signer: PublicKey,
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>,
    lookupTableAddresses?: string[]
) {
    if (!signMessage) {
        throw new Error('Wallet does not support message signing for relayed transfers.');
    }
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
    const transactionBase64 = Buffer.from(serialized).toString('base64');
    const expiresAt = Date.now() + 2 * 60 * 1000;
    const message = buildRelayerMessage(
        transactionBase64,
        signer,
        expiresAt,
        lookupTableAddresses
    );
    const signature = await signMessage(message);
    const payload: {
        transaction: string;
        signer: string;
        signature: string;
        message: string;
        expiresAt: number;
        lookupTableAddresses?: string[];
    } = {
        transaction: transactionBase64,
        signer: signer.toBase58(),
        signature: Buffer.from(signature).toString('base64'),
        message: Buffer.from(message).toString('base64'),
        expiresAt,
    };
    if (lookupTableAddresses && lookupTableAddresses.length > 0) {
        payload.lookupTableAddresses = lookupTableAddresses;
    }

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
