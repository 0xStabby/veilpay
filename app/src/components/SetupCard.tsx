import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Connection, PublicKey, SystemProgram, Transaction, Keypair, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
    MINT_SIZE,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createInitializeMintInstruction,
    createMintToInstruction,
    getAccount,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import { Program } from '@coral-xyz/anchor';
import { useWallet } from '@solana/wallet-adapter-react';
import styles from './SetupCard.module.css';
import { deriveConfig, deriveNullifierSet, deriveShielded, deriveVault, deriveVkRegistry, deriveVerifierKey } from '../lib/pda';
import { verifierKeyFixture } from '../lib/fixtures';
import { parseTokenAmount } from '../lib/amount';

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

    const ensureWallet = () => {
        if (!publicKey) throw new Error('Connect a wallet to continue.');
        if (!sendTransaction) throw new Error('Wallet cannot send transactions.');
        if (!veilpayProgram || !verifierProgram) throw new Error('Programs not ready.');
    };

    const handleInitializeConfig = async () => {
        if (!veilpayProgram || !publicKey) return;
        setBusy(true);
        try {
            onStatus('Initializing config...');
            const config = deriveConfig(veilpayProgram.programId);
            const vkRegistry = deriveVkRegistry(veilpayProgram.programId);
            await veilpayProgram.methods
                .initializeConfig({
                    feeBps: 25,
                    relayerFeeBpsMax: 50,
                    vkRegistry,
                    mintAllowlist: [],
                    circuitIds: [0],
                })
                .accounts({
                    config,
                    admin: publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            onStatus('Config initialized.');
        } catch (error) {
            onStatus(`Config init failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    const handleInitializeVkRegistry = async () => {
        if (!veilpayProgram || !publicKey) return;
        setBusy(true);
        try {
            onStatus('Initializing VK registry...');
            const vkRegistry = deriveVkRegistry(veilpayProgram.programId);
            await veilpayProgram.methods
                .initializeVkRegistry()
                .accounts({
                    vkRegistry,
                    admin: publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            onStatus('VK registry initialized.');
        } catch (error) {
            onStatus(`VK registry failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    const handleInitializeVerifierKey = async () => {
        if (!verifierProgram || !publicKey) return;
        setBusy(true);
        try {
            onStatus('Writing Groth16 verifying key...');
            const keyId = 0;
            const verifierKey = deriveVerifierKey(verifierProgram.programId, keyId);
            await verifierProgram.methods
                .initializeVerifierKey({
                    keyId,
                    alphaG1: Buffer.from(verifierKeyFixture.alphaG1),
                    betaG2: Buffer.from(verifierKeyFixture.betaG2),
                    gammaG2: Buffer.from(verifierKeyFixture.gammaG2),
                    deltaG2: Buffer.from(verifierKeyFixture.deltaG2),
                    publicInputsLen: verifierKeyFixture.gammaAbc.length - 1,
                    gammaAbc: verifierKeyFixture.gammaAbc.map((entry) => Buffer.from(entry)),
                    mock: false,
                })
                .accounts({
                    verifierKey,
                    admin: publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            onStatus('Verifier key stored.');
        } catch (error) {
            onStatus(`Verifier key failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    const handleAirdrop = async () => {
        if (!publicKey) return;
        setBusy(true);
        try {
            onStatus('Requesting airdrop...');
            const signature = await connection.requestAirdrop(publicKey, 2 * 1e9);
            await connection.confirmTransaction(signature, 'confirmed');
            onStatus('Airdrop complete.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onStatus(`Airdrop failed: ${message}`);
        } finally {
            setBusy(false);
        }
    };

    const handleCreateMint = async () => {
        ensureWallet();
        if (!signTransaction) {
            onStatus('Wallet cannot sign transactions directly.');
            return;
        }
        if (!publicKey || !sendTransaction) return;
        setBusy(true);
        try {
            onStatus('Creating mint...');
            const mintKeypair = Keypair.generate();
            const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
            const tx = new Transaction().add(
                SystemProgram.createAccount({
                    fromPubkey: publicKey,
                    newAccountPubkey: mintKeypair.publicKey,
                    lamports,
                    space: MINT_SIZE,
                    programId: TOKEN_PROGRAM_ID,
                }),
                createInitializeMintInstruction(
                    mintKeypair.publicKey,
                    decimals,
                    publicKey,
                    null
                )
            );
            const { value } = await connection.getLatestBlockhashAndContext();
            tx.feePayer = publicKey;
            tx.recentBlockhash = value.blockhash;
            tx.partialSign(mintKeypair);
            const signed = await signTransaction(tx);
            const signature = await connection.sendRawTransaction(signed.serialize());
            onStatus(`Mint created: ${mintKeypair.publicKey.toBase58().slice(0, 8)}...`);
            onMintChange(mintKeypair.publicKey.toBase58());
            await connection.confirmTransaction(
                {
                    signature,
                    blockhash: value.blockhash,
                    lastValidBlockHeight: value.lastValidBlockHeight,
                },
                'confirmed'
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onStatus(`Mint create failed: ${message}`);
        } finally {
            setBusy(false);
        }
    };

    const handleRegisterMint = async () => {
        if (!veilpayProgram || !publicKey || !parsedMint) return;
        setBusy(true);
        try {
            onStatus('Registering mint...');
            const config = deriveConfig(veilpayProgram.programId);
            await veilpayProgram.methods
                .registerMint(parsedMint)
                .accounts({
                    config,
                    admin: publicKey,
                })
                .rpc();
            onStatus('Mint registered.');
        } catch (error) {
            onStatus(`Register mint failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    const handleInitializeMintState = async () => {
        if (!veilpayProgram || !publicKey || !parsedMint) return;
        setBusy(true);
        try {
            onStatus('Initializing mint state...');
            const config = deriveConfig(veilpayProgram.programId);
            const vault = deriveVault(veilpayProgram.programId, parsedMint);
            const shieldedState = deriveShielded(veilpayProgram.programId, parsedMint);
            const nullifierSet = deriveNullifierSet(veilpayProgram.programId, parsedMint, 0);
            const vaultAta = await getAssociatedTokenAddress(parsedMint, vault, true);
            const userAta = await getAssociatedTokenAddress(parsedMint, publicKey);

            const instructions: TransactionInstruction[] = [];
            const maybeCreateAta = async (ata: PublicKey, owner: PublicKey) => {
                try {
                    await getAccount(connection, ata);
                } catch {
                    instructions.push(
                        createAssociatedTokenAccountInstruction(publicKey, ata, owner, parsedMint)
                    );
                }
            };

            await maybeCreateAta(userAta, publicKey);
            await maybeCreateAta(vaultAta, vault);

            if (instructions.length > 0) {
                const tx = new Transaction().add(...instructions);
                await sendTransaction(tx, connection);
            }

            await veilpayProgram.methods
                .initializeMintState(0)
                .accounts({
                    config,
                    vault,
                    vaultAta,
                    shieldedState,
                    nullifierSet,
                    admin: publicKey,
                    mint: parsedMint,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            onStatus('Mint state initialized.');
        } catch (error) {
            onStatus(`Mint state failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    const handleMintToUser = async () => {
        ensureWallet();
        if (!parsedMint || !publicKey) return;
        setBusy(true);
        try {
            onStatus('Minting tokens to wallet...');
            const ata = await getAssociatedTokenAddress(parsedMint, publicKey);
            try {
                await getAccount(connection, ata);
            } catch {
                const createIx = createAssociatedTokenAccountInstruction(publicKey, ata, publicKey, parsedMint);
                await sendTransaction(new Transaction().add(createIx), connection);
            }
            const decimalsToUse = mintDecimals ?? decimals;
            const baseUnits = parseTokenAmount(mintAmount, decimalsToUse);
            const ix = createMintToInstruction(parsedMint, ata, publicKey, baseUnits);
            const tx = new Transaction().add(ix);
            await sendTransaction(tx, connection);
            onStatus('Minted tokens to wallet.');
        } catch (error) {
            onStatus(`Mint-to failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={styles.card}>
            <header className={styles.header}>
                <h2>Localnet setup</h2>
                <p>Initialize protocol PDAs, verifier key, and a local SPL mint.</p>
            </header>
            <div className={styles.grid}>
                <button className={styles.button} onClick={handleInitializeConfig} disabled={!publicKey || busy}>
                    Initialize config
                </button>
                <button className={styles.button} onClick={handleInitializeVkRegistry} disabled={!publicKey || busy}>
                    Initialize VK registry
                </button>
                <button className={styles.button} onClick={handleInitializeVerifierKey} disabled={!publicKey || busy}>
                    Initialize verifier key
                </button>
                <button className={styles.button} onClick={handleAirdrop} disabled={!publicKey || busy}>
                    Airdrop SOL
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
