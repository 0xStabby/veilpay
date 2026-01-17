import verifierKey from '../fixtures/verifier_key.json';

const hexToBytes = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
};

export const verifierKeyFixture = {
    alphaG1: hexToBytes(verifierKey.alpha_g1),
    betaG2: hexToBytes(verifierKey.beta_g2),
    gammaG2: hexToBytes(verifierKey.gamma_g2),
    deltaG2: hexToBytes(verifierKey.delta_g2),
    gammaAbc: verifierKey.gamma_abc.map((entry) => hexToBytes(entry)),
};
