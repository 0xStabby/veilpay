import { Program } from '@coral-xyz/anchor';
import { deriveVerifierKey } from './pda';
import { verifierKeyFixture } from './fixtures';
import { VERIFIER_PROGRAM_ID } from './config';

const toBytes = (value: Uint8Array | number[]) => Uint8Array.from(value);

const bytesEqual = (a: Uint8Array | number[], b: Uint8Array) => {
    const aa = toBytes(a);
    if (aa.length !== b.length) return false;
    for (let i = 0; i < aa.length; i += 1) {
        if (aa[i] !== b[i]) return false;
    }
    return true;
};

export async function checkVerifierKeyMatch(program: Program, keyId = 0): Promise<{ ok: boolean; mismatch?: string }> {
    const verifierKey = deriveVerifierKey(VERIFIER_PROGRAM_ID, keyId);
    const account = await program.account.verifierKey.fetch(verifierKey);

    const mismatches: string[] = [];
    if (!bytesEqual(account.alphaG1 as number[], verifierKeyFixture.alphaG1)) mismatches.push('alpha_g1');
    if (!bytesEqual(account.betaG2 as number[], verifierKeyFixture.betaG2)) mismatches.push('beta_g2');
    if (!bytesEqual(account.gammaG2 as number[], verifierKeyFixture.gammaG2)) mismatches.push('gamma_g2');
    if (!bytesEqual(account.deltaG2 as number[], verifierKeyFixture.deltaG2)) mismatches.push('delta_g2');

    const gammaAbc = (account.gammaAbc as Array<number[]>) ?? [];
    if (gammaAbc.length !== verifierKeyFixture.gammaAbc.length) {
        mismatches.push(`gamma_abc_len=${gammaAbc.length}`);
    } else {
        gammaAbc.forEach((entry, idx) => {
            if (!bytesEqual(entry, verifierKeyFixture.gammaAbc[idx])) {
                mismatches.push(`gamma_abc[${idx}]`);
            }
        });
    }

    return mismatches.length === 0 ? { ok: true } : { ok: false, mismatch: mismatches.join(', ') };
}
