import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './SetupCard.module.css';
import {
    airdropSol,
    createMint,
    initializeConfig,
    initializeMintState,
    initializeVerifierKey,
    initializeVkRegistry,
    mintToWallet,
    registerMint,
} from '../lib/adminSetup';

type SetupCardProps = {
    veilpayProgram: Program | null;
    verifierProgram: Program | null;
    connection: Connection;
    onStatus: (message: string) => void;
    mintAddress: string;
    onMintChange: (value: string) => void;
    mintDecimals: number | null;
};

export const SetupCard: FC<SetupCardProps> = ({
    veilpayProgram,
    verifierProgram,
    connection,
    onStatus,
    mintAddress,
    onMintChange,
    mintDecimals,
}) => {
    const { publicKey, sendTransaction, signTransaction } = useWallet();
    const [busy, setBusy] = useState(false);
    const [decimals, setDecimals] = useState(6);
    const [mintAmount, setMintAmount] = useState('1000');
    const [useExistingMint, setUseExistingMint] = useState(false);

    const parsedMint = useMemo(() => {
        if (!mintAddress) return null;
        try {
            return new PublicKey(mintAddress);
        } catch {
            return null;
        }
    }, [mintAddress]);

    const handleInitializeConfig = async () => {
        if (!veilpayProgram || !publicKey) return;
        setBusy(true);
        await initializeConfig({ program: veilpayProgram, admin: publicKey, onStatus });
        setBusy(false);
    };

    const handleInitializeVkRegistry = async () => {
        if (!veilpayProgram || !publicKey) return;
        setBusy(true);
        await initializeVkRegistry({ program: veilpayProgram, admin: publicKey, onStatus });
        setBusy(false);
    };

    const handleInitializeVerifierKey = async () => {
        if (!verifierProgram || !publicKey) return;
        setBusy(true);
        await initializeVerifierKey({ program: verifierProgram, admin: publicKey, onStatus });
        setBusy(false);
    };

    const handleAirdrop = async () => {
        if (!publicKey) return;
        setBusy(true);
        await airdropSol({ connection, publicKey, onStatus });
        setBusy(false);
    };

    const handleCreateMint = async () => {
        if (!publicKey || !signTransaction) {
            onStatus('Connect a wallet that supports signing.');
            return;
        }
        setBusy(true);
        await createMint({
            connection,
            wallet: { publicKey, sendTransaction, signTransaction },
            decimals,
            onStatus,
            onMintChange,
        });
        setBusy(false);
    };

    const handleRegisterMint = async () => {
        if (!veilpayProgram || !publicKey || !parsedMint) return;
        setBusy(true);
        await registerMint({
            program: veilpayProgram,
            admin: publicKey,
            mint: parsedMint,
            onStatus,
            connection,
        });
        setBusy(false);
    };

    const handleInitializeMintState = async () => {
        if (!veilpayProgram || !publicKey || !parsedMint) return;
        setBusy(true);
        await initializeMintState({
            program: veilpayProgram,
            admin: publicKey,
            mint: parsedMint,
            connection,
            sendTransaction,
            onStatus,
        });
        setBusy(false);
    };

    const handleMintToUser = async () => {
        if (!publicKey || !parsedMint) return;
        setBusy(true);
        await mintToWallet({
            connection,
            admin: publicKey,
            mint: parsedMint,
            decimals: mintDecimals ?? decimals,
            amount: mintAmount,
            sendTransaction,
            onStatus,
        });
        setBusy(false);
    };

    return (
        <section className={styles.card}>
            <header className={styles.header}>
                <h2>Localnet setup</h2>
                <p>Initialize protocol PDAs, verifier key, and a local SPL mint.</p>
            </header>
            <div className={styles.grid}>
                <button className={styles.button} onClick={handleAirdrop} disabled={!publicKey || busy}>
                    Airdrop SOL
                </button>
                <button className={styles.button} onClick={handleInitializeConfig} disabled={!publicKey || busy}>
                    Initialize config
                </button>
                <button className={styles.button} onClick={handleInitializeVkRegistry} disabled={!publicKey || busy}>
                    Initialize VK registry
                </button>
                <button className={styles.button} onClick={handleInitializeVerifierKey} disabled={!publicKey || busy}>
                    Initialize verifier key
                </button>
                <div className={styles.fieldRow}>
                    <label className={styles.label}>
                        Mint address
                        <input
                            value={mintAddress}
                            onChange={(event) => onMintChange(event.target.value)}
                            placeholder="Mint pubkey"
                            disabled={!useExistingMint}
                        />
                    </label>
                    <button className={styles.button} onClick={handleCreateMint} disabled={!publicKey || busy}>
                        Create mint
                    </button>
                </div>
                <label className={styles.checkbox}>
                    <input
                        type="checkbox"
                        checked={useExistingMint}
                        onChange={(event) => setUseExistingMint(event.target.checked)}
                    />
                    Use existing mint
                </label>
                <div className={styles.fieldRow}>
                    <label className={styles.label}>
                        Decimals
                        <input
                            type="number"
                            min={0}
                            max={9}
                            value={decimals}
                            onChange={(event) => setDecimals(Number(event.target.value))}
                        />
                    </label>
                    <button className={styles.button} onClick={handleRegisterMint} disabled={!publicKey || !parsedMint || busy}>
                        Register mint
                    </button>
                </div>
                <button className={styles.button} onClick={handleInitializeMintState} disabled={!publicKey || !parsedMint || busy}>
                    Initialize mint state
                </button>
                <div className={styles.fieldRow}>
                    <label className={styles.label}>
                        Mint amount (tokens)
                        <input
                            value={mintAmount}
                            onChange={(event) => setMintAmount(event.target.value)}
                        />
                    </label>
                    <button className={styles.button} onClick={handleMintToUser} disabled={!publicKey || !parsedMint || busy}>
                        Mint to wallet
                    </button>
                </div>
            </div>
        </section>
    );
};
