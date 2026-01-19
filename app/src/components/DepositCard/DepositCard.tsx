import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { BN, Program } from '@coral-xyz/anchor';
import type { AnchorProvider } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import styles from './DepositCard.module.css';
import { deriveConfig, deriveShielded, deriveVault } from '../../lib/pda';
import { bytesToBigIntBE, modField, randomBytes, sha256, toHex } from '../../lib/crypto';
import { computeCommitment, bigIntToBytes32 } from '../../lib/prover';

const DEFAULT_AMOUNT = '500000';

type DepositCardProps = {
    veilpayProgram: Program | null;
    mintAddress: string;
    onStatus: (message: string) => void;
    root: Uint8Array;
    onRootChange: (next: Uint8Array) => void;
};

export const DepositCard: FC<DepositCardProps> = ({
    veilpayProgram,
    mintAddress,
    onStatus,
    root,
    onRootChange,
}) => {
    const [amount, setAmount] = useState(DEFAULT_AMOUNT);
    const [busy, setBusy] = useState(false);
    const [recipientTag, setRecipientTag] = useState('');

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);

    const handleDeposit = async () => {
        if (!veilpayProgram || !parsedMint) return;
        setBusy(true);
        try {
            onStatus('Submitting deposit...');
            const provider = veilpayProgram.provider as AnchorProvider;
            const wallet = provider.wallet;
            if (!wallet) {
                throw new Error('Connect a wallet to deposit.');
            }
            const config = deriveConfig(veilpayProgram.programId);
            const vault = deriveVault(veilpayProgram.programId, parsedMint);
            const shieldedState = deriveShielded(veilpayProgram.programId, parsedMint);
            const vaultAta = await getAssociatedTokenAddress(parsedMint, vault, true);
            const userAta = await getAssociatedTokenAddress(parsedMint, wallet.publicKey);

            const ciphertext = randomBytes(64);
            const newRootValue = modField(bytesToBigIntBE(randomBytes(32)));
            const newRoot = bigIntToBytes32(newRootValue);
            const randomness = modField(bytesToBigIntBE(randomBytes(32)));
            const amountValue = BigInt(amount);
            const cleanedTag = recipientTag.replace(/^0x/, '');
            const recipientTagBytes =
                cleanedTag.length === 64
                    ? Uint8Array.from(
                          cleanedTag.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []
                      )
                    : await sha256(wallet.publicKey.toBytes());
            const recipientTagHash = modField(bytesToBigIntBE(recipientTagBytes));
            const commitmentValue = await computeCommitment(amountValue, randomness, recipientTagHash);
            const commitment = bigIntToBytes32(commitmentValue);

            await veilpayProgram.methods
                .deposit({
                    amount: new BN(amount),
                    ciphertext: Buffer.from(ciphertext),
                    commitment: Buffer.from(commitment),
                    newRoot: Buffer.from(newRoot),
                })
                .accounts({
                    config,
                    vault,
                    vaultAta,
                    shieldedState,
                    user: wallet.publicKey,
                    userAta,
                    mint: parsedMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            onRootChange(newRoot);
            onStatus(`Deposit complete. New root ${toHex(newRoot).slice(0, 10)}...`);
        } catch (error) {
            onStatus(`Deposit failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={styles.card}>
            <header>
                <h2>Deposit</h2>
                <p>Move SPL tokens into the escrow vault and append a commitment.</p>
            </header>
            <label className={styles.label}>
                Amount (base units)
                <input value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>
            <label className={styles.label}>
                Recipient tag hash (hex, optional)
                <input value={recipientTag} onChange={(event) => setRecipientTag(event.target.value)} />
            </label>
            <p className={styles.helper}>Current root: {toHex(root).slice(0, 16)}...</p>
            <button className={styles.button} disabled={!parsedMint || busy || !veilpayProgram} onClick={handleDeposit}>
                Deposit
            </button>
        </section>
    );
};
