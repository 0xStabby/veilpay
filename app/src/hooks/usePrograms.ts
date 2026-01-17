import { useMemo } from 'react';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { useAnchorWallet, useConnection } from '@solana/wallet-adapter-react';
import veilpayIdl from '../idl/veilpay.json';
import verifierIdl from '../idl/verifier.json';
import { VEILPAY_PROGRAM_ID, VERIFIER_PROGRAM_ID } from '../lib/config';

const normalizeIdl = (idl: any) => {
    if (!idl || !Array.isArray(idl.accounts) || !Array.isArray(idl.types)) {
        return idl;
    }
    const typeMap = new Map<string, any>(idl.types.map((entry: any) => [entry.name, entry.type]));
    const accounts = idl.accounts
        .map((account: any) => {
            if (account.type) return account;
            const type = typeMap.get(account.name);
            return type ? { ...account, type } : null;
        })
        .filter(Boolean);
    return { ...idl, accounts };
};

export function usePrograms() {
    const { connection } = useConnection();
    const wallet = useAnchorWallet();

    const provider = useMemo(() => {
        if (!wallet) return null;
        return new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    }, [connection, wallet]);

    const veilpayProgram = useMemo(() => {
        if (!provider) return null;
        return new Program(normalizeIdl(veilpayIdl) as any, provider);
    }, [provider]);

    const verifierProgram = useMemo(() => {
        if (!provider) return null;
        return new Program(normalizeIdl(verifierIdl) as any, provider);
    }, [provider]);

    return {
        connection,
        wallet,
        provider,
        veilpayProgram,
        verifierProgram,
    };
}
