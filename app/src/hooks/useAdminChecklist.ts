import { useEffect, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress, getMint } from '@solana/spl-token';
import { Program } from '@coral-xyz/anchor';
import { deriveConfig, deriveNullifierSet, deriveShielded, deriveVault, deriveVkRegistry, deriveVerifierKey } from '../lib/pda';
import { VEILPAY_PROGRAM_ID, VERIFIER_PROGRAM_ID } from '../lib/config';

type ChecklistItem = {
    id: string;
    label: string;
    done: boolean;
    detail?: string;
};

type ChecklistState = {
    loading: boolean;
    items: ChecklistItem[];
};

export function useAdminChecklist(params: {
    connection: Connection | null;
    veilpayProgram: Program | null;
    verifierProgram: Program | null;
    mintAddress: string;
}): ChecklistState {
    const { connection, veilpayProgram, verifierProgram, mintAddress } = params;
    const [state, setState] = useState<ChecklistState>({ loading: true, items: [] });

    useEffect(() => {
        let active = true;
        const run = async () => {
            if (!connection) {
                setState({ loading: false, items: [] });
                return;
            }
            const items: ChecklistItem[] = [];

            const rpcOk = await connection
                .getLatestBlockhash()
                .then(() => true)
                .catch(() => false);
            const veilpayProgramOk = await connection
                .getAccountInfo(VEILPAY_PROGRAM_ID)
                .then((info) => !!info)
                .catch(() => false);
            const verifierProgramOk = await connection
                .getAccountInfo(VERIFIER_PROGRAM_ID)
                .then((info) => !!info)
                .catch(() => false);

            items.push({
                id: 'localnet',
                label: 'Run `anchor localnet` (RPC + programs deployed)',
                done: rpcOk && veilpayProgramOk && verifierProgramOk,
            });

            let fundedOk = false;
            const wallet = veilpayProgram?.provider?.wallet;
            if (veilpayProgram && wallet) {
                try {
                    const balance = await connection.getBalance(wallet.publicKey);
                    fundedOk = balance >= 0.5 * 1e9;
                } catch {
                    fundedOk = false;
                }
            }
            items.push({
                id: 'funded',
                label: 'Fund admin wallet (airdrop SOL)',
                done: fundedOk,
            });

            const configPda = veilpayProgram ? deriveConfig(veilpayProgram.programId) : null;
            const configOk = configPda
                ? await connection.getAccountInfo(configPda).then((info) => !!info).catch(() => false)
                : false;
            items.push({
                id: 'config',
                label: 'Initialize config',
                done: configOk,
            });

            const vkRegistryPda = veilpayProgram ? deriveVkRegistry(veilpayProgram.programId) : null;
            const vkRegistryOk = vkRegistryPda
                ? await connection.getAccountInfo(vkRegistryPda).then((info) => !!info).catch(() => false)
                : false;
            items.push({
                id: 'vk-registry',
                label: 'Initialize VK registry',
                done: vkRegistryOk,
            });

            const verifierKeyPda = verifierProgram ? deriveVerifierKey(verifierProgram.programId, 0) : null;
            const verifierKeyOk = verifierKeyPda
                ? await connection.getAccountInfo(verifierKeyPda).then((info) => !!info).catch(() => false)
                : false;
            items.push({
                id: 'verifier-key',
                label: 'Initialize verifier key',
                done: verifierKeyOk,
            });

            let mintKey: PublicKey | null = null;
            if (mintAddress) {
                try {
                    mintKey = new PublicKey(mintAddress);
                } catch {
                    mintKey = null;
                }
            }

            const mintOk = mintKey
                ? await getMint(connection, mintKey).then(() => true).catch(() => false)
                : false;
            items.push({
                id: 'mint',
                label: 'Create mint',
                done: mintOk,
            });

            let registeredOk = false;
            if (mintKey && veilpayProgram && configPda) {
                try {
                    const config = await (veilpayProgram.account as any).config.fetch(configPda);
                    registeredOk = config.mintAllowlist.some((entry: PublicKey) => entry.equals(mintKey));
                } catch {
                    registeredOk = false;
                }
            }
            items.push({
                id: 'register-mint',
                label: 'Register mint',
                done: registeredOk,
            });

            const vaultOk = mintKey && veilpayProgram
                ? await connection.getAccountInfo(deriveVault(veilpayProgram.programId, mintKey)).then((info) => !!info).catch(() => false)
                : false;
            const shieldedOk = mintKey && veilpayProgram
                ? await connection.getAccountInfo(deriveShielded(veilpayProgram.programId, mintKey)).then((info) => !!info).catch(() => false)
                : false;
            const nullifierOk = mintKey && veilpayProgram
                ? await connection.getAccountInfo(deriveNullifierSet(veilpayProgram.programId, mintKey, 0)).then((info) => !!info).catch(() => false)
                : false;
            items.push({
                id: 'mint-state',
                label: 'Initialize mint state',
                done: vaultOk && shieldedOk && nullifierOk,
            });

            let mintedOk = false;
            if (mintKey && veilpayProgram && wallet) {
                try {
                    const ata = await getAssociatedTokenAddress(mintKey, wallet.publicKey);
                    const account = await getAccount(connection, ata);
                    mintedOk = account.amount > 0n;
                } catch {
                    mintedOk = false;
                }
            }
            items.push({
                id: 'mint-to',
                label: 'Mint tokens to wallet',
                done: mintedOk,
            });

            if (active) {
                setState({ loading: false, items });
            }
        };
        run();
        const timer = setInterval(run, 5000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [connection, veilpayProgram, verifierProgram, mintAddress]);

    return state;
}
