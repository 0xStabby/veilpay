import { createHash, randomBytes } from "crypto";

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

export function sha256(data: Uint8Array): Uint8Array {
  const hash = createHash("sha256");
  hash.update(data);
  return new Uint8Array(hash.digest());
}

export function randomBytes32(): Uint8Array {
  return randomBytes(32);
}
