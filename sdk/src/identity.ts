import { PublicKey } from "@solana/web3.js";
import { bytesToBigIntBE, modField, randomBytes, sha256, toHex } from "./crypto";
import { computeIdentityCommitment } from "./prover";
import { buildMerkleTree, getMerklePath } from "./merkle";

const identitySecretKey = (owner: PublicKey, programId: PublicKey) =>
  `veilpay.identity-secret.${programId.toBase58()}.${owner.toBase58()}`;
const identityIndexKey = (owner: PublicKey, programId: PublicKey) =>
  `veilpay.identity-index.${programId.toBase58()}.${owner.toBase58()}`;
const identityCommitmentsKey = (programId: PublicKey) =>
  `veilpay.identity-commitments.${programId.toBase58()}`;
const identityMessage = (owner: PublicKey, programId: PublicKey) =>
  `VeilPay:identity:${programId.toBase58()}:${owner.toBase58()}`;

const fromHex = (value: string) => {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export function loadIdentitySecret(owner: PublicKey, programId: PublicKey): Uint8Array | null {
  try {
    const stored = localStorage.getItem(identitySecretKey(owner, programId));
    if (!stored) return null;
    return fromHex(stored);
  } catch {
    return null;
  }
}

export async function restoreIdentitySecret(
  owner: PublicKey,
  programId: PublicKey,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<Uint8Array> {
  const message = new TextEncoder().encode(identityMessage(owner, programId));
  const signature = await signMessage(message);
  const secret = await sha256(signature);
  localStorage.setItem(identitySecretKey(owner, programId), toHex(secret));
  return secret;
}

export async function getOrCreateIdentitySecret(
  owner: PublicKey,
  programId: PublicKey,
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>
): Promise<bigint> {
  const stored = loadIdentitySecret(owner, programId);
  if (stored) {
    return modField(bytesToBigIntBE(stored));
  }
  if (signMessage) {
    const secret = await restoreIdentitySecret(owner, programId, signMessage);
    return modField(bytesToBigIntBE(secret));
  }
  const secretBytes = randomBytes(32);
  localStorage.setItem(identitySecretKey(owner, programId), toHex(secretBytes));
  return modField(bytesToBigIntBE(secretBytes));
}

export function loadIdentityCommitments(programId: PublicKey): bigint[] {
  try {
    const raw = localStorage.getItem(identityCommitmentsKey(programId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => BigInt(value));
  } catch {
    return [];
  }
}

export function saveIdentityCommitments(programId: PublicKey, commitments: bigint[]) {
  localStorage.setItem(
    identityCommitmentsKey(programId),
    JSON.stringify(commitments.map((value) => value.toString()))
  );
}

export function getIdentityLeafIndex(owner: PublicKey, programId: PublicKey): number | null {
  const raw = localStorage.getItem(identityIndexKey(owner, programId));
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function setIdentityLeafIndex(owner: PublicKey, programId: PublicKey, index: number) {
  localStorage.setItem(identityIndexKey(owner, programId), index.toString());
}

export async function getIdentityCommitment(
  owner: PublicKey,
  programId: PublicKey,
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>
): Promise<bigint> {
  const secret = await getOrCreateIdentitySecret(owner, programId, signMessage);
  return computeIdentityCommitment(secret);
}

export async function ensureIdentityCommitment(
  owner: PublicKey,
  programId: PublicKey,
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>
): Promise<{ commitment: bigint; index: number }> {
  const commitment = await getIdentityCommitment(owner, programId, signMessage);
  const existingIndex = getIdentityLeafIndex(owner, programId);
  if (existingIndex !== null) {
    return { commitment, index: existingIndex };
  }
  const commitments = loadIdentityCommitments(programId);
  const index = commitments.length;
  saveIdentityCommitments(programId, [...commitments, commitment]);
  setIdentityLeafIndex(owner, programId, index);
  return { commitment, index };
}

export async function getIdentityMerklePath(
  owner: PublicKey,
  programId: PublicKey,
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>
): Promise<{ root: bigint; pathElements: bigint[]; pathIndices: number[]; leafIndex: number }> {
  const { commitment, index } = await ensureIdentityCommitment(owner, programId, signMessage);
  const commitments = loadIdentityCommitments(programId);
  const { root, pathElements, pathIndices } = await getMerklePath(commitments, index);
  return { root, pathElements, pathIndices, leafIndex: index };
}

export async function buildIdentityRoot(programId: PublicKey): Promise<bigint> {
  const commitments = loadIdentityCommitments(programId);
  const { root } = await buildMerkleTree(commitments);
  return root;
}
