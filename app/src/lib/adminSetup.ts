import { Program } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
    MINT_SIZE,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createInitializeMintInstruction,
    createMintToInstruction,
    getAccount,
    getAssociatedTokenAddress,
} from '@solana/spl-token';
import { AIRDROP_URL } from './config';
import { deriveConfig, deriveNullifierSet, deriveShielded, deriveVault, deriveVkRegistry, deriveVerifierKey } from './pda';
import { verifierKeyFixture } from './fixtures';
import { parseTokenAmount } from './amount';

type StatusHandler = (message: string) => void;

type WalletContext = {
    publicKey: PublicKey;
    sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
};

async function ensureLegacyMint(connection: Connection, mint: PublicKey, onStatus: StatusHandler): Promise<boolean> {
    try {
        const info = await connection.getAccountInfo(mint);
        if (!info) {
            onStatus('Mint account not found.');
            return false;
        }
        if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
            onStatus('Mint is not a legacy SPL token. Token-2022 is not supported yet.');
            return false;
        }
        return true;
    } catch (error) {
        onStatus(`Mint check failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        return false;
    }
}

export async function airdropSol(params: {
    connection: Connection;
    publicKey: PublicKey;
    onStatus: StatusHandler;
}): Promise<boolean> {
    const { connection, publicKey, onStatus } = params;
    try {
        if (AIRDROP_URL) {
            onStatus('Open the faucet to fund your wallet.');
            window.open(AIRDROP_URL, '_blank', 'noopener,noreferrer');
            return true;
        }
        onStatus('Requesting airdrop...');
        const signature = await connection.requestAirdrop(publicKey, 2 * 1e9);
        await connection.confirmTransaction(signature, 'confirmed');
        onStatus('Airdrop complete.');
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onStatus(`Airdrop failed: ${message}`);
        return false;
    }
}

export async function initializeConfig(params: {
    program: Program;
    admin: PublicKey;
    onStatus: StatusHandler;
}): Promise<boolean> {
    const { program, admin, onStatus } = params;
    try {
        onStatus('Initializing config...');
        const config = deriveConfig(program.programId);
        const vkRegistry = deriveVkRegistry(program.programId);
        await program.methods
            .initializeConfig({
                feeBps: 25,
                relayerFeeBpsMax: 50,
                vkRegistry,
                mintAllowlist: [],
                circuitIds: [0],
            })
            .accounts({
                config,
                admin,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
        onStatus('Config initialized.');
        return true;
    } catch (error) {
        onStatus(`Config init failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        return false;
    }
}

