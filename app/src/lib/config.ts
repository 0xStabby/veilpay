import { PublicKey } from '@solana/web3.js';

const envString = (key: string, fallback: string) => {
    const value = import.meta.env[key] as string | undefined;
    if (value !== undefined && value.trim() !== '') {
        return value;
    }
    return fallback;
};

export const LOCALNET_RPC = envString('VITE_RPC_ENDPOINT', 'http://127.0.0.1:8899');
export const RELAYER_URL = envString('VITE_RELAYER_URL', 'http://localhost:8080');
export const AIRDROP_URL = envString('VITE_AIRDROP_URL', '');

export const VEILPAY_PROGRAM_ID = new PublicKey(
    envString('VITE_VEILPAY_PROGRAM_ID', '5UZKEwp4Mqkzxk6wxriy1ejK3bJsuKRVfkRxg37SG2tq')
);
export const VERIFIER_PROGRAM_ID = new PublicKey(
    envString('VITE_VERIFIER_PROGRAM_ID', 'HKDjg9uodQ8qDi9YJA82bYHRdYDxUm7ii59k5ua5UHxe')
);
