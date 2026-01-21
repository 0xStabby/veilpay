import { Program } from '@coral-xyz/anchor';
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    getAccount,
    getAssociatedTokenAddress,
    getMint,
} from '@solana/spl-token';
import { AIRDROP_URL } from './config';
import {
    deriveConfig,
    deriveIdentityRegistry,
    deriveNullifierSet,
    deriveShielded,
    deriveVault,
    deriveVkRegistry,
    deriveVerifierKey,
} from './pda';
import { verifierKeyFixture } from './fixtures';
import { parseTokenAmount } from './amount';

type StatusHandler = (message: string) => void;

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

export async function initializeIdentityRegistry(params: {
    program: Program;
    admin: PublicKey;
    onStatus: StatusHandler;
}): Promise<boolean> {
    const { program, admin, onStatus } = params;
    try {
        onStatus('Initializing identity registry...');
        const identityRegistry = deriveIdentityRegistry(program.programId);
        await program.methods
            .initializeIdentityRegistry()
            .accounts({
                identityRegistry,
                admin,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
        onStatus('Identity registry initialized.');
        return true;
    } catch (error) {
        onStatus(`Identity registry failed: ${error instanceof Error ? error.message : 'unknown error'}`);
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

export async function wrapSolToWsol(params: {
    connection: Connection;
    admin: PublicKey;
    amount: string;
    sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>;
    onStatus: StatusHandler;
}): Promise<boolean> {
    const { connection, admin, amount, sendTransaction, onStatus } = params;
    try {
        const mintInfo = await getMint(connection, NATIVE_MINT);
        const decimals = mintInfo.decimals;
        const lamports = parseTokenAmount(amount, decimals);
        if (lamports <= 0n) {
            onStatus('Wrap amount must be greater than zero.');
            return false;
        }
        if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
            onStatus('Wrap amount is too large.');
            return false;
        }

        const ata = await getAssociatedTokenAddress(NATIVE_MINT, admin);
        const instructions: TransactionInstruction[] = [];
        try {
            await getAccount(connection, ata);
        } catch {
            instructions.push(createAssociatedTokenAccountInstruction(admin, ata, admin, NATIVE_MINT));
        }
        instructions.push(
            SystemProgram.transfer({ fromPubkey: admin, toPubkey: ata, lamports: Number(lamports) }),
            createSyncNativeInstruction(ata)
        );

        await sendTransaction(new Transaction().add(...instructions), connection);
        onStatus('Wrapped SOL into WSOL.');
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        onStatus(`Wrap SOL failed: ${message}`);
        return false;
    }
}