export async function initializeVkRegistry(params: {
    program: Program;
    admin: PublicKey;
    onStatus: StatusHandler;
}): Promise<boolean> {
    const { program, admin, onStatus } = params;
    try {
        onStatus('Initializing VK registry...');
        const vkRegistry = deriveVkRegistry(program.programId);
        await program.methods
            .initializeVkRegistry()
            .accounts({
                vkRegistry,
                admin,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
        onStatus('VK registry initialized.');
        return true;
    } catch (error) {
        onStatus(`VK registry failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        return false;
    }
}

export async function initializeVerifierKey(params: {
    program: Program;
    admin: PublicKey;
    onStatus: StatusHandler;
}): Promise<boolean> {
    const { program, admin, onStatus } = params;
    try {
        onStatus('Writing Groth16 verifying key...');
        const keyId = 0;
        const verifierKey = deriveVerifierKey(program.programId, keyId);
        await program.methods
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
                admin,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
        onStatus('Verifier key stored.');
        return true;
    } catch (error) {
        onStatus(`Verifier key failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        return false;
    }
}

export async function createMint(params: {
    connection: Connection;
    wallet: WalletContext;
    decimals: number;
    onStatus: StatusHandler;
    onMintChange: (value: string) => void;
}): Promise<PublicKey | null> {
    const { connection, wallet, decimals, onStatus, onMintChange } = params;
    try {
        onStatus('Creating mint...');
        const mintKeypair = Keypair.generate();
        const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
        const tx = new Transaction().add(
            SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: mintKeypair.publicKey,
                lamports,
                space: MINT_SIZE,
                programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeMintInstruction(mintKeypair.publicKey, decimals, wallet.publicKey, null)
        );
        const { value } = await connection.getLatestBlockhashAndContext();
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = value.blockhash;
        tx.partialSign(mintKeypair);
        const signed = await wallet.signTransaction(tx);
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
        return mintKeypair.publicKey;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onStatus(`Mint create failed: ${message}`);
        return null;
    }
}

export async function registerMint(params: {
    program: Program;
    admin: PublicKey;
    mint: PublicKey;
    onStatus: StatusHandler;
    connection?: Connection;
}): Promise<boolean> {
    const { program, admin, mint, onStatus, connection } = params;
    try {
        if (connection) {
            const ok = await ensureLegacyMint(connection, mint, onStatus);
            if (!ok) return false;
        }
        onStatus('Registering mint...');
        const config = deriveConfig(program.programId);
        await program.methods
            .registerMint(mint)
            .accounts({
                config,
                admin,
            })
            .rpc();
        onStatus('Mint registered.');
        return true;
    } catch (error) {
        onStatus(`Register mint failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        return false;
    }
}

export async function initializeMintState(params: {
    program: Program;
    admin: PublicKey;
    mint: PublicKey;
    connection: Connection;
    sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>;
    onStatus: StatusHandler;
}): Promise<boolean> {
    const { program, admin, mint, connection, sendTransaction, onStatus } = params;
    try {
        const ok = await ensureLegacyMint(connection, mint, onStatus);
        if (!ok) return false;
        onStatus('Initializing mint state...');
        const config = deriveConfig(program.programId);
        const vault = deriveVault(program.programId, mint);
        const shieldedState = deriveShielded(program.programId, mint);
        const nullifierSet = deriveNullifierSet(program.programId, mint, 0);
        const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
        const userAta = await getAssociatedTokenAddress(mint, admin);

        const instructions: TransactionInstruction[] = [];
        const maybeCreateAta = async (ata: PublicKey, owner: PublicKey) => {
            try {
                await getAccount(connection, ata);
            } catch {
                instructions.push(createAssociatedTokenAccountInstruction(admin, ata, owner, mint));
            }
        };

        await maybeCreateAta(userAta, admin);
        await maybeCreateAta(vaultAta, vault);

        if (instructions.length > 0) {
            await sendTransaction(new Transaction().add(...instructions), connection);
        }

        await program.methods
            .initializeMintState(0)
            .accounts({
                config,
                vault,
                vaultAta,
                shieldedState,
                nullifierSet,
                admin,
                mint,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
        onStatus('Mint state initialized.');
        return true;
    } catch (error) {
        onStatus(`Mint state failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        return false;
    }
}

export async function mintToWallet(params: {
    connection: Connection;
    admin: PublicKey;
    mint: PublicKey;
    decimals: number;
    amount: string;
    sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>;
    onStatus: StatusHandler;
}): Promise<boolean> {
    const { connection, admin, mint, decimals, amount, sendTransaction, onStatus } = params;
    try {
        const ok = await ensureLegacyMint(connection, mint, onStatus);
        if (!ok) return false;
        onStatus('Minting tokens to wallet...');
        const ata = await getAssociatedTokenAddress(mint, admin);
        try {
            await getAccount(connection, ata);
        } catch {
            const createIx = createAssociatedTokenAccountInstruction(admin, ata, admin, mint);
            await sendTransaction(new Transaction().add(createIx), connection);
        }
        const baseUnits = parseTokenAmount(amount, decimals);
        const ix = createMintToInstruction(mint, ata, admin, baseUnits);
        await sendTransaction(new Transaction().add(ix), connection);
        onStatus('Minted tokens to wallet.');
        return true;
    } catch (error) {
        onStatus(`Mint-to failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        return false;
    }
}
