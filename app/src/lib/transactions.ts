export type TransactionRecord = {
    id: string;
    flow: string;
    signature?: string;
    relayer: boolean;
    status: 'confirmed' | 'failed';
    createdAt: string;
    details: Record<string, unknown>;
};

export type TransactionRecordPatch = Partial<Omit<TransactionRecord, 'id' | 'createdAt'>> & {
    details?: Record<string, unknown>;
};

export function createTransactionRecord(
    flow: string,
    params: Omit<TransactionRecord, 'id' | 'flow' | 'createdAt'>
): TransactionRecord {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return {
        id,
        flow,
        createdAt: new Date().toISOString(),
        ...params,
    };
}

export async function fetchTransactionDetails(
    connection: import('@solana/web3.js').Connection,
    signature: string
): Promise<Record<string, unknown> | null> {
    try {
        const parsed = await connection.getParsedTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
        });
        if (!parsed) return null;

        const accounts = parsed.transaction.message.accountKeys.map((key) => ({
            pubkey: key.pubkey.toBase58(),
            signer: key.signer,
            writable: key.writable,
        }));

        return {
            slot: parsed.slot,
            blockTime: parsed.blockTime,
            fee: parsed.meta?.fee ?? null,
            err: parsed.meta?.err ?? null,
            accounts,
            instructions: parsed.transaction.message.instructions,
            innerInstructions: parsed.meta?.innerInstructions ?? null,
            logMessages: parsed.meta?.logMessages ?? null,
            preBalances: parsed.meta?.preBalances ?? null,
            postBalances: parsed.meta?.postBalances ?? null,
            preTokenBalances: parsed.meta?.preTokenBalances ?? null,
            postTokenBalances: parsed.meta?.postTokenBalances ?? null,
        };
    } catch {
        return null;
    }
}
