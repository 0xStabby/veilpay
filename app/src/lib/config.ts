import { PublicKey } from '@solana/web3.js';

const viteEnv = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
const runtimeEnv = (viteEnv ?? (process.env as Record<string, string | undefined>)) as Record<
    string,
    string | undefined
>;

const envString = (key: string) => {
    const value = runtimeEnv[key]?.trim();
    if (!value) {
        throw new Error(`Missing required env: ${key}`);
    }
    return value;
};

const envNumber = (key: string) => {
    const raw = runtimeEnv[key]?.trim();
    if (!raw) {
        throw new Error(`Missing required env: ${key}`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`Invalid numeric env: ${key}`);
    }
    return value;
};

const envFlag = (key: string) => {
    const raw = runtimeEnv[key]?.trim().toLowerCase();
    if (!raw) return false;
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

export const DEBUG = envFlag('DEBUG');
export const STATUS_LOG = envFlag('STATUS_LOG');

export const LOCALNET_RPC = envString('VITE_RPC_ENDPOINT');
export const RELAYER_URL = envString('VITE_RELAYER_URL');
export const IS_DEVNET = /devnet/i.test(LOCALNET_RPC);
export const AIRDROP_URL = runtimeEnv.VITE_AIRDROP_URL?.trim() || '';
if (IS_DEVNET && !AIRDROP_URL) {
    throw new Error('Missing required env: VITE_AIRDROP_URL');
}
export const LUT_ADDRESS = envString('VITE_LUT_ADDRESS');
const relayerPubkey = envString('VITE_RELAYER_PUBKEY');
export const RELAYER_PUBKEY = relayerPubkey ? new PublicKey(relayerPubkey) : null;
export const RELAYER_FEE_BPS = envNumber('VITE_RELAYER_FEE_BPS');
export const NULLIFIER_PADDING_CHUNKS = envNumber('VITE_NULLIFIER_PADDING_CHUNKS');
export const VIEW_KEY_SCAN_MAX_INDEX = envNumber('VITE_VIEW_KEY_SCAN_MAX_INDEX');

export const VEILPAY_PROGRAM_ID = new PublicKey(envString('VITE_VEILPAY_PROGRAM_ID'));
export const VERIFIER_PROGRAM_ID = new PublicKey(envString('VITE_VERIFIER_PROGRAM_ID'));
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
