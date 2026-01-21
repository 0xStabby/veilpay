import { PublicKey } from "@solana/web3.js";
import { bytesToBigIntBE, modField, randomBytes, toHex } from "./crypto";
import { computeIdentityCommitment } from "./prover";
import { buildMerkleTree, getMerklePath } from "./merkle";

const identitySecretKey = (owner: PublicKey, programId: PublicKey) =>
  `veilpay.identity-secret.${programId.toBase58()}.${owner.toBase58()}`;
const identityIndexKey = (owner: PublicKey, programId: PublicKey) =>
  `veilpay.identity-index.${programId.toBase58()}.${owner.toBase58()}`;
const identityCommitmentsKey = (programId: PublicKey) =>
  `veilpay.identity-commitments.${programId.toBase58()}`;

const fromHex = (value: string) => {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export async function getOrCreateIdentitySecret(
  owner: PublicKey,
  programId: PublicKey
): Promise<bigint> {
  const key = identitySecretKey(owner, programId);
  const stored = localStorage.getItem(key);
  if (stored) {
    return modField(bytesToBigIntBE(fromHex(stored)));
  }
  const secretBytes = randomBytes(32);
  localStorage.setItem(key, toHex(secretBytes));
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

export function setIdentityLeafIndex(
  owner: PublicKey,
  programId: PublicKey,
  index: number
) {
  localStorage.setItem(identityIndexKey(owner, programId), index.toString());
}

export async function getIdentityCommitment(
  owner: PublicKey,
  programId: PublicKey
): Promise<bigint> {
  const secret = await getOrCreateIdentitySecret(owner, programId);
  return computeIdentityCommitment(secret);
}

export async function ensureIdentityCommitment(
  owner: PublicKey,
  programId: PublicKey
): Promise<{ commitment: bigint; index: number }> {
  const commitment = await getIdentityCommitment(owner, programId);
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
  programId: PublicKey
): Promise<{ root: bigint; pathElements: bigint[]; pathIndices: number[]; leafIndex: number }> {
  const { commitment, index } = await ensureIdentityCommitment(owner, programId);
  const commitments = loadIdentityCommitments(programId);
  const { root, pathElements, pathIndices } = await getMerklePath(
    commitments,
    index
  );
  return { root, pathElements, pathIndices, leafIndex: index };
}

export async function buildIdentityRoot(programId: PublicKey): Promise<bigint> {
  const commitments = loadIdentityCommitments(programId);
  const { root } = await buildMerkleTree(commitments);
  return root;
}
