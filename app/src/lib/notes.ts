import { buildBabyjub } from 'circomlibjs';
import { PublicKey } from '@solana/web3.js';
import { bytesToBigIntBE, concatBytes, modField, randomBytes, sha256 } from './crypto';
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
    recipientPubkeyX: string;
    recipientPubkeyY: string;
    leafIndex: number;
    spent: boolean;
};

const notesKey = (mint: PublicKey, owner: PublicKey) =>
    `veilpay.notes.${owner.toBase58()}.${mint.toBase58()}`;
const commitmentsKey = (mint: PublicKey, owner: PublicKey) =>
    `veilpay.commitments.${owner.toBase58()}.${mint.toBase58()}`;

type BabyJubPoint = [bigint, bigint];
type CommitmentCache = {
    commitments: string[];
    complete: boolean;
};

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

export function loadNotes(mint: PublicKey, owner: PublicKey): NoteRecord[] {
    try {
        const raw = localStorage.getItem(notesKey(mint, owner));
        if (!raw) return [];
        const parsed = JSON.parse(raw) as NoteRecord[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function saveNotes(mint: PublicKey, owner: PublicKey, notes: NoteRecord[]) {
    localStorage.setItem(notesKey(mint, owner), JSON.stringify(notes));
}

export function replaceNotes(mint: PublicKey, owner: PublicKey, notes: NoteRecord[]) {
    saveNotes(mint, owner, notes);
}

export function listCommitments(mint: PublicKey, owner: PublicKey): bigint[] {
    return loadNotes(mint, owner)
        .sort((a, b) => a.leafIndex - b.leafIndex)
        .map((note) => BigInt(note.commitment));
}

export function loadCommitmentCache(mint: PublicKey, owner: PublicKey): CommitmentCache {
    try {
        const raw = localStorage.getItem(commitmentsKey(mint, owner));
        if (!raw) return { commitments: [], complete: false };
        const parsed = JSON.parse(raw) as CommitmentCache;
        if (!parsed || !Array.isArray(parsed.commitments)) {
            return { commitments: [], complete: false };
        }
        return {
            commitments: parsed.commitments.filter((value) => typeof value === 'string'),
            complete: Boolean(parsed.complete),
        };
    } catch {
        return { commitments: [], complete: false };
    }
}

export function saveCommitmentCache(mint: PublicKey, owner: PublicKey, cache: CommitmentCache) {
    localStorage.setItem(commitmentsKey(mint, owner), JSON.stringify(cache));
}

export function loadCommitments(mint: PublicKey, owner: PublicKey): { commitments: bigint[]; complete: boolean } {
    const cache = loadCommitmentCache(mint, owner);
    const commitments = cache.commitments.map((value) => BigInt(value));
    return { commitments, complete: cache.complete };
}

export function saveCommitments(mint: PublicKey, owner: PublicKey, commitments: bigint[], complete = true) {
    saveCommitmentCache(mint, owner, {
        commitments: commitments.map((value) => value.toString()),
        complete,
    });
}

export function appendCommitmentIfComplete(
    mint: PublicKey,
    owner: PublicKey,
    leafIndex: number,
    commitment: bigint
) {
    const cache = loadCommitmentCache(mint, owner);
    if (!cache.complete) {
        return;
    }
    if (leafIndex !== cache.commitments.length) {
        saveCommitmentCache(mint, owner, { commitments: cache.commitments, complete: false });
        return;
    }
    cache.commitments.push(commitment.toString());
    saveCommitmentCache(mint, owner, cache);
}

export function findSpendableNote(mint: PublicKey, owner: PublicKey, amount?: bigint): NoteRecord | null {
    const notes = loadNotes(mint, owner).filter((note) => !note.spent);
    if (amount === undefined) {
        return notes[0] ?? null;
    }
    return notes.find((note) => BigInt(note.amount) === amount) ?? null;
}

export function listSpendableNotes(mint: PublicKey, owner: PublicKey): NoteRecord[] {
    return loadNotes(mint, owner).filter((note) => !note.spent);
}

export function sumSpendableNotes(mint: PublicKey, owner: PublicKey): bigint {
    return listSpendableNotes(mint, owner).reduce((sum, note) => sum + BigInt(note.amount), 0n);
}

export function selectNotesForAmount(
    mint: PublicKey,
    owner: PublicKey,
    amount: bigint,
    maxInputs = 4
): { notes: NoteRecord[]; total: bigint } {
    const available = listSpendableNotes(mint, owner).sort(
        (a, b) => Number(BigInt(a.amount) - BigInt(b.amount))
    );
    const selected: NoteRecord[] = [];
    let total = 0n;
    for (const note of available) {
        if (selected.length >= maxInputs) break;
        selected.push(note);
        total += BigInt(note.amount);
        if (total >= amount) break;
    }
    return { notes: selected, total };
}

export function markNoteSpent(mint: PublicKey, owner: PublicKey, noteId: string) {
    const notes = loadNotes(mint, owner);
    const updated = notes.map((note) => (note.id === noteId ? { ...note, spent: true } : note));
    saveNotes(mint, owner, updated);
}

export async function deriveViewSecret(
    owner: PublicKey,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<Uint8Array> {
    const message = new TextEncoder().encode(`VeilPay:view-key:${owner.toBase58()}`);
    const signature = await signMessage(message);
    return await sha256(signature);
}

const indexToBytes = (index: number): Uint8Array => {
    const out = new Uint8Array(4);
    const view = new DataView(out.buffer);
    view.setUint32(0, index >>> 0, false);
    return out;
};

export async function deriveViewKeypair(params: {
    owner: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
    index?: number;
}): Promise<{ secret: bigint; pubkey: BabyJubPoint; index: number }> {
    const { owner, signMessage, index = 0 } = params;
    const base = await deriveViewSecret(owner, signMessage);
    return await deriveViewKeypairFromSeed(base, index);
}

export async function recipientTagHashFromViewKey(pubkey: BabyJubPoint): Promise<bigint> {
    return await poseidonHash([pubkey[0], pubkey[1]]);
}

export async function deriveViewKeypairFromSeed(
    seed: Uint8Array,
    index: number
): Promise<{ secret: bigint; pubkey: BabyJubPoint; index: number }> {
    const keyed = await sha256(concatBytes([seed, indexToBytes(index)]));
    const babyjub = await getBabyjub();
    const secret = modField(bytesToBigIntBE(keyed)) % babyjub.subOrder;
    const safeSecret = secret === 0n ? 1n : secret;
    const pubkeyPoint = babyjub.mulPointEscalar(babyjub.Base8, safeSecret);
    const pubkey = pointToBigInt(pubkeyPoint, babyjub);
    return { secret: safeSecret, pubkey, index };
}

const normalizeViewKeyHex = (value: string) => value.toLowerCase().replace(/^0x/, '');

export function serializeViewKey(pubkey: BabyJubPoint): string {
    const x = toHex(bigIntToBytes32(pubkey[0]));
    const y = toHex(bigIntToBytes32(pubkey[1]));
    return `${x}:${y}`;
}

export function parseViewKey(value: string): BabyJubPoint {
    const trimmed = value.trim();
    const parts = trimmed.split(':');
    if (parts.length !== 2) {
        throw new Error('Invalid view key format. Expected "<x>:<y>" hex.');
    }
    const xHex = normalizeViewKeyHex(parts[0]);
    const yHex = normalizeViewKeyHex(parts[1]);
    if (xHex.length !== 64 || yHex.length !== 64) {
        throw new Error('Invalid view key length. Expected 32-byte hex parts.');
    }
    const x = BigInt(`0x${xHex}`);
    const y = BigInt(`0x${yHex}`);
    return [x, y];
}

export async function encryptNotePayload(params: {
    recipientViewKey: BabyJubPoint;
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
    const { recipientViewKey, amount, randomness } = params;
    const babyjub = await getBabyjub();
    const r = modField(bytesToBigIntBE(randomBytes(32))) % babyjub.subOrder;
    const safeR = r === 0n ? 1n : r;
    const c1Point = babyjub.mulPointEscalar(babyjub.Base8, safeR);
    const c1 = pointToBigInt(c1Point, babyjub);
    const sharedPoint = babyjub.mulPointEscalar(pointFromBigInt(recipientViewKey, babyjub), safeR);
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
    secret: bigint;
    c1x: bigint;
    c1y: bigint;
    c2Amount: bigint;
    c2Randomness: bigint;
}): Promise<{ amount: bigint; randomness: bigint }> {
    const { secret, c1x, c1y, c2Amount, c2Randomness } = params;
    const babyjub = await getBabyjub();
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
    recipientViewKey: BabyJubPoint;
    leafIndex: number;
}): Promise<{ note: NoteRecord; plaintext: Uint8Array }> {
    const { mint, amount, recipientViewKey, leafIndex } = params;
    const randomness = modField(bytesToBigIntBE(randomBytes(32)));
    const senderSecret = randomness;
    const tagHash = await recipientTagHashFromViewKey(recipientViewKey);
    const commitment = await computeCommitment(amount, randomness, tagHash);
    const encryption = await encryptNotePayload({
        recipientViewKey,
        amount,
        randomness,
    });

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
        recipientPubkeyX: recipientViewKey[0].toString(),
        recipientPubkeyY: recipientViewKey[1].toString(),
        leafIndex,
        spent: false,
    };
    return { note, plaintext: encryption.ciphertext };
}

export function noteCiphertext(note: NoteRecord): Uint8Array {
    const ciphertext = new Uint8Array(128);
    ciphertext.set(bigIntToBytes32(BigInt(note.c1x)), 0);
    ciphertext.set(bigIntToBytes32(BigInt(note.c1y)), 32);
    ciphertext.set(bigIntToBytes32(BigInt(note.c2Amount)), 64);
    ciphertext.set(bigIntToBytes32(BigInt(note.c2Randomness)), 96);
    return ciphertext;
}

export function addNote(mint: PublicKey, owner: PublicKey, note: NoteRecord) {
    const notes = loadNotes(mint, owner);
    const updated = [...notes, note].sort((a, b) => a.leafIndex - b.leafIndex);
    saveNotes(mint, owner, updated);
}

export async function buildAmountCiphertext(params: {
    payeeViewKey: BabyJubPoint;
    amount: bigint;
}): Promise<{
    ciphertext: Uint8Array;
    payeeTagHash: bigint;
    c1x: bigint;
    c1y: bigint;
    c2Amount: bigint;
    c2Randomness: bigint;
}> {
    const { payeeViewKey, amount } = params;
    const payeeTagHash = await recipientTagHashFromViewKey(payeeViewKey);
    const randomness = modField(bytesToBigIntBE(randomBytes(32)));
    const encryption = await encryptNotePayload({
        recipientViewKey: payeeViewKey,
        amount,
        randomness,
    });
    return {
        ciphertext: encryption.ciphertext,
        payeeTagHash,
        c1x: encryption.c1x,
        c1y: encryption.c1y,
        c2Amount: encryption.c2Amount,
        c2Randomness: encryption.c2Randomness,
    };
}
