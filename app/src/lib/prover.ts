import * as snarkjs from 'snarkjs';
import { buildPoseidon } from 'circomlibjs';

export type ProofResult = {
    proofBytes: Uint8Array;
    publicInputsBytes: Uint8Array;
    publicSignals: string[];
    proof: unknown;
};

let poseidonPromise: Promise<ReturnType<typeof buildPoseidon>> | null = null;
let vkeyPromise: Promise<unknown> | null = null;

async function getPoseidon() {
    if (!poseidonPromise) {
        poseidonPromise = buildPoseidon();
    }
    return poseidonPromise;
}

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
    const poseidon = await getPoseidon();
    const hash = poseidon(inputs.map((value) => BigInt(value)));
    return BigInt(poseidon.F.toString(hash));
}

export async function computeNullifier(senderSecret: bigint, leafIndex: bigint): Promise<bigint> {
    return await poseidonHash([senderSecret, leafIndex]);
}

export async function computeCommitment(
    amount: bigint,
    randomness: bigint,
    recipientTagHash: bigint
): Promise<bigint> {
    return await poseidonHash([amount, randomness, recipientTagHash]);
}

export async function computeIdentityCommitment(identitySecret: bigint): Promise<bigint> {
    return await poseidonHash([identitySecret]);
}

export const bigIntToBytes32 = (value: bigint): Uint8Array => {
    let hex = value.toString(16);
    if (hex.length > 64) {
        throw new Error('Value exceeds 32 bytes');
    }
    hex = hex.padStart(64, '0');
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
};

async function getVerificationKey(): Promise<unknown> {
    if (!vkeyPromise) {
        vkeyPromise = fetch('/prover/verification_key.json').then(async (response) => {
            if (!response.ok) {
                throw new Error(`Failed to load verification key: ${response.status}`);
            }
            return response.json();
        });
    }
    return vkeyPromise;
}

export async function preflightVerify(
    proof: unknown,
    publicSignals: string[],
    timeoutMs = 8000
): Promise<boolean> {
    const vkey = await getVerificationKey();
    const verifyPromise = snarkjs.groth16.verify(vkey, publicSignals, proof);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return verifyPromise;
    }
    return await Promise.race([
        verifyPromise,
        new Promise<boolean>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Preflight verify timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }),
    ]);
}

export function formatPublicSignals(publicSignals: string[]): string {
    const labels = [
        'root',
        'identity_root',
        'nullifier_0',
        'nullifier_1',
        'nullifier_2',
        'nullifier_3',
        'output_commitment_0',
        'output_commitment_1',
        'output_enabled_0',
        'output_enabled_1',
        'amount_out',
        'fee_amount',
        'circuit_id',
    ];
    return labels
        .map((label, index) => `${label}=${publicSignals[index] ?? ''}`)
        .join(' ');
}

const concatBytes = (chunks: Uint8Array[]): Uint8Array => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
};

const toBigIntFromCallData = (value: string): bigint => {
    const trimmed = value.trim();
    if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
        return BigInt(trimmed);
    }
    return BigInt(trimmed);
};

export async function generateProof(input: Record<string, string | number>): Promise<ProofResult> {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input,
        '/prover/veilpay.wasm',
        '/prover/veilpay.zkey'
    );
    const publicSignalsArray = publicSignals as string[];

    const callData = await snarkjs.groth16.exportSolidityCallData(proof, publicSignalsArray);
    const argv = callData.replace(/["[\]\s]/g, '').split(',').filter(Boolean);
    if (argv.length < 8) {
        throw new Error('Unexpected calldata length from snarkjs.');
    }
    const a = [toBigIntFromCallData(argv[0]), toBigIntFromCallData(argv[1])];
    const b = [
        [toBigIntFromCallData(argv[2]), toBigIntFromCallData(argv[3])],
        [toBigIntFromCallData(argv[4]), toBigIntFromCallData(argv[5])],
    ];
    const c = [toBigIntFromCallData(argv[6]), toBigIntFromCallData(argv[7])];

    // Use Solidity calldata ordering to avoid Fq2 ordering mismatches.
    const proofBytes = concatBytes([
        bigIntToBytes32(a[0]),
        bigIntToBytes32(a[1]),
        bigIntToBytes32(b[0][0]),
        bigIntToBytes32(b[0][1]),
        bigIntToBytes32(b[1][0]),
        bigIntToBytes32(b[1][1]),
        bigIntToBytes32(c[0]),
        bigIntToBytes32(c[1]),
    ]);

    const publicInputsBytes = concatBytes(
        argv.slice(8).map((value: string) => bigIntToBytes32(toBigIntFromCallData(value)))
    );

    return {
        proofBytes,
        publicInputsBytes,
        publicSignals: publicSignalsArray,
        proof,
    };
}
