export const BN254_FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

export function modField(value: bigint): bigint {
  const mod = value % BN254_FIELD_MODULUS;
  return mod >= 0n ? mod : mod + BN254_FIELD_MODULUS;
}

export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }
  return value;
}

export function bigIntToBytes32(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length > 64) {
    throw new Error("Value exceeds 32 bytes");
  }
  hex = hex.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

declare const globalThis: any;

const webCrypto = globalThis?.crypto as
  | {
      getRandomValues?: (array: Uint8Array) => Uint8Array;
      subtle?: { digest: (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer> };
    }
  | undefined;

export function randomBytes(length: number): Uint8Array {
  if (!webCrypto?.getRandomValues) {
    throw new Error("Secure random source unavailable.");
  }
  const out = new Uint8Array(length);
  webCrypto.getRandomValues(out);
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  if (!webCrypto?.subtle) {
    throw new Error("WebCrypto unavailable.");
  }
  const normalized = new Uint8Array(data);
  const hash = await webCrypto.subtle.digest("SHA-256", normalized.buffer);
  return new Uint8Array(hash);
}

export function randomBytes32(): Uint8Array {
  return randomBytes(32);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
