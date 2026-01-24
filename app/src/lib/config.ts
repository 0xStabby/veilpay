import { PublicKey } from '@solana/web3.js';

const envString = (key: string) => {
    const value = import.meta.env[key] as string | undefined;
    if (!value || value.trim() === '') {
        throw new Error(`Missing required env: ${key}`);
    }
    return value;
};

const envNumber = (key: string, fallback?: number) => {
    const raw = (import.meta.env[key] as string | undefined)?.trim();
    if (!raw) {
        if (fallback !== undefined) {
            return fallback;
        }
        throw new Error(`Missing required env: ${key}`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`Invalid numeric env: ${key}`);
    }
    return value;
};

export const LOCALNET_RPC = envString('VITE_RPC_ENDPOINT');
export const RELAYER_URL = envString('VITE_RELAYER_URL');
export const AIRDROP_URL = (import.meta.env.VITE_AIRDROP_URL as string | undefined) ?? '';
export const IS_DEVNET = /devnet/i.test(LOCALNET_RPC);
export const LUT_ADDRESS = (import.meta.env.VITE_LUT_ADDRESS as string | undefined) ?? '';
const relayerPubkey = (import.meta.env.VITE_RELAYER_PUBKEY as string | undefined)?.trim() ?? '';
export const RELAYER_PUBKEY = relayerPubkey ? new PublicKey(relayerPubkey) : null;
export const RELAYER_FEE_BPS = envNumber('VITE_RELAYER_FEE_BPS', 0);
export const NULLIFIER_PADDING_CHUNKS = envNumber('VITE_NULLIFIER_PADDING_CHUNKS', 0);
export const VIEW_KEY_SCAN_MAX_INDEX = envNumber('VITE_VIEW_KEY_SCAN_MAX_INDEX', 0);

export const VEILPAY_PROGRAM_ID = new PublicKey(envString('VITE_VEILPAY_PROGRAM_ID'));
export const VERIFIER_PROGRAM_ID = new PublicKey(envString('VITE_VERIFIER_PROGRAM_ID'));
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
