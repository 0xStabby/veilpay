import { buildBabyjub } from 'circomlibjs';
import { PublicKey } from '@solana/web3.js';
import { bytesToBigIntBE, modField, randomBytes, sha256 } from './crypto';
import { bigIntToBytes32, computeCommitment, poseidonHash } from './prover';

export type NoteRecord = {
    id: string;
    mint: string;
    amount: string;
    randomness: string;
    recipientTagHash: string;
    commitment: string;
    senderSecret: string;
    c1x: string;
    c1y: string;
    c2Amount: string;
    c2Randomness: string;
    encRandomness: string;
    leafIndex: number;
    spent: boolean;
};

const notesKey = (mint: PublicKey) => `veilpay.notes.${mint.toBase58()}`;
const recipientKey = (owner: PublicKey) => `veilpay.recipient-secret.${owner.toBase58()}`;

type BabyJubPoint = [bigint, bigint];

let babyjubPromise: Promise<Awaited<ReturnType<typeof buildBabyjub>>> | null = null;
const getBabyjub = async () => {
    if (!babyjubPromise) {
        babyjubPromise = buildBabyjub();
    }
    return babyjubPromise;
};

const pointToBigInt = (point: [unknown, unknown], babyjub: Awaited<ReturnType<typeof buildBabyjub>>): BabyJubPoint => {
    const x = BigInt(babyjub.F.toObject(point[0]));
    const y = BigInt(babyjub.F.toObject(point[1]));
    return [x, y];
};

const pointFromBigInt = (
    point: BabyJubPoint,
    babyjub: Awaited<ReturnType<typeof buildBabyjub>>
): [unknown, unknown] => {
    return [babyjub.F.e(point[0]), babyjub.F.e(point[1])];
};

const toHex = (bytes: Uint8Array) =>
    Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');

const fromHex = (value: string) => {
    const out = new Uint8Array(value.length / 2);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
};

export function loadNotes(mint: PublicKey): NoteRecord[] {
    try {
        const raw = localStorage.getItem(notesKey(mint));
        if (!raw) return [];
        const parsed = JSON.parse(raw) as NoteRecord[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function saveNotes(mint: PublicKey, notes: NoteRecord[]) {
    localStorage.setItem(notesKey(mint), JSON.stringify(notes));
}

export function listCommitments(mint: PublicKey): bigint[] {
    return loadNotes(mint)
        .sort((a, b) => a.leafIndex - b.leafIndex)
        .map((note) => BigInt(note.commitment));
}

export function findSpendableNote(mint: PublicKey, amount?: bigint): NoteRecord | null {
    const notes = loadNotes(mint).filter((note) => !note.spent);
    if (amount === undefined) {
        return notes[0] ?? null;
    }
    return notes.find((note) => BigInt(note.amount) === amount) ?? null;
}

export function markNoteSpent(mint: PublicKey, noteId: string) {
    const notes = loadNotes(mint);
    const updated = notes.map((note) => (note.id === noteId ? { ...note, spent: true } : note));
    saveNotes(mint, updated);
}

export async function getOrCreateRecipientSecret(owner: PublicKey): Promise<Uint8Array> {
    const key = recipientKey(owner);
    const stored = localStorage.getItem(key);
    if (stored) {
        return fromHex(stored);
    }
    const secret = randomBytes(32);
    localStorage.setItem(key, toHex(secret));
    return secret;
}

export async function recipientTagHash(owner: PublicKey): Promise<bigint> {
    const secret = await getOrCreateRecipientSecret(owner);
    const hashed = await sha256(secret);
    return modField(bytesToBigIntBE(hashed));
}

export async function getRecipientKeypair(owner: PublicKey): Promise<{
    secret: bigint;
    pubkey: BabyJubPoint;
}> {
    const secretBytes = await getOrCreateRecipientSecret(owner);
    const babyjub = await getBabyjub();
    const secret = modField(bytesToBigIntBE(secretBytes)) % babyjub.subOrder;
    const safeSecret = secret === 0n ? 1n : secret;
    const pubkeyPoint = babyjub.mulPointEscalar(babyjub.Base8, safeSecret);
    const pubkey = pointToBigInt(pubkeyPoint, babyjub);
    return { secret: safeSecret, pubkey };
}

export async function encryptNotePayload(params: {
    recipient: PublicKey;
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
    const { recipient, amount, randomness } = params;
    const babyjub = await getBabyjub();
    const { pubkey } = await getRecipientKeypair(recipient);
    const r = modField(bytesToBigIntBE(randomBytes(32))) % babyjub.subOrder;
    const safeR = r === 0n ? 1n : r;
    const c1Point = babyjub.mulPointEscalar(babyjub.Base8, safeR);
    const c1 = pointToBigInt(c1Point, babyjub);
    const sharedPoint = babyjub.mulPointEscalar(pointFromBigInt(pubkey, babyjub), safeR);
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

export async function decryptNotePayload(params: {
    owner: PublicKey;
    c1x: bigint;
    c1y: bigint;
    c2Amount: bigint;
    c2Randomness: bigint;
}): Promise<{ amount: bigint; randomness: bigint }> {
    const { owner, c1x, c1y, c2Amount, c2Randomness } = params;
    const babyjub = await getBabyjub();
    const { secret } = await getRecipientKeypair(owner);
    const sharedPoint = babyjub.mulPointEscalar(pointFromBigInt([c1x, c1y], babyjub), secret);
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
    recipient: PublicKey;
    leafIndex: number;
}): Promise<{ note: NoteRecord; plaintext: Uint8Array }> {
    const { mint, amount, recipient, leafIndex } = params;
    const randomness = modField(bytesToBigIntBE(randomBytes(32)));
    const senderSecret = modField(bytesToBigIntBE(randomBytes(32)));
    const tagHash = await recipientTagHash(recipient);
    const commitment = await computeCommitment(amount, randomness, tagHash);
    const encryption = await encryptNotePayload({ recipient, amount, randomness });

    const note: NoteRecord = {
        id: `${mint.toBase58()}:${leafIndex}`,
        mint: mint.toBase58(),
        amount: amount.toString(),
        randomness: randomness.toString(),
        recipientTagHash: tagHash.toString(),
        commitment: commitment.toString(),
        senderSecret: senderSecret.toString(),
        c1x: encryption.c1x.toString(),
        c1y: encryption.c1y.toString(),
        c2Amount: encryption.c2Amount.toString(),
        c2Randomness: encryption.c2Randomness.toString(),
        encRandomness: encryption.encRandomness.toString(),
        leafIndex,
        spent: false,
    };
    return { note, plaintext: encryption.ciphertext };
}

export function addNote(mint: PublicKey, note: NoteRecord) {
    const notes = loadNotes(mint);
    const updated = [...notes, note].sort((a, b) => a.leafIndex - b.leafIndex);
    saveNotes(mint, updated);
}

export async function buildAmountCiphertext(params: {
    payee: PublicKey;
    amount: bigint;
}): Promise<{
    ciphertext: Uint8Array;
    payeeTagHash: bigint;
    c1x: bigint;
    c1y: bigint;
    c2Amount: bigint;
    c2Randomness: bigint;
}> {
    const { payee, amount } = params;
    const payeeTagHash = await recipientTagHash(payee);
    const randomness = modField(bytesToBigIntBE(randomBytes(32)));
    const encryption = await encryptNotePayload({ recipient: payee, amount, randomness });
    return {
        ciphertext: encryption.ciphertext,
        payeeTagHash,
        c1x: encryption.c1x,
        c1y: encryption.c1y,
        c2Amount: encryption.c2Amount,
        c2Randomness: encryption.c2Randomness,
    };
}
