import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Buffer } from 'buffer';
import { BN, Program } from '@coral-xyz/anchor';
import type { AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import styles from './UserDepositCard.module.css';
import { deriveConfig, deriveShielded, deriveVault } from '../lib/pda';
import { bytesToBigIntBE, modField, randomBytes, sha256 } from '../lib/crypto';
import { computeCommitment, bigIntToBytes32 } from '../lib/prover';
import { formatTokenAmount, parseTokenAmount } from '../lib/amount';

const DEFAULT_AMOUNT = '50000';

type UserDepositCardProps = {
    veilpayProgram: Program | null;
    mintAddress: string;
    onStatus: (message: string) => void;
    onRootChange: (next: Uint8Array) => void;
    mintDecimals: number | null;
    walletBalance: bigint | null;
    onCredit: (amount: bigint) => void;
};

export const UserDepositCard: FC<UserDepositCardProps> = ({
    veilpayProgram,
    mintAddress,
    onStatus,
    onRootChange,
    mintDecimals,
    walletBalance,
    onCredit,
}) => {
    const [amount, setAmount] = useState(DEFAULT_AMOUNT);
    const [busy, setBusy] = useState(false);

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);

    const handleDeposit = async () => {
        if (!veilpayProgram || !parsedMint || mintDecimals === null) return;
        setBusy(true);
        try {
            onStatus('Depositing into VeilPay vault...');
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
            const baseUnits = parseTokenAmount(amount, mintDecimals);
            const amountValue = baseUnits;
            const recipientTagBytes = await sha256(wallet.publicKey.toBytes());
            const recipientTagHash = modField(bytesToBigIntBE(recipientTagBytes));
            const commitmentValue = await computeCommitment(amountValue, randomness, recipientTagHash);
            const commitment = bigIntToBytes32(commitmentValue);

            await veilpayProgram.methods
                .deposit({
                    amount: new BN(baseUnits.toString()),
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
            onCredit(baseUnits);
            onStatus('Deposit complete.');
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
                <p>Move funds into your private balance.</p>
            </header>
            <div className={styles.labelRow}>
                <label className={styles.label}>
                    Amount (tokens)
                    <input value={amount} onChange={(event) => setAmount(event.target.value)} />
                </label>
                {walletBalance !== null && mintDecimals !== null && (
                    <button
                        type="button"
                        className={styles.balanceButton}
                        onClick={() => setAmount(formatTokenAmount(walletBalance, mintDecimals))}
                    >
                        Wallet: {formatTokenAmount(walletBalance, mintDecimals)}
                    </button>
                )}
            </div>
            <button className={styles.button} disabled={!parsedMint || mintDecimals === null || busy} onClick={handleDeposit}>
                Deposit
            </button>
        </section>
    );
};
