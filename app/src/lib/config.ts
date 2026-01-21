import { PublicKey } from '@solana/web3.js';

const envString = (key: string) => {
    const value = import.meta.env[key] as string | undefined;
    if (!value || value.trim() === '') {
        throw new Error(`Missing required env: ${key}`);
    }
    return value;
};

export const LOCALNET_RPC = envString('VITE_RPC_ENDPOINT');
export const RELAYER_URL = envString('VITE_RELAYER_URL');
export const AIRDROP_URL = (import.meta.env.VITE_AIRDROP_URL as string | undefined) ?? '';
export const IS_DEVNET = /devnet/i.test(LOCALNET_RPC);
export const RELAYER_TRUSTED = (import.meta.env.VITE_RELAYER_TRUSTED as string | undefined) === 'true';
export const LUT_ADDRESS = (import.meta.env.VITE_LUT_ADDRESS as string | undefined) ?? '';

export const VEILPAY_PROGRAM_ID = new PublicKey(envString('VITE_VEILPAY_PROGRAM_ID'));
export const VERIFIER_PROGRAM_ID = new PublicKey(envString('VITE_VERIFIER_PROGRAM_ID'));
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
