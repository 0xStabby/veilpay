import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import * as snarkjs from "snarkjs";
import nacl from "tweetnacl";
import {
  createMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  mintTo,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  buildOutputCiphertexts,
  createNote,
  deriveViewKeypair,
  type NoteRecord,
} from "../sdk/src/noteStore";
import { buildMerkleTree, getMerklePath, MERKLE_DEPTH } from "../sdk/src/merkle";
import { computeNullifier } from "../sdk/src/prover";
import { deriveNullifierSet } from "../sdk/src/pda";
import {
  getIdentityMerklePath,
  getIdentityCommitment,
  getOrCreateIdentitySecret,
  saveIdentityCommitments,
  setIdentityLeafIndex,
} from "../sdk/src/identity";

const hexToBuf = (hex: string) => Buffer.from(hex, "hex");
const buf = (value: Uint8Array) => Buffer.from(value);

const bigIntToBytes32 = (value: bigint): Uint8Array => {
  let hex = value.toString(16);
  if (hex.length > 64) throw new Error("Value exceeds 32 bytes");
  hex = hex.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const hexToBytes32 = (value: string): Buffer => {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  return Buffer.from(clean.padStart(64, "0"), "hex");
};

class MemoryStorage {
  private store = new Map<string, string>();

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

const MAX_INPUTS = 4;
const MAX_OUTPUTS = 2;
const ZERO_PATH_ELEMENTS = Array.from({ length: MERKLE_DEPTH }, () => "0");
const ZERO_PATH_INDEX = Array.from({ length: MERKLE_DEPTH }, () => 0);

const padArray = <T,>(values: T[], length: number, filler: T): T[] => {
  const out = values.slice(0, length);
  while (out.length < length) {
    out.push(filler);
  }
  return out;
};

const padMatrix = <T,>(rows: T[][], length: number, filler: T[]): T[][] => {
  const out = rows.slice(0, length);
  while (out.length < length) {
    out.push(filler.slice());
  }
  return out;
};

const concatBytes = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const toBigIntFromCallData = (value: string): bigint => {
  const trimmed = value.trim();
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    return BigInt(trimmed);
  }
  return BigInt(trimmed);
};

const buildProofBytes = async (proof: unknown, publicSignals: string[]) => {
  const callData = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const argv = callData.replace(/["[\]\s]/g, "").split(",").filter(Boolean);
  if (argv.length < 8) {
    throw new Error("Unexpected calldata length from snarkjs.");
  }
  const a = [toBigIntFromCallData(argv[0]), toBigIntFromCallData(argv[1])];
  const b = [
    [toBigIntFromCallData(argv[2]), toBigIntFromCallData(argv[3])],
    [toBigIntFromCallData(argv[4]), toBigIntFromCallData(argv[5])],
  ];
  const c = [toBigIntFromCallData(argv[6]), toBigIntFromCallData(argv[7])];
  const proofBytes = concatBytes([
    bigIntToBytes32(a[0]),
    bigIntToBytes32(a[1]),
    bigIntToBytes32(b[0][0]),
    bigIntToBytes32(b[0][1]),
    bigIntToBytes32(b[1][0]),
    bigIntToBytes32(b[1][1]),
    bigIntToBytes32(c[0]),
    bigIntToBytes32(c[1]),
  ]);
  const publicInputsBytes = concatBytes(
    argv.slice(8).map((value: string) => bigIntToBytes32(toBigIntFromCallData(value)))
  );
  return { proofBytes: Buffer.from(proofBytes), publicInputsBytes: Buffer.from(publicInputsBytes) };
};

const generateProofWithLogs = async (label: string, input: Record<string, unknown>, wasmPath: string, zkeyPath: string) => {
  console.log(`[proof] ${label} starting`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  console.log(`[proof] ${label} fullProve done`);
  const publicSignalsArray = publicSignals as string[];
  const bytes = await buildProofBytes(proof, publicSignalsArray);
  console.log(`[proof] ${label} calldata encoded`);
  return { proof, publicSignals: publicSignalsArray, ...bytes };
};

const buildSpendProofInput = async (params: {
  programId: PublicKey;
  owner: PublicKey;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  commitments: bigint[];
  inputNotes: NoteRecord[];
  outputNotes: Array<NoteRecord | null>;
  outputEnabled: number[];
  amountOut: bigint;
  feeAmount: bigint;
}) => {
  const {
    programId,
    owner,
    signMessage,
    commitments,
    inputNotes,
    outputNotes,
    outputEnabled,
    amountOut,
    feeAmount,
  } = params;
  const { root: derivedRoot } = await buildMerkleTree(commitments);

  const inputEnabled = padArray(
    inputNotes.map(() => 1),
    MAX_INPUTS,
    0
  );
  const inputAmounts = padArray(
    inputNotes.map((note) => note.amount),
    MAX_INPUTS,
    "0"
  );
  const inputRandomness = padArray(
    inputNotes.map((note) => note.randomness),
    MAX_INPUTS,
    "0"
  );
  const inputSenderSecret = padArray(
    inputNotes.map((note) => note.senderSecret),
    MAX_INPUTS,
    "0"
  );
  const inputLeafIndex = padArray(
    inputNotes.map((note) => note.leafIndex.toString()),
    MAX_INPUTS,
    "0"
  );
  const inputRecipientTagHash = padArray(
    inputNotes.map((note) => note.recipientTagHash),
    MAX_INPUTS,
    "0"
  );

  const pathElementsRows: string[][] = [];
  const pathIndexRows: number[][] = [];
  const nullifierValues: bigint[] = [];
  for (const note of inputNotes) {
    const { pathElements, pathIndices } = await getMerklePath(commitments, note.leafIndex);
    pathElementsRows.push(pathElements.map((value) => value.toString()));
    pathIndexRows.push(pathIndices);
    const nullifierValue = await computeNullifier(BigInt(note.senderSecret), BigInt(note.leafIndex));
    nullifierValues.push(nullifierValue);
  }
  const inputPathElements = padMatrix(pathElementsRows, MAX_INPUTS, ZERO_PATH_ELEMENTS);
  const inputPathIndex = padMatrix(pathIndexRows, MAX_INPUTS, ZERO_PATH_INDEX);
  const nullifierInputs = padArray(
    nullifierValues.map((value) => value.toString()),
    MAX_INPUTS,
    "0"
  );
  const fallbackRecipient = await deriveViewKeypair({ owner, signMessage, index: 0 });
  const fallbackRecipientX = fallbackRecipient.pubkey[0].toString();
  const fallbackRecipientY = fallbackRecipient.pubkey[1].toString();

  const outputCommitments = padArray(
    outputNotes.map((note, index) => {
      if (!note || !outputEnabled[index]) {
        return "0";
      }
      return note.commitment;
    }),
    MAX_OUTPUTS,
    "0"
  );

  const outputAmount = padArray(
    outputNotes.map((note) => (note ? note.amount : "0")),
    MAX_OUTPUTS,
    "0"
  );
  const outputRandomness = padArray(
    outputNotes.map((note) => (note ? note.randomness : "0")),
    MAX_OUTPUTS,
    "0"
  );
  const outputRecipientTagHash = padArray(
    outputNotes.map((note) => (note ? note.recipientTagHash : "0")),
    MAX_OUTPUTS,
    "0"
  );
  const outputRecipientPubkeyX = padArray(
    outputNotes.map((note) => (note?.recipientPubkeyX ? note.recipientPubkeyX : fallbackRecipientX)),
    MAX_OUTPUTS,
    fallbackRecipientX
  );
  const outputRecipientPubkeyY = padArray(
    outputNotes.map((note) => (note?.recipientPubkeyY ? note.recipientPubkeyY : fallbackRecipientY)),
    MAX_OUTPUTS,
    fallbackRecipientY
  );
  const outputEncRandomness = padArray(
    outputNotes.map((note) => (note?.encRandomness ? note.encRandomness : "0")),
    MAX_OUTPUTS,
    "0"
  );
  const outputC1x = padArray(
    outputNotes.map((note) => (note?.c1x ? note.c1x : "0")),
    MAX_OUTPUTS,
    "0"
  );
  const outputC1y = padArray(
    outputNotes.map((note) => (note?.c1y ? note.c1y : "0")),
    MAX_OUTPUTS,
    "0"
  );
  const outputC2Amount = padArray(
    outputNotes.map((note) => (note?.c2Amount ? note.c2Amount : "0")),
    MAX_OUTPUTS,
    "0"
  );
  const outputC2Randomness = padArray(
    outputNotes.map((note) => (note?.c2Randomness ? note.c2Randomness : "0")),
    MAX_OUTPUTS,
    "0"
  );

  const identityPath = await getIdentityMerklePath(owner, programId, signMessage);
  const identitySecret = await getOrCreateIdentitySecret(owner, programId, signMessage);

  const input = {
    root: derivedRoot.toString(),
    identity_root: identityPath.root.toString(),
    nullifier: nullifierInputs,
    output_commitment: outputCommitments,
    output_enabled: padArray(outputEnabled, MAX_OUTPUTS, 0),
    amount_out: amountOut.toString(),
    fee_amount: feeAmount.toString(),
    circuit_id: "0",
    input_enabled: inputEnabled,
    input_amount: inputAmounts,
    input_randomness: inputRandomness,
    input_sender_secret: inputSenderSecret,
    input_leaf_index: inputLeafIndex,
    input_recipient_tag_hash: inputRecipientTagHash,
    input_path_elements: inputPathElements,
    input_path_index: inputPathIndex,
    identity_secret: identitySecret.toString(),
    identity_path_elements: identityPath.pathElements.map((value) => value.toString()),
    identity_path_index: identityPath.pathIndices,
    output_amount: outputAmount,
    output_randomness: outputRandomness,
    output_recipient_tag_hash: outputRecipientTagHash,
    output_recipient_pubkey_x: outputRecipientPubkeyX,
    output_recipient_pubkey_y: outputRecipientPubkeyY,
    output_enc_randomness: outputEncRandomness,
    output_c1x: outputC1x,
    output_c1y: outputC1y,
    output_c2_amount: outputC2Amount,
    output_c2_randomness: outputC2Randomness,
  };

  return {
    input,
    nullifierValues,
    outputCommitments,
  };
};

let envLookupTablePromise: Promise<AddressLookupTableAccount> | null = null;
let envLookupTableAddress: PublicKey | null = null;

const appendRelayerAddresses = async (addresses: PublicKey[], mint: PublicKey) => {
  const relayerRaw = (process.env.VITE_RELAYER_PUBKEY || "").trim();
  if (!relayerRaw) {
    return;
  }
  const relayerPubkey = new PublicKey(relayerRaw);
  addresses.push(relayerPubkey);
  const relayerFeeAta = await getAssociatedTokenAddress(mint, relayerPubkey);
  addresses.push(relayerFeeAta);
};

const fetchLookupTable = async (
  connection: anchor.web3.Connection,
  address: PublicKey
): Promise<AddressLookupTableAccount> => {
  const lookup = await connection.getAddressLookupTable(address);
  if (!lookup.value) {
    throw new Error(`Lookup table not found for ${address.toBase58()}.`);
  }
  return lookup.value;
};

const ensureSharedLookupTable = async (params: {
  connection: anchor.web3.Connection;
  payer: Keypair;
  addresses: PublicKey[];
}): Promise<AddressLookupTableAccount> => {
  const { connection, payer, addresses } = params;
  const unique = Array.from(new Set(addresses.map((key) => key.toBase58()))).map(
    (value) => new PublicKey(value)
  );
  if (!envLookupTableAddress) {
    const existing =
      (process.env.VITE_LUT_ADDRESS || process.env.RELAYER_LUT_ADDRESS || "").trim();
    if (existing) {
      envLookupTableAddress = new PublicKey(existing);
    } else {
      const recentSlot = await connection.getSlot("finalized");
      const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot,
      });
      const createSig = await connection.sendTransaction(new Transaction().add(createIx), [payer], {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction(createSig, "finalized");
      envLookupTableAddress = lookupTableAddress;
      process.env.VITE_LUT_ADDRESS = lookupTableAddress.toBase58();
    }
  }

  const current = await fetchLookupTable(connection, envLookupTableAddress);
  const existingSet = new Set(current.state.addresses.map((key) => key.toBase58()));
  const missing = unique.filter((key) => !existingSet.has(key.toBase58()));
  if (missing.length > 0) {
    const chunkSize = 20;
    for (let i = 0; i < missing.length; i += chunkSize) {
      const chunk = missing.slice(i, i + chunkSize);
      if (chunk.length === 0) continue;
      const extendIx = AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: envLookupTableAddress,
        addresses: chunk,
      });
      const extendSig = await connection.sendTransaction(new Transaction().add(extendIx), [payer], {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction(extendSig, "finalized");
    }
  }
  return await fetchLookupTable(connection, envLookupTableAddress);
};

const sendVersionedWithLookupTable = async (params: {
  connection: anchor.web3.Connection;
  payer: Keypair;
  instructions: anchor.web3.TransactionInstruction[];
  lookupTable: AddressLookupTableAccount;
}) => {
  const { connection, payer, instructions, lookupTable } = params;
  const {
    value: { blockhash, lastValidBlockHeight },
  } = await connection.getLatestBlockhashAndContext();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message([lookupTable]);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
};

const sendWithLut = async (params: {
  connection: anchor.web3.Connection;
  payer: Keypair;
  ix: anchor.web3.TransactionInstruction;
}) => {
  const { connection, payer, ix } = params;
  if (!envLookupTablePromise) {
    throw new Error("Shared LUT not initialized for e2e test.");
  }
  const lut = await envLookupTablePromise;
  await sendVersionedWithLookupTable({
    connection,
    payer,
    instructions: [ix],
    lookupTable: lut,
  });
};

const nullifierChunkIndex = (nullifier: bigint): number => {
  const bytes = bigIntToBytes32(nullifier);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true);
};

const ensureNullifierSets = async (params: {
  program: Program;
  mint: PublicKey;
  config: PublicKey;
  nullifiers: bigint[];
}) => {
  const { program, mint, config, nullifiers } = params;
  const chunkIndexes = new Set<number>();
  for (const nullifier of nullifiers) {
    if (nullifier === 0n) continue;
    chunkIndexes.add(nullifierChunkIndex(nullifier));
  }
  const ordered = Array.from(chunkIndexes).sort((a, b) => a - b);
  const sets: PublicKey[] = [];
  for (const chunkIndex of ordered) {
    const nullifierSet = deriveNullifierSet(program.programId, mint, chunkIndex);
    const info = await program.provider.connection.getAccountInfo(nullifierSet);
    if (!info) {
      const ix = await program.methods
        .initializeNullifierChunk(chunkIndex)
        .accounts({
          config,
          nullifierSet,
          payer: (program.provider as anchor.AnchorProvider).wallet.publicKey,
          mint,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await sendWithLut({
        connection: program.provider.connection,
        payer: (program.provider as anchor.AnchorProvider).wallet.payer,
        ix,
      });
    }
    sets.push(nullifierSet);
  }
  return sets;
};

const ensureSystemAccount = async (
  connection: anchor.web3.Connection,
  pubkey: PublicKey
) => {
  const info = await connection.getAccountInfo(pubkey);
  if (info) return;
  const sig = await connection.requestAirdrop(pubkey, 1_000_000_000);
  await connection.confirmTransaction(sig, "confirmed");
};

const deriveTempAuthority = async (
  program: Program,
  vaultPda: PublicKey,
  recipient: PublicKey
) => {
  const vault = await program.account.vaultPool.fetch(vaultPda);
  const nonceBytes = (vault.nonce as anchor.BN).toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("temp_wsol"), recipient.toBuffer(), nonceBytes],
    program.programId
  )[0];
};

describe("veilpay e2e (real groth16)", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.Veilpay as Program;
  const verifierProgram = (anchor.workspace.Verifier ||
    anchor.workspace.verifier) as Program;
  assert.isOk(verifierProgram, "verifier program not found in workspace");

  const proofPath = path.join(process.cwd(), "circuits/build/snarkjs_proof.json");
  const vkFixturePath = path.join(process.cwd(), "circuits/build/verifier_key.json");
  const snarkjsVkPath = path.join(process.cwd(), "circuits/build/verification_key.json");
  const wasmPath = path.join(process.cwd(), "circuits/build/veilpay_js/veilpay.wasm");
  const zkeyPath = path.join(process.cwd(), "circuits/build/veilpay_final.zkey");

  let mint: PublicKey;
  let vaultPda: PublicKey;
  let shieldedPda: PublicKey;
  let nullifierPda: PublicKey;
  let identityRegistryPda: PublicKey;
  let identityMemberPda: PublicKey;
  let vaultAta: PublicKey;
  let userAta: PublicKey;
  let verifierKeyPda: PublicKey;

  before(() => {
    if (!(globalThis as any).crypto?.subtle) {
      (globalThis as any).crypto = require("crypto").webcrypto;
    }
    if (!(globalThis as any).localStorage) {
      (globalThis as any).localStorage = new MemoryStorage();
    }
  });

  it("runs deposit -> withdraw with real proof", async () => {
    const proofNeedsRegen = () => {
      if (!fs.existsSync(proofPath) || !fs.existsSync(vkFixturePath)) {
        return true;
      }
      try {
        const proofFixture = JSON.parse(fs.readFileSync(proofPath, "utf8"));
        const signals = proofFixture.publicSignals as string[] | undefined;
        if (!signals || signals.length < 13) {
          return true;
        }
        if (signals[8] !== "0") {
          return true;
        }
      } catch (error) {
        return true;
      }
      const proofStat = fs.statSync(proofPath);
      const vkStat = fs.statSync(vkFixturePath);
      const zkeyStat = fs.statSync(zkeyPath);
      const wasmStat = fs.statSync(wasmPath);
      const newestInput = Math.max(
        vkStat.mtimeMs,
        zkeyStat.mtimeMs,
        wasmStat.mtimeMs
      );
      return proofStat.mtimeMs < newestInput;
    };

    if (proofNeedsRegen()) {
      if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
        throw new Error("Missing circuit artifacts. Run scripts/build-circuits.sh first.");
      }
      execFileSync("node", ["scripts/gen-proof-json.js"], { stdio: "inherit" });
      if (!fs.existsSync(proofPath) || !fs.existsSync(vkFixturePath)) {
        throw new Error("Missing proof artifacts after generation. Run node scripts/gen-proof-json.js.");
      }
    }

    const vkFixture = JSON.parse(fs.readFileSync(vkFixturePath, "utf8"));
    const groth16 = {
      alphaG1: hexToBuf(vkFixture.alpha_g1),
      betaG2: hexToBuf(vkFixture.beta_g2),
      gammaG2: hexToBuf(vkFixture.gamma_g2),
      deltaG2: hexToBuf(vkFixture.delta_g2),
      gammaAbc: vkFixture.gamma_abc.map((entry: string) => hexToBuf(entry)),
    };
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );
    const [vkRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vk_registry")],
      program.programId
    );

    const configInfo = await provider.connection.getAccountInfo(configPda);
    if (!configInfo) {
      await program.methods
        .initializeConfig({
          feeBps: 25,
          relayerFeeBpsMax: 50,
          vkRegistry: vkRegistryPda,
          mintAllowlist: [],
          circuitIds: [0],
        })
        .accounts({
          config: configPda,
          admin: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const vkInfo = await provider.connection.getAccountInfo(vkRegistryPda);
    if (!vkInfo) {
      await program.methods
        .initializeVkRegistry()
        .accounts({
          vkRegistry: vkRegistryPda,
          admin: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const keyId = 1;
    const keyIdBuf = Buffer.alloc(4);
    keyIdBuf.writeUInt32LE(keyId, 0);
    [verifierKeyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("verifier_key"), keyIdBuf],
      verifierProgram.programId
    );

    const verifierInfo = await provider.connection.getAccountInfo(verifierKeyPda);
    if (!verifierInfo) {
      await verifierProgram.methods
        .initializeVerifierKey({
          keyId,
          alphaG1: groth16.alphaG1,
          betaG2: groth16.betaG2,
          gammaG2: groth16.gammaG2,
          deltaG2: groth16.deltaG2,
          publicInputsLen: groth16.gammaAbc.length - 1,
          gammaAbc: [groth16.gammaAbc[0]],
          mock: true,
        })
        .accounts({
          verifierKey: verifierKeyPda,
          admin: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );

    await program.methods
      .registerMint(mint)
      .accounts({
        config: configPda,
        admin: provider.wallet.publicKey,
      })
      .rpc();

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer()],
      program.programId
    );
    [shieldedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("shielded"), mint.toBuffer()],
      program.programId
    );
    vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);
    userAta = await getAssociatedTokenAddress(mint, provider.wallet.publicKey);
    await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      provider.wallet.publicKey
    );
    const vaultAtaIx = createAssociatedTokenAccountInstruction(
      provider.wallet.publicKey,
      vaultAta,
      vaultPda,
      mint
    );
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(vaultAtaIx)
    );

    const amount = 100_000n;
    const proofFixture = JSON.parse(fs.readFileSync(proofPath, "utf8"));
    const snarkjsVkey = JSON.parse(fs.readFileSync(snarkjsVkPath, "utf8"));
    const proofOk = await snarkjs.groth16.verify(
      snarkjsVkey,
      proofFixture.publicSignals,
      proofFixture.proof
    );
    assert.isTrue(proofOk, "snarkjs proof verify failed");
    const publicSignals = proofFixture.publicSignals as string[];
    const root = BigInt(publicSignals[0]);
    const identityRoot = BigInt(publicSignals[1]);
    const nullifier = BigInt(publicSignals[2]);

    const chunkSeed0 = Buffer.alloc(4);
    chunkSeed0.writeUInt32LE(0, 0);
    [nullifierPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_set"), mint.toBuffer(), chunkSeed0],
      program.programId
    );
    [identityRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("identity_registry")],
      program.programId
    );
    [identityMemberPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("identity_member"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeMintState(0)
      .accounts({
        config: configPda,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        nullifierSet: nullifierPda,
        admin: provider.wallet.publicKey,
        mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const identityInfo = await provider.connection.getAccountInfo(identityRegistryPda);
    if (!identityInfo) {
      await program.methods
        .initializeIdentityRegistry()
        .accounts({
          identityRegistry: identityRegistryPda,
          admin: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    await program.methods
      .registerIdentity({
        commitment: buf(new Uint8Array(32)),
        newRoot: buf(bigIntToBytes32(identityRoot)),
      })
      .accounts({
        identityRegistry: identityRegistryPda,
        identityMember: identityMemberPda,
        payer: provider.wallet.publicKey,
        user: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mint,
      userAta,
      provider.wallet.publicKey,
      1_000_000
    );

    const depositRoot = Buffer.from(bigIntToBytes32(root));

    await program.methods
      .deposit({
        amount: new anchor.BN(amount.toString()),
        ciphertext: buf(new Uint8Array(128)),
        commitment: buf(new Uint8Array(32)),
        newRoot: depositRoot,
      })
      .accounts({
        config: configPda,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        user: provider.wallet.publicKey,
        identityMember: identityMemberPda,
        userAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const nullifierBytes = Buffer.from(bigIntToBytes32(nullifier));
    const chunkIndex = nullifierBytes.readUInt32LE(0);
    const chunkSeed = Buffer.alloc(4);
    chunkSeed.writeUInt32LE(chunkIndex, 0);
    [nullifierPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_set"), mint.toBuffer(), chunkSeed],
      program.programId
    );
    if (chunkIndex !== 0) {
      await program.methods
        .initializeNullifierChunk(chunkIndex)
        .accounts({
          config: configPda,
          nullifierSet: nullifierPda,
          payer: provider.wallet.publicKey,
          mint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const solidity = proofFixture.solidity;
    const proofBytes = Buffer.concat([
      hexToBytes32(solidity.a[0]),
      hexToBytes32(solidity.a[1]),
      hexToBytes32(solidity.b[0][0]),
      hexToBytes32(solidity.b[0][1]),
      hexToBytes32(solidity.b[1][0]),
      hexToBytes32(solidity.b[1][1]),
      hexToBytes32(solidity.c[0]),
      hexToBytes32(solidity.c[1]),
    ]);
    const publicInputs = Buffer.concat(solidity.inputs.map(hexToBytes32));
    const dummyProof = Buffer.alloc(32);

    const recipient = anchor.web3.Keypair.generate();
    await ensureSystemAccount(provider.connection, recipient.publicKey);
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );
    const tempAuthority = await deriveTempAuthority(program, vaultPda, recipient.publicKey);
    const tempWsolAta = await getAssociatedTokenAddress(mint, tempAuthority, true);

    await verifierProgram.methods
      .verifyGroth16(dummyProof, publicInputs)
      .accounts({ verifierKey: verifierKeyPda })
      .rpc();

    await program.methods
      .withdraw({
        amount: new anchor.BN(amount.toString()),
        proof: dummyProof,
        publicInputs,
        relayerFeeBps: 0,
        newRoot: depositRoot,
        outputCiphertexts: Buffer.alloc(0),
        deliverSol: false,
      })
      .accounts({
        config: configPda,
        payer: provider.wallet.publicKey,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: nullifierPda,
        recipientAta,
        recipient: recipient.publicKey,
        tempAuthority,
        tempWsolAta,
        relayerFeeAta: null,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("handles mixed flow with real proofs and v0 txs", async () => {
    (globalThis as any).localStorage.clear();
    const signMessage = async (message: Uint8Array) =>
      nacl.sign.detached(message, provider.wallet.payer.secretKey);
    if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
      throw new Error("Missing circuit artifacts. Run scripts/build-circuits.sh first.");
    }

    const vkFixture = JSON.parse(fs.readFileSync(vkFixturePath, "utf8"));
    const groth16 = {
      alphaG1: hexToBuf(vkFixture.alpha_g1),
      betaG2: hexToBuf(vkFixture.beta_g2),
      gammaG2: hexToBuf(vkFixture.gamma_g2),
      deltaG2: hexToBuf(vkFixture.delta_g2),
      gammaAbc: vkFixture.gamma_abc.map((entry: string) => hexToBuf(entry)),
    };

    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );
    const [vkRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vk_registry")],
      program.programId
    );
    const configInfo = await provider.connection.getAccountInfo(configPda);
    if (!configInfo) {
      await program.methods
        .initializeConfig({
          feeBps: 25,
          relayerFeeBpsMax: 50,
          vkRegistry: vkRegistryPda,
          mintAllowlist: [],
          circuitIds: [0],
        })
        .accounts({
          config: configPda,
          admin: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    const vkInfo = await provider.connection.getAccountInfo(vkRegistryPda);
    if (!vkInfo) {
      await program.methods
        .initializeVkRegistry()
        .accounts({
          vkRegistry: vkRegistryPda,
          admin: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const keyId = 2;
    const keyIdBuf = Buffer.alloc(4);
    keyIdBuf.writeUInt32LE(keyId, 0);
    const [realVerifierKeyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("verifier_key"), keyIdBuf],
      verifierProgram.programId
    );
    const realVerifierInfo = await provider.connection.getAccountInfo(realVerifierKeyPda);
    if (!realVerifierInfo) {
      await verifierProgram.methods
        .initializeVerifierKeyHeader({
          keyId,
          alphaG1: groth16.alphaG1,
          betaG2: groth16.betaG2,
          gammaG2: groth16.gammaG2,
          deltaG2: groth16.deltaG2,
          publicInputsLen: groth16.gammaAbc.length - 1,
          gammaAbcLen: groth16.gammaAbc.length,
          mock: false,
        })
        .accounts({
          verifierKey: realVerifierKeyPda,
          admin: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const chunkSize = 6;
      for (let start = 0; start < groth16.gammaAbc.length; start += chunkSize) {
        const chunk = groth16.gammaAbc.slice(start, start + chunkSize);
        await verifierProgram.methods
          .setVerifierKeyGammaAbc({
            keyId,
            startIndex: start,
            gammaAbc: chunk,
          })
          .accounts({
            verifierKey: realVerifierKeyPda,
            admin: provider.wallet.publicKey,
          })
          .rpc();
      }
    }

    [identityRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("identity_registry")],
      program.programId
    );
    [identityMemberPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("identity_member"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    const identityInfo = await provider.connection.getAccountInfo(identityRegistryPda);
    if (!identityInfo) {
      await program.methods
        .initializeIdentityRegistry()
        .accounts({
          identityRegistry: identityRegistryPda,
          admin: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    const identityCommitment = await getIdentityCommitment(
      provider.wallet.publicKey,
      program.programId,
      signMessage
    );
    saveIdentityCommitments(program.programId, [identityCommitment]);
    setIdentityLeafIndex(provider.wallet.publicKey, program.programId, 0);
    const identityPath = await getIdentityMerklePath(
      provider.wallet.publicKey,
      program.programId,
      signMessage
    );
    console.log("[e2e] registering identity");
    await program.methods
      .registerIdentity({
        commitment: buf(bigIntToBytes32(identityCommitment)),
        newRoot: buf(bigIntToBytes32(identityPath.root)),
      })
      .accounts({
        identityRegistry: identityRegistryPda,
        identityMember: identityMemberPda,
        payer: provider.wallet.publicKey,
        user: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const ownerViewKey = await deriveViewKeypair({
      owner: provider.wallet.publicKey,
      signMessage,
      index: 0,
    });

    console.log("[e2e] creating SPL mint flow");
    const splMint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );
    await program.methods
      .registerMint(splMint)
      .accounts({
        config: configPda,
        admin: provider.wallet.publicKey,
      })
      .rpc();

    const [splVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), splMint.toBuffer()],
      program.programId
    );
    const [splShieldedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("shielded"), splMint.toBuffer()],
      program.programId
    );
    const [splNullifierPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_set"), splMint.toBuffer(), Buffer.from([0, 0, 0, 0])],
      program.programId
    );
    const splVaultAta = await getAssociatedTokenAddress(splMint, splVaultPda, true);
    const splUserAta = await getAssociatedTokenAddress(splMint, provider.wallet.publicKey);
    await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      splMint,
      provider.wallet.publicKey
    );
    const splVaultAtaIx = createAssociatedTokenAccountInstruction(
      provider.wallet.publicKey,
      splVaultAta,
      splVaultPda,
      splMint
    );
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(splVaultAtaIx));
    await program.methods
      .initializeMintState(0)
      .accounts({
        config: configPda,
        vault: splVaultPda,
        vaultAta: splVaultAta,
        shieldedState: splShieldedPda,
        nullifierSet: splNullifierPda,
        admin: provider.wallet.publicKey,
        mint: splMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await mintTo(
      provider.connection,
      provider.wallet.payer,
      splMint,
      splUserAta,
      provider.wallet.publicKey,
      1_000_000
    );

    console.log("[e2e] ensuring shared LUT");
    const splLutAddresses = [
      program.programId,
      verifierProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SystemProgram.programId,
      configPda,
      splVaultPda,
      splVaultAta,
      splShieldedPda,
      splNullifierPda,
      identityRegistryPda,
      realVerifierKeyPda,
      splMint,
    ];
    await appendRelayerAddresses(splLutAddresses, splMint);
    envLookupTablePromise = ensureSharedLookupTable({
      connection: provider.connection,
      payer: provider.wallet.payer,
      addresses: splLutAddresses,
    });

    const splCommitments: bigint[] = [];
    const splNotes: NoteRecord[] = [];

    console.log("[e2e] deposit 1");
    const deposit1 = await createNote({
      mint: splMint,
      amount: 400_000n,
      recipientViewKey: ownerViewKey.pubkey,
      leafIndex: splCommitments.length,
    });
    splCommitments.push(BigInt(deposit1.note.commitment));
    const { root: depositRoot1 } = await buildMerkleTree(splCommitments);
    await program.methods
      .deposit({
        amount: new anchor.BN(400_000),
        ciphertext: Buffer.from(deposit1.plaintext),
        commitment: Buffer.from(bigIntToBytes32(BigInt(deposit1.note.commitment))),
        newRoot: Buffer.from(bigIntToBytes32(depositRoot1)),
      })
      .accounts({
        config: configPda,
        vault: splVaultPda,
        vaultAta: splVaultAta,
        shieldedState: splShieldedPda,
        user: provider.wallet.publicKey,
        identityMember: identityMemberPda,
        userAta: splUserAta,
        mint: splMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    splNotes.push(deposit1.note);

    console.log("[e2e] deposit 2");
    const deposit2 = await createNote({
      mint: splMint,
      amount: 300_000n,
      recipientViewKey: ownerViewKey.pubkey,
      leafIndex: splCommitments.length,
    });
    splCommitments.push(BigInt(deposit2.note.commitment));
    const { root: depositRoot2 } = await buildMerkleTree(splCommitments);
    await program.methods
      .deposit({
        amount: new anchor.BN(300_000),
        ciphertext: Buffer.from(deposit2.plaintext),
        commitment: Buffer.from(bigIntToBytes32(BigInt(deposit2.note.commitment))),
        newRoot: Buffer.from(bigIntToBytes32(depositRoot2)),
      })
      .accounts({
        config: configPda,
        vault: splVaultPda,
        vaultAta: splVaultAta,
        shieldedState: splShieldedPda,
        user: provider.wallet.publicKey,
        identityMember: identityMemberPda,
        userAta: splUserAta,
        mint: splMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    splNotes.push(deposit2.note);

    console.log("[e2e] internal transfer with 2 inputs + 2 outputs");
    const internalOut1 = await createNote({
      mint: splMint,
      amount: 350_000n,
      recipientViewKey: ownerViewKey.pubkey,
      leafIndex: splCommitments.length,
    });
    const internalOut2 = await createNote({
      mint: splMint,
      amount: 350_000n,
      recipientViewKey: ownerViewKey.pubkey,
      leafIndex: splCommitments.length + 1,
    });
    const internalOutputNotes: Array<NoteRecord | null> = [
      internalOut1.note,
      internalOut2.note,
    ];
    const internalOutputsEnabled = [1, 1];
    const internalInputs = await buildSpendProofInput({
      programId: program.programId,
      owner: provider.wallet.publicKey,
      signMessage,
      commitments: splCommitments,
      inputNotes: [splNotes[0], splNotes[1]],
      outputNotes: internalOutputNotes,
      outputEnabled: internalOutputsEnabled,
      amountOut: 0n,
      feeAmount: 0n,
    });
    const { root: internalRoot } = await buildMerkleTree([
      ...splCommitments,
      BigInt(internalOut1.note.commitment),
      BigInt(internalOut2.note.commitment),
    ]);
    const internalProof = await generateProofWithLogs(
      "internal-transfer",
      internalInputs.input,
      wasmPath,
      zkeyPath
    );
    const internalNullifierSets = await ensureNullifierSets({
      program,
      mint: splMint,
      config: configPda,
      nullifiers: internalInputs.nullifierValues,
    });
    const internalPrimaryNullifier = internalNullifierSets[0];
    const internalIx = await program.methods
      .internalTransfer({
        proof: internalProof.proofBytes,
        publicInputs: internalProof.publicInputsBytes,
        newRoot: buf(bigIntToBytes32(internalRoot)),
        outputCiphertexts: buildOutputCiphertexts(internalOutputNotes, internalOutputsEnabled),
      })
      .accounts({
        config: configPda,
        shieldedState: splShieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: internalPrimaryNullifier,
        verifierProgram: verifierProgram.programId,
        verifierKey: realVerifierKeyPda,
        mint: splMint,
      })
      .remainingAccounts(
        internalNullifierSets.slice(1).map((account) => ({
          pubkey: account,
          isWritable: true,
          isSigner: false,
        }))
      )
      .instruction();
    await sendWithLut({
      connection: provider.connection,
      payer: provider.wallet.payer,
      ix: internalIx,
    });
    splCommitments.push(BigInt(internalOut1.note.commitment));
    splCommitments.push(BigInt(internalOut2.note.commitment));

    console.log("[e2e] external transfer with single input + change");
    const recipient = Keypair.generate();
    await ensureSystemAccount(provider.connection, recipient.publicKey);
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      splMint,
      recipient.publicKey
    );
    const changeNote = await createNote({
      mint: splMint,
      amount: 200_000n,
      recipientViewKey: ownerViewKey.pubkey,
      leafIndex: splCommitments.length,
    });
    const externalInputs = await buildSpendProofInput({
      programId: program.programId,
      owner: provider.wallet.publicKey,
      signMessage,
      commitments: splCommitments,
      inputNotes: [internalOut1.note],
      outputNotes: [null, changeNote.note],
      outputEnabled: [0, 1],
      amountOut: 150_000n,
      feeAmount: 0n,
    });
    const { root: externalRoot } = await buildMerkleTree([
      ...splCommitments,
      BigInt(changeNote.note.commitment),
    ]);
    const externalProof = await generateProofWithLogs(
      "external-transfer",
      externalInputs.input,
      wasmPath,
      zkeyPath
    );
    const externalNullifierSets = await ensureNullifierSets({
      program,
      mint: splMint,
      config: configPda,
      nullifiers: externalInputs.nullifierValues,
    });
    const externalPrimaryNullifier = externalNullifierSets[0];
    const tempAuthority = await deriveTempAuthority(program, splVaultPda, recipient.publicKey);
    const tempWsolAta = await getAssociatedTokenAddress(splMint, tempAuthority, true);
    const externalIx = await program.methods
      .externalTransfer({
        amount: new anchor.BN(150_000),
        proof: externalProof.proofBytes,
        publicInputs: externalProof.publicInputsBytes,
        relayerFeeBps: 0,
        newRoot: buf(bigIntToBytes32(externalRoot)),
        outputCiphertexts: buildOutputCiphertexts([null, changeNote.note], [0, 1]),
        deliverSol: false,
      })
      .accounts({
        config: configPda,
        payer: provider.wallet.publicKey,
        vault: splVaultPda,
        vaultAta: splVaultAta,
        shieldedState: splShieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: externalPrimaryNullifier,
        destinationAta: recipientAta,
        recipient: recipient.publicKey,
        tempAuthority,
        tempWsolAta,
        relayerFeeAta: null,
        verifierProgram: verifierProgram.programId,
        verifierKey: realVerifierKeyPda,
        mint: splMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        externalNullifierSets.slice(1).map((account) => ({
          pubkey: account,
          isWritable: true,
          isSigner: false,
        }))
      )
      .instruction();
    await sendWithLut({
      connection: provider.connection,
      payer: provider.wallet.payer,
      ix: externalIx,
    });
    splCommitments.push(BigInt(changeNote.note.commitment));

    console.log("[e2e] WSOL external transfer deliverSol=true");
    const wsolMint = NATIVE_MINT;
    await program.methods
      .registerMint(wsolMint)
      .accounts({
        config: configPda,
        admin: provider.wallet.publicKey,
      })
      .rpc();
    const [wsolVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), wsolMint.toBuffer()],
      program.programId
    );
    const [wsolShieldedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("shielded"), wsolMint.toBuffer()],
      program.programId
    );
    const [wsolNullifierPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_set"), wsolMint.toBuffer(), Buffer.from([0, 0, 0, 0])],
      program.programId
    );
    const wsolVaultAta = await getAssociatedTokenAddress(wsolMint, wsolVaultPda, true);
    const wsolUserAta = await getAssociatedTokenAddress(wsolMint, provider.wallet.publicKey);
    const wsolUserAtaInfo = await provider.connection.getAccountInfo(wsolUserAta);
    if (!wsolUserAtaInfo) {
      await createAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        wsolMint,
        provider.wallet.publicKey
      );
    }
    const wsolVaultAtaInfo = await provider.connection.getAccountInfo(wsolVaultAta);
    if (!wsolVaultAtaInfo) {
      const wsolVaultAtaIx = createAssociatedTokenAccountInstruction(
        provider.wallet.publicKey,
        wsolVaultAta,
        wsolVaultPda,
        wsolMint
      );
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(wsolVaultAtaIx));
    }
    await program.methods
      .initializeMintState(0)
      .accounts({
        config: configPda,
        vault: wsolVaultPda,
        vaultAta: wsolVaultAta,
        shieldedState: wsolShieldedPda,
        nullifierSet: wsolNullifierPda,
        admin: provider.wallet.publicKey,
        mint: wsolMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const wsolLutAddresses = [
      program.programId,
      verifierProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SystemProgram.programId,
      configPda,
      wsolVaultPda,
      wsolVaultAta,
      wsolShieldedPda,
      wsolNullifierPda,
      identityRegistryPda,
      realVerifierKeyPda,
      wsolMint,
    ];
    await appendRelayerAddresses(wsolLutAddresses, wsolMint);
    envLookupTablePromise = ensureSharedLookupTable({
      connection: provider.connection,
      payer: provider.wallet.payer,
      addresses: wsolLutAddresses,
    });
    const wrapIx = SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: wsolUserAta,
      lamports: 50_000,
    });
    const syncIx = createSyncNativeInstruction(wsolUserAta);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(wrapIx, syncIx));

    const wsolCommitments: bigint[] = [];
    console.log("[e2e] WSOL deposit");
    const wsolDeposit = await createNote({
      mint: wsolMint,
      amount: 50_000n,
      recipientViewKey: ownerViewKey.pubkey,
      leafIndex: 0,
    });
    wsolCommitments.push(BigInt(wsolDeposit.note.commitment));
    const { root: wsolDepositRoot } = await buildMerkleTree(wsolCommitments);
    await program.methods
      .deposit({
        amount: new anchor.BN(50_000),
        ciphertext: Buffer.from(wsolDeposit.plaintext),
        commitment: Buffer.from(bigIntToBytes32(BigInt(wsolDeposit.note.commitment))),
        newRoot: Buffer.from(bigIntToBytes32(wsolDepositRoot)),
      })
      .accounts({
        config: configPda,
        vault: wsolVaultPda,
        vaultAta: wsolVaultAta,
        shieldedState: wsolShieldedPda,
        user: provider.wallet.publicKey,
        identityMember: identityMemberPda,
        userAta: wsolUserAta,
        mint: wsolMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const wsolRecipient = Keypair.generate();
    await ensureSystemAccount(provider.connection, wsolRecipient.publicKey);
    const wsolRecipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      wsolMint,
      wsolRecipient.publicKey
    );
    const wsolInputs = await buildSpendProofInput({
      programId: program.programId,
      owner: provider.wallet.publicKey,
      signMessage,
      commitments: wsolCommitments,
      inputNotes: [wsolDeposit.note],
      outputNotes: [null, null],
      outputEnabled: [0, 0],
      amountOut: 50_000n,
      feeAmount: 0n,
    });
    const wsolProof = await generateProofWithLogs("wsol-external", wsolInputs.input, wasmPath, zkeyPath);
    const wsolNullifierSets = await ensureNullifierSets({
      program,
      mint: wsolMint,
      config: configPda,
      nullifiers: wsolInputs.nullifierValues,
    });
    const wsolPrimaryNullifier = wsolNullifierSets[0];
    const wsolTempAuthority = await deriveTempAuthority(program, wsolVaultPda, wsolRecipient.publicKey);
    const wsolTempWsolAta = await getAssociatedTokenAddress(wsolMint, wsolTempAuthority, true);
    const wsolIx = await program.methods
      .externalTransfer({
        amount: new anchor.BN(50_000),
        proof: wsolProof.proofBytes,
        publicInputs: wsolProof.publicInputsBytes,
        relayerFeeBps: 0,
        newRoot: buf(bigIntToBytes32(wsolDepositRoot)),
        outputCiphertexts: Buffer.alloc(0),
        deliverSol: true,
      })
      .accounts({
        config: configPda,
        payer: provider.wallet.publicKey,
        vault: wsolVaultPda,
        vaultAta: wsolVaultAta,
        shieldedState: wsolShieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: wsolPrimaryNullifier,
        destinationAta: wsolRecipientAta,
        recipient: wsolRecipient.publicKey,
        tempAuthority: wsolTempAuthority,
        tempWsolAta: wsolTempWsolAta,
        relayerFeeAta: null,
        verifierProgram: verifierProgram.programId,
        verifierKey: realVerifierKeyPda,
        mint: wsolMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        wsolNullifierSets.slice(1).map((account) => ({
          pubkey: account,
          isWritable: true,
          isSigner: false,
        }))
      )
      .instruction();
    await sendWithLut({
      connection: provider.connection,
      payer: provider.wallet.payer,
      ix: wsolIx,
    });
  });
});
