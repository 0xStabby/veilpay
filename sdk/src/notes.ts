import { buildBabyjub } from "circomlibjs";
import { PublicKey } from "@solana/web3.js";
import { bigIntToBytes32, bytesToBigIntBE, modField, randomBytes32, sha256 } from "./crypto";
import { poseidonHash } from "./poseidon";

export type Note = {
  id: string;
  mint: string;
  amount: bigint;
  randomness: bigint;
  recipientTagHash: bigint;
  recipientPubkeyX: bigint;
  recipientPubkeyY: bigint;
  commitment: bigint;
  senderSecret: bigint;
  c1x: bigint;
  c1y: bigint;
  c2Amount: bigint;
  c2Randomness: bigint;
  encRandomness: bigint;
  leafIndex: number;
};

export async function computeCommitment(
  amount: bigint,
  randomness: bigint,
  recipientTagHash: bigint
): Promise<bigint> {
  return poseidonHash([amount, randomness, recipientTagHash]);
}

export async function recipientTagHashFromSecret(secret: Uint8Array): Promise<bigint> {
  return modField(bytesToBigIntBE(sha256(secret)));
}

type BabyJubPoint = [bigint, bigint];

let babyjubPromise: Promise<Awaited<ReturnType<typeof buildBabyjub>>> | null = null;
const getBabyjub = async () => {
  if (!babyjubPromise) {
    babyjubPromise = buildBabyjub();
  }
  return babyjubPromise;
};

const pointToBigInt = (
  point: [unknown, unknown],
  babyjub: Awaited<ReturnType<typeof buildBabyjub>>
): BabyJubPoint => {
  const x = BigInt(babyjub.F.toObject(point[0]));
  const y = BigInt(babyjub.F.toObject(point[1]));
  return [x, y];
};

const pointFromBigInt = (
  point: BabyJubPoint,
  babyjub: Awaited<ReturnType<typeof buildBabyjub>>
): [unknown, unknown] => [babyjub.F.e(point[0]), babyjub.F.e(point[1])];

export async function deriveRecipientKeypair(secret: Uint8Array): Promise<{
  secretScalar: bigint;
  pubkey: BabyJubPoint;
}> {
  const babyjub = await getBabyjub();
  const secretScalar = modField(bytesToBigIntBE(secret)) % babyjub.subOrder;
  const safeSecret = secretScalar === 0n ? 1n : secretScalar;
  const pubkeyPoint = babyjub.mulPointEscalar(babyjub.Base8, safeSecret);
  return { secretScalar: safeSecret, pubkey: pointToBigInt(pubkeyPoint, babyjub) };
}

export async function eciesEncrypt(params: {
  recipientPubkey: BabyJubPoint;
  amount: bigint;
  randomness: bigint;
}): Promise<{
  ciphertext: Uint8Array;
  encRandomness: bigint;
  c1x: bigint;
  c1y: bigint;
  c2Amount: bigint;
  c2Randomness: bigint;
}> {
  const { recipientPubkey, amount, randomness } = params;
  const babyjub = await getBabyjub();
  const r = modField(bytesToBigIntBE(randomBytes32())) % babyjub.subOrder;
  const safeR = r === 0n ? 1n : r;
  const c1Point = babyjub.mulPointEscalar(babyjub.Base8, safeR);
  const c1 = pointToBigInt(c1Point, babyjub);
  const sharedPoint = babyjub.mulPointEscalar(pointFromBigInt(recipientPubkey, babyjub), safeR);
  const [sharedX, sharedY] = pointToBigInt(sharedPoint, babyjub);
  const maskAmount = await poseidonHash([sharedX, sharedY, 0n]);
  const maskRandomness = await poseidonHash([sharedX, sharedY, 1n]);
  const c2Amount = modField(amount + maskAmount);
  const c2Randomness = modField(randomness + maskRandomness);
  const ciphertext = new Uint8Array(128);
  ciphertext.set(bigIntToBytes32(c1[0]), 0);
  ciphertext.set(bigIntToBytes32(c1[1]), 32);
  ciphertext.set(bigIntToBytes32(c2Amount), 64);
  ciphertext.set(bigIntToBytes32(c2Randomness), 96);
  return {
    ciphertext,
    encRandomness: safeR,
    c1x: c1[0],
    c1y: c1[1],
    c2Amount,
    c2Randomness,
  };
}

export async function eciesDecrypt(params: {
  recipientSecret: bigint;
  c1x: bigint;
  c1y: bigint;
  c2Amount: bigint;
  c2Randomness: bigint;
}): Promise<{ amount: bigint; randomness: bigint }> {
  const { recipientSecret, c1x, c1y, c2Amount, c2Randomness } = params;
  const babyjub = await getBabyjub();
  const sharedPoint = babyjub.mulPointEscalar(pointFromBigInt([c1x, c1y], babyjub), recipientSecret);
  const [sharedX, sharedY] = pointToBigInt(sharedPoint, babyjub);
  const maskAmount = await poseidonHash([sharedX, sharedY, 0n]);
  const maskRandomness = await poseidonHash([sharedX, sharedY, 1n]);
  const amount = modField(c2Amount - maskAmount);
  const randomness = modField(c2Randomness - maskRandomness);
  return { amount, randomness };
}

export async function createNote(params: {
  mint: PublicKey;
  amount: bigint;
  recipientTagSecret: Uint8Array;
  leafIndex: number;
}): Promise<{ note: Note; plaintext: Uint8Array }> {
  const { mint, amount, recipientTagSecret, leafIndex } = params;
  const randomness = modField(bytesToBigIntBE(randomBytes32()));
  const senderSecret = modField(bytesToBigIntBE(randomBytes32()));
  const tagHash = await recipientTagHashFromSecret(recipientTagSecret);
  const commitment = await computeCommitment(amount, randomness, tagHash);
  const { pubkey } = await deriveRecipientKeypair(recipientTagSecret);
  const encryption = await eciesEncrypt({ recipientPubkey: pubkey, amount, randomness });

  const note: Note = {
    id: `${mint.toBase58()}:${leafIndex}`,
    mint: mint.toBase58(),
    amount,
    randomness,
    recipientTagHash: tagHash,
    recipientPubkeyX: pubkey[0],
    recipientPubkeyY: pubkey[1],
    commitment,
    senderSecret,
    c1x: encryption.c1x,
    c1y: encryption.c1y,
    c2Amount: encryption.c2Amount,
    c2Randomness: encryption.c2Randomness,
    encRandomness: encryption.encRandomness,
    leafIndex,
  };

  return { note, plaintext: encryption.ciphertext };
}
