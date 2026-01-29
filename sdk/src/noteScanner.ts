import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { decode as bs58Decode } from "@coral-xyz/anchor/dist/esm/utils/bytes/bs58.js";
import { bytesToBigIntBE, modField } from "./crypto";
import { computeCommitment, computeNullifier, bigIntToBytes32 } from "./prover";
import { deriveNullifierSet } from "./pda";
import type { NoteRecord } from "./noteStore";
import {
  decryptNotePayload,
  deriveViewSecret,
  deriveViewKeypairFromSeed,
  loadNotes,
  recipientTagHashFromViewKey,
  replaceNotes,
  saveCommitments,
} from "./noteStore";

const Buffer = globalThis.Buffer as unknown as typeof import("buffer").Buffer;

const NOTE_CIPHERTEXT_BYTES = 128;
const NULLIFIER_BITS = 8192;
const DEFAULT_VIEW_KEY_SCAN_MAX_INDEX = 0;

const parseProgramData = (line: string) => {
  const prefix = "Program data:";
  if (!line.startsWith(prefix)) return null;
  const data = line.slice(prefix.length).trim();
  if (!data) return null;
  try {
    const bytes = Buffer.from(data, "base64");
    return { data, bytes };
  } catch {
    return null;
  }
};

const toHex = (bytes: Uint8Array, length = bytes.length) =>
  Array.from(bytes.slice(0, length))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

const toUint8Array = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    return new Uint8Array(value);
  }
  if (typeof value === "string") {
    try {
      return new Uint8Array(bs58Decode(value));
    } catch {
      // ignore
    }
    try {
      return new Uint8Array(Buffer.from(value, "base64"));
    } catch {
      // ignore
    }
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
      try {
        return new Uint8Array(Buffer.from(hex, "hex"));
      } catch {
        // ignore
      }
    }
  }
  return null;
};

const parseCiphertext = (ciphertext: Uint8Array) => {
  const c1x = bytesToBigIntBE(ciphertext.slice(0, 32));
  const c1y = bytesToBigIntBE(ciphertext.slice(32, 64));
  const c2Amount = bytesToBigIntBE(ciphertext.slice(64, 96));
  const c2Randomness = bytesToBigIntBE(ciphertext.slice(96, 128));
  return { c1x, c1y, c2Amount, c2Randomness };
};

const nullifierPosition = (nullifier: bigint) => {
  const bytes = bigIntToBytes32(nullifier);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkIndex = view.getUint32(0, true);
  const bitIndex = view.getUint16(4, true) % NULLIFIER_BITS;
  return { chunkIndex, bitIndex };
};

const toByteCandidates = (data: Uint8Array | string): Uint8Array[] => {
  if (typeof data !== "string") {
    return [data instanceof Uint8Array ? data : new Uint8Array(data)];
  }
  const candidates: Uint8Array[] = [];
  try {
    candidates.push(new Uint8Array(bs58Decode(data)));
  } catch {
    // ignore
  }
  try {
    candidates.push(new Uint8Array(Buffer.from(data, "base64")));
  } catch {
    // ignore
  }
  return candidates;
};

const extractByteCandidates = (data: unknown): Uint8Array[] => {
  if (typeof data === "string" || data instanceof Uint8Array) {
    return toByteCandidates(data);
  }
  if (Buffer.isBuffer(data) || Array.isArray(data)) {
    return [new Uint8Array(data as any)];
  }
  if (data && typeof data === "object") {
    const inner = (data as { data?: unknown }).data;
    if (typeof inner === "string" || inner instanceof Uint8Array) {
      return toByteCandidates(inner);
    }
    if (Buffer.isBuffer(inner) || Array.isArray(inner)) {
      return [new Uint8Array(inner as any)];
    }
  }
  return [];
};

const decodeInstructionName = (program: Program, data: unknown) => {
  try {
    for (const candidate of extractByteCandidates(data)) {
      const decoded = (program.coder.instruction as any).decode(Buffer.from(candidate));
      if (decoded?.name) {
        return decoded.name;
      }
    }
    return null;
  } catch {
    return null;
  }
};

