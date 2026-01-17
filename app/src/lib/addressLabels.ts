import {
    PublicKey,
    SystemProgram,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_EPOCH_SCHEDULE_PUBKEY,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    SYSVAR_SLOT_HASHES_PUBKEY,
    SYSVAR_STAKE_HISTORY_PUBKEY,
} from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { deriveConfig, deriveNullifierSet, deriveShielded, deriveVault, deriveVerifierKey, deriveVkRegistry } from './pda';
import { VEILPAY_PROGRAM_ID, VERIFIER_PROGRAM_ID } from './config';

type BuildAddressLabelsInput = {
    mintAddress?: string;
    veilpayProgramId?: PublicKey | null;
    verifierProgramId?: PublicKey | null;
    walletLabels?: Record<string, string>;
    connectedWallet?: string | null;
};

export function buildAddressLabels({
    mintAddress,
    veilpayProgramId,
    verifierProgramId,
    walletLabels = {},
    connectedWallet,
}: BuildAddressLabelsInput): Record<string, string> {
    const labels: Record<string, string> = { ...walletLabels };

    const add = (key: PublicKey | string | null | undefined, label: string) => {
        if (!key) return;
        const value = typeof key === 'string' ? key : key.toBase58();
        if (!labels[value]) {
            labels[value] = label;
        }
    };

    const veilpayId = veilpayProgramId ?? VEILPAY_PROGRAM_ID;
    const verifierId = verifierProgramId ?? VERIFIER_PROGRAM_ID;

    add(veilpayId, 'Veilpay Program');
    add(verifierId, 'Verifier Program');
    add(SystemProgram.programId, 'System Program');
    add(TOKEN_PROGRAM_ID, 'SPL Token Program');
    add(ASSOCIATED_TOKEN_PROGRAM_ID, 'Associated Token Program');
    add(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), 'Token-2022 Program');
    add(new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), 'Memo Program');
    add(new PublicKey('ComputeBudget111111111111111111111111111111'), 'Compute Budget Program');
    add(new PublicKey('AddressLookupTab1e1111111111111111111111111'), 'Address Lookup Table Program');
    add(new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), 'BPF Loader Upgradeable');
    add(new PublicKey('BPFLoader1111111111111111111111111111111111'), 'BPF Loader');
    add(new PublicKey('Ed25519SigVerify111111111111111111111111111'), 'Ed25519 Verify Program');
    add(new PublicKey('KeccakSecp256k11111111111111111111111111111'), 'Secp256k1 Verify Program');
    add(SYSVAR_RENT_PUBKEY, 'Sysvar: Rent');
    add(SYSVAR_CLOCK_PUBKEY, 'Sysvar: Clock');
    add(SYSVAR_INSTRUCTIONS_PUBKEY, 'Sysvar: Instructions');
    add(SYSVAR_EPOCH_SCHEDULE_PUBKEY, 'Sysvar: Epoch Schedule');
    add(SYSVAR_SLOT_HASHES_PUBKEY, 'Sysvar: Slot Hashes');
    add(SYSVAR_STAKE_HISTORY_PUBKEY, 'Sysvar: Stake History');

    if (connectedWallet) {
        add(connectedWallet, labels[connectedWallet] ?? 'Connected Wallet');
    }

    let mint: PublicKey | null = null;
    if (mintAddress) {
        try {
            mint = new PublicKey(mintAddress);
            add(mint, 'Test Mint');
        } catch {
            mint = null;
        }
    }

    if (mint) {
        add(deriveConfig(veilpayId), 'Config PDA');
        add(deriveVkRegistry(veilpayId), 'VK Registry PDA');
        add(deriveVault(veilpayId, mint), 'Vault PDA');
        add(deriveShielded(veilpayId, mint), 'Shielded State PDA');
        for (let chunk = 0; chunk <= 7; chunk += 1) {
            add(deriveNullifierSet(veilpayId, mint, chunk), `Nullifier Set PDA (${chunk})`);
        }
    }

    if (verifierId) {
        add(deriveVerifierKey(verifierId, 0), 'Verifier Key PDA (0)');
    }

    if (mint) {
        add(new PublicKey('So11111111111111111111111111111111111111112'), 'Native SOL Mint');
        Object.entries(walletLabels).forEach(([pubkey, label]) => {
            try {
                const owner = new PublicKey(pubkey);
                const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
                add(ata, `${label} ATA`);
            } catch {
                return;
            }
        });

        if (connectedWallet) {
            try {
                const owner = new PublicKey(connectedWallet);
                const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
                add(ata, 'Connected Wallet ATA');
            } catch {
                // ignore
            }
        }
    }

    return labels;
}
