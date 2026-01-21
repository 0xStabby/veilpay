import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './SetupCard.module.css';
import {
    airdropSol,
    initializeConfig,
    initializeIdentityRegistry,
    initializeMintState,
    initializeVerifierKey,
    initializeVkRegistry,
    registerMint,
    wrapSolToWsol,
} from '../../lib/adminSetup';
import { WSOL_MINT } from '../../lib/config';

type SetupCardProps = {
    veilpayProgram: Program | null;
    verifierProgram: Program | null;
    connection: Connection;
    onStatus: (message: string) => void;
    mintAddress: string;
    onMintChange: (value: string) => void;
};

export const SetupCard: FC<SetupCardProps> = ({
    veilpayProgram,
    verifierProgram,
    connection,
    onStatus,
    mintAddress,
    onMintChange,
}) => {
    const { publicKey, sendTransaction } = useWallet();
    const [busy, setBusy] = useState(false);
    const [wrapAmount, setWrapAmount] = useState('1');

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

    const handleInitializeIdentityRegistry = async () => {
        if (!veilpayProgram || !publicKey) return;
        setBusy(true);
        await initializeIdentityRegistry({ program: veilpayProgram, admin: publicKey, onStatus });
        setBusy(false);
    };

    const handleAirdrop = async () => {
        if (!publicKey) return;
        setBusy(true);
        await airdropSol({ connection, publicKey, onStatus });
        setBusy(false);
    };

    const handleWrapSol = async () => {
        if (!publicKey) return;
        setBusy(true);
        await wrapSolToWsol({
            connection,
            admin: publicKey,
            amount: wrapAmount,
            sendTransaction,
            onStatus,
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

    const handleSetWsol = () => {
        onMintChange(WSOL_MINT.toBase58());
    };

    return (
        <section className={styles.card}>
            <header className={styles.header}>
                <h2>Admin setup</h2>
                <p>Initialize protocol PDAs, verifier key, and WSOL mint state.</p>
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
                <button className={styles.button} onClick={handleInitializeIdentityRegistry} disabled={!publicKey || busy}>
                    Initialize identity registry
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
                            placeholder="WSOL mint"
                        />
                    </label>
                    <button className={styles.button} onClick={handleSetWsol} disabled={busy}>
                        Use WSOL
                    </button>
                </div>
                <div className={styles.fieldRow}>
                    <button className={styles.button} onClick={handleRegisterMint} disabled={!publicKey || !parsedMint || busy}>
                        Register mint
                    </button>
                </div>
                <button className={styles.button} onClick={handleInitializeMintState} disabled={!publicKey || !parsedMint || busy}>
                    Initialize mint state
                </button>
                <div className={styles.fieldRow}>
                    <label className={styles.label}>
                        Wrap SOL amount
                        <input
                            value={wrapAmount}
                            onChange={(event) => setWrapAmount(event.target.value)}
                        />
                    </label>
                    <button className={styles.button} onClick={handleWrapSol} disabled={!publicKey || busy}>
                        Wrap SOL
                    </button>
                </div>
            </div>
        </section>
    );
};
