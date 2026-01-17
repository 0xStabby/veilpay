import { PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
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
    add(SYSVAR_RENT_PUBKEY, 'Sysvar: Rent');
    add(SYSVAR_CLOCK_PUBKEY, 'Sysvar: Clock');

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
        add(deriveNullifierSet(veilpayId, mint, 0), 'Nullifier Set PDA (0)');
        add(deriveNullifierSet(veilpayId, mint, 1), 'Nullifier Set PDA (1)');
    }

    if (verifierId) {
        add(deriveVerifierKey(verifierId, 0), 'Verifier Key PDA (0)');
    }

    if (mint) {
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
