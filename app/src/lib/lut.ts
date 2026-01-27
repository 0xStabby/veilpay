import {
    type AddressLookupTableAccount,
    type Connection,
    PublicKey,
    type TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import { LUT_ADDRESS } from './config';

export async function getRequiredLookupTable(
    connection: Connection
): Promise<AddressLookupTableAccount> {
    if (!LUT_ADDRESS) {
        throw new Error('LUT_ADDRESS not configured. Versioned transactions require a lookup table.');
    }
    const existing = await connection.getAddressLookupTable(new PublicKey(LUT_ADDRESS));
    if (!existing.value) {
        throw new Error('Lookup table not found for LUT_ADDRESS.');
    }
    return existing.value;
}

export async function buildLutVersionedTransaction(params: {
    connection: Connection;
    payer: PublicKey;
    instructions: TransactionInstruction[];
    lookupTable?: AddressLookupTableAccount;
}) {
    const { connection, payer, instructions, lookupTable } = params;
    const table = lookupTable ?? (await getRequiredLookupTable(connection));
    const {
        context: { slot: minContextSlot },
        value: { blockhash, lastValidBlockHeight },
    } = await connection.getLatestBlockhashAndContext();
    const message = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message([table]);
    const tx = new VersionedTransaction(message);
    return { tx, lookupTable: table, blockhash, lastValidBlockHeight, minContextSlot };
}

export async function sendLutVersionedTransaction(params: {
    connection: Connection;
    payer: PublicKey;
    instructions: TransactionInstruction[];
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
    lookupTable?: AddressLookupTableAccount;
}) {
    const { connection, signTransaction } = params;
    const { tx, blockhash, lastValidBlockHeight } = await buildLutVersionedTransaction(params);
    const signed = await signTransaction(tx);
    const signature = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    return signature;
}