const getAccountKeys = (message: any, meta: any) => {
  if (message && typeof message.getAccountKeys === "function") {
    try {
      const loaded = meta?.loadedAddresses;
      if (loaded?.writable || loaded?.readonly) {
        return message.getAccountKeys({ accountKeysFromLookups: loaded });
      }
      return message.getAccountKeys();
    } catch {
      // ignore
    }
  }
  const staticKeys = message?.staticAccountKeys ?? message?.accountKeys ?? [];
  const loaded = meta?.loadedAddresses;
  if (loaded?.writable || loaded?.readonly) {
    return [...staticKeys, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
  }
  return staticKeys;
};

const resolveAccountKey = (keys: any, index: number) => {
  if (!keys) return undefined;
  if (typeof keys.get === "function") {
    try {
      return keys.get(index);
    } catch {
      return undefined;
    }
  }
  return keys[index];
};

const isRegisterIdentityInstruction = (name: string | null) =>
  name === "registerIdentity" || name === "register_identity";

const findRegistrationSlot = async (
  program: Program,
  owner: PublicKey,
  onStatus?: (message: string) => void
): Promise<number | null> => {
  const connection = program.provider.connection;
  let before: string | undefined;
  onStatus?.("Searching for identity registration...");
  while (true) {
    const signatures = await connection.getSignaturesForAddress(
      owner,
      {
        before,
        limit: 1000,
      },
      "confirmed"
    );
    if (signatures.length === 0) {
      return null;
    }
    before = signatures[signatures.length - 1]?.signature;
    for (const sig of signatures) {
      const tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      const message = tx?.transaction.message as any;
      if (!message) {
        continue;
      }
      const legacyInstructions = message.instructions ?? [];
      if (legacyInstructions.length > 0 && legacyInstructions[0]?.programId) {
        for (const ix of legacyInstructions) {
          if (!ix.programId || !ix.programId.equals(program.programId)) {
            continue;
          }
          const name = decodeInstructionName(program, ix.data);
          if (isRegisterIdentityInstruction(name)) {
            if (typeof tx?.slot === "number") {
              return tx.slot;
            }
          }
        }
      } else {
        const instructions = message.compiledInstructions ?? [];
        const keys = getAccountKeys(message, tx?.meta);
        for (const ix of instructions) {
          const programId = resolveAccountKey(keys, ix.programIdIndex);
          if (!programId || !new PublicKey(programId).equals(program.programId)) {
            continue;
          }
          const name = decodeInstructionName(program, ix.data);
          if (isRegisterIdentityInstruction(name)) {
            if (typeof tx?.slot === "number") {
              return tx.slot;
            }
          }
        }
      }
    }
  }
};

const isNullifierSpent = async (
  program: Program,
  mint: PublicKey,
  nullifier: bigint,
  cache: Map<number, Uint8Array>
) => {
  const { chunkIndex, bitIndex } = nullifierPosition(nullifier);
  let bitset = cache.get(chunkIndex);
  if (!bitset) {
    const account = await (program.account as any).nullifierSet
      .fetch(deriveNullifierSet(program.programId, mint, chunkIndex))
      .catch(() => null);
    if (!account) {
      cache.set(chunkIndex, new Uint8Array(0));
      return false;
    }
    const raw =
      (account.bitset as number[] | Uint8Array | undefined) ??
      (account.bit_set as number[] | Uint8Array | undefined) ??
      [];
    bitset = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    cache.set(chunkIndex, bitset);
  }
  if (bitset.length === 0) {
    return false;
  }
  const byteIndex = Math.floor(bitIndex / 8);
  const mask = 1 << (bitIndex % 8);
  return (bitset[byteIndex] & mask) !== 0;
};

export async function rescanNotesForOwner(params: {
  program: Program;
  mint: PublicKey;
  owner: PublicKey;
  onStatus?: (message: string) => void;
  maxSignatures?: number;
  startSlot?: number;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  viewKeyMaxIndex?: number;
  viewKeyIndices?: number[];
}) {
  const {
    program,
    mint,
    owner,
    onStatus,
    maxSignatures,
    startSlot,
    signMessage,
    viewKeyMaxIndex,
    viewKeyIndices,
  } = params;
  const connection = program.provider.connection;
  onStatus?.("Scanning chain for encrypted notes...");
  if (!signMessage) {
    throw new Error("Missing view key. Connect a wallet that can sign a message to scan notes.");
  }

  let minSlot = startSlot ?? null;
  if (!minSlot) {
    minSlot = await findRegistrationSlot(program, owner, onStatus);
    if (minSlot) {
      onStatus?.(`Found identity registration at slot ${minSlot}.`);
    } else {
      onStatus?.("No identity registration found; scanning full program history.");
    }
  }

  let parsedEvents = 0;
  let matchedEvents = 0;
  let scannedTxs = 0;
  let txsWithLogs = 0;
  let programDataLines = 0;
  let firstProgramDataHex: string | null = null;
  let expectedEventHex: string | null = null;
  const commitmentsByIndex = new Map<number, bigint>();
  const seenLeafIndices = new Set<number>();
  let before: string | undefined;
  const collected: NoteRecord[] = [];
  const indices =
    viewKeyIndices && viewKeyIndices.length > 0
      ? Array.from(new Set(viewKeyIndices.filter((value) => Number.isInteger(value) && value >= 0))).sort(
          (a, b) => a - b
        )
      : Array.from(
          { length: Math.max(0, viewKeyMaxIndex ?? DEFAULT_VIEW_KEY_SCAN_MAX_INDEX) + 1 },
          (_, index) => index
        );
  const baseSecret = await deriveViewSecret(owner, signMessage);
  const viewKeys = await Promise.all(indices.map((index) => deriveViewKeypairFromSeed(baseSecret, index)));
  const viewKeyTags = await Promise.all(viewKeys.map((entry) => recipientTagHashFromViewKey(entry.pubkey)));
  onStatus?.(
    `View key scan indices: ${indices.join(", ")} (${viewKeys.length} key${viewKeys.length === 1 ? "" : "s"})`
  );

  let remaining = maxSignatures ?? Number.POSITIVE_INFINITY;
  while (remaining > 0) {
    const batch = await connection.getSignaturesForAddress(
      program.programId,
      {
        before,
        limit: Math.min(1000, remaining),
      },
      "confirmed"
    );
    if (batch.length === 0) break;
    remaining -= batch.length;
    before = batch[batch.length - 1]?.signature;

    for (const sig of batch) {
      if (sig.err) {
        continue;
      }
      const tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx?.meta?.err) {
        continue;
      }
      const logs = tx?.meta?.logMessages;
      scannedTxs += 1;
      if (!logs) {
        continue;
      }
      const txSlot = typeof sig.slot === "number" ? sig.slot : tx?.slot;
      const shouldAttemptDecrypt = !minSlot || (typeof txSlot === "number" && txSlot >= minSlot);
      txsWithLogs += 1;
      for (const line of logs) {
        if (!line.startsWith("Program data:")) continue;
        programDataLines += 1;
        if (!firstProgramDataHex) {
          const parsed = parseProgramData(line);
          if (parsed) {
            firstProgramDataHex = toHex(parsed.bytes, 8);
          }
        }
        if (!expectedEventHex) {
          try {
            const discriminator = (program.coder as any)?.events?.discriminator?.("NoteOutputEvent");
            if (discriminator) {
              expectedEventHex = toHex(discriminator, 8);
            }
          } catch {
            // ignore
          }
        }
      }
      const handleNoteEvent = (data: any) => {
        const eventMint = new PublicKey(data.mint);
        if (!eventMint.equals(mint)) return;
        const leafIndex = Number(data.leafIndex ?? data.leaf_index ?? 0);
        if (seenLeafIndices.has(leafIndex)) return;
        const commitmentBytes = toUint8Array(data.commitment);
        const ciphertextBytes = toUint8Array(data.ciphertext);
        if (!commitmentBytes || !ciphertextBytes) return;
        if (commitmentBytes.length !== 32 || ciphertextBytes.length !== NOTE_CIPHERTEXT_BYTES) return;
        const commitment = bytesToBigIntBE(commitmentBytes);
        const { c1x, c1y, c2Amount, c2Randomness } = parseCiphertext(ciphertextBytes);
        commitmentsByIndex.set(leafIndex, commitment);
        seenLeafIndices.add(leafIndex);
        if (!shouldAttemptDecrypt) {
          return true;
        }

        collected.push({
          id: `${mint.toBase58()}:${leafIndex}`,
          mint: mint.toBase58(),
          amount: "0",
          randomness: "0",
          recipientTagHash: "0",
          commitment: commitment.toString(),
          senderSecret: "0",
          c1x: c1x.toString(),
          c1y: c1y.toString(),
          c2Amount: c2Amount.toString(),
          c2Randomness: c2Randomness.toString(),
          encRandomness: "0",
          recipientPubkeyX: "0",
          recipientPubkeyY: "0",
          leafIndex,
          spent: false,
        });
        return true;
      };

      for (const line of logs) {
        if (!line.startsWith("Program data:")) continue;
        const parsed = parseProgramData(line);
        if (!parsed) continue;
        try {
          const decoded = (program.coder.events as any).decode(parsed.bytes);
          if (decoded && (decoded.name === "NoteOutputEvent" || decoded.name === "noteOutputEvent")) {
            const added = handleNoteEvent(decoded.data as any);
            if (added) {
              matchedEvents += 1;
              parsedEvents += 1;
            }
          }
        } catch {
          // ignore decode errors for unrelated program data
        }
      }
    }
  }

  const matched: NoteRecord[] = [];
  for (const note of collected) {
    let matchedNote: NoteRecord | null = null;
    for (let i = 0; i < viewKeys.length; i += 1) {
      const viewKey = viewKeys[i];
      const tagHash = viewKeyTags[i];
      try {
        const { amount, randomness } = await decryptNotePayload({
          secret: viewKey.secret,
          c1x: BigInt(note.c1x),
          c1y: BigInt(note.c1y),
          c2Amount: BigInt(note.c2Amount),
          c2Randomness: BigInt(note.c2Randomness),
        });
        const computed = await computeCommitment(amount, randomness, tagHash);
        if (computed !== BigInt(note.commitment)) {
          continue;
        }
        const senderSecret = modField(randomness);
        matchedNote = {
          ...note,
          amount: amount.toString(),
          randomness: randomness.toString(),
          senderSecret: senderSecret.toString(),
          recipientTagHash: tagHash.toString(),
          recipientPubkeyX: viewKey.pubkey[0].toString(),
          recipientPubkeyY: viewKey.pubkey[1].toString(),
        };
        break;
      } catch {
        continue;
      }
    }
    if (matchedNote) {
      matched.push(matchedNote);
    }
  }

  const existing = loadNotes(mint, owner);
  const merged = new Map<string, NoteRecord>(existing.map((note) => [note.id, note]));
  for (const note of matched) {
    const prior = merged.get(note.id);
    if (prior) {
      merged.set(note.id, {
        ...note,
        senderSecret: prior.senderSecret || note.senderSecret,
        encRandomness: prior.encRandomness || note.encRandomness,
      });
    } else {
      merged.set(note.id, note);
    }
  }

  const nullifierCache = new Map<number, Uint8Array>();
  for (const note of merged.values()) {
    if (note.senderSecret === "0" || note.amount === "0") {
      continue;
    }
    const nullifier = await computeNullifier(BigInt(note.senderSecret), BigInt(note.leafIndex));
    const spent = await isNullifierSpent(program, mint, nullifier, nullifierCache);
    note.spent = spent;
  }

  const mergedNotes = Array.from(merged.values()).sort((a, b) => a.leafIndex - b.leafIndex);
  replaceNotes(mint, owner, mergedNotes);
  const balance = mergedNotes
    .filter((note) => !note.spent)
    .reduce((sum, note) => sum + BigInt(note.amount), 0n);
  if (commitmentsByIndex.size > 0) {
    const maxIndex = Math.max(...commitmentsByIndex.keys());
    const total = maxIndex + 1;
    const commitments: bigint[] = new Array(total).fill(0n);
    commitmentsByIndex.forEach((value, index) => {
      commitments[index] = value;
    });
    const complete = commitmentsByIndex.size === total;
    saveCommitments(mint, owner, commitments, complete);
    onStatus?.(
      `Commitment cache updated with ${commitments.length} commitments (${complete ? "complete" : "incomplete"}).`
    );
    if (!complete) {
      onStatus?.("Commitment cache incomplete. Try rescanning full history.");
    }
  }
  onStatus?.(
    `Rescan complete. Found ${matched.length} notes. Scanned ${scannedTxs} txs (${txsWithLogs} with logs, ${programDataLines} program data lines). Parsed ${parsedEvents} events, matched ${matchedEvents} note events.`
  );
  if (programDataLines > 0 && parsedEvents === 0) {
    onStatus?.("Note event decode failed. Unable to decode any note outputs from program logs.");
  }
  return { notes: mergedNotes, balance };
}
