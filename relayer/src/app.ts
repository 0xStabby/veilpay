import express, { type Express } from "express";
import cors from "cors";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { z } from "zod";
import path from "path";
import os from "os";
import { access, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

export const app: Express = express();
const allowedOrigins = (process.env.RELAYER_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowAllOrigins = allowedOrigins.includes("*");
app.use(
  cors({
    origin: allowAllOrigins || allowedOrigins.length === 0 ? true : allowedOrigins,
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, "..", "..");
const proverBinary =
  process.env.ARK_PROVER_PATH || path.join(repoRoot, "target", "debug", "ark-prover");
const wasmPath = path.join(repoRoot, "circuits", "build", "veilpay_js", "veilpay.wasm");
const r1csPath = path.join(repoRoot, "circuits", "build", "veilpay.r1cs");
const zkeyPath = path.join(repoRoot, "circuits", "build", "veilpay_final.zkey");

async function ensureExists(label: string, filePath: string) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

const proofSchema = z.object({
  input: z.record(z.string(), z.union([z.string(), z.number()])),
});

app.post("/proof", async (req, res) => {
  const parsed = proofSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    await ensureExists("ark-prover binary", proverBinary);
    await ensureExists("circom wasm", wasmPath);
    await ensureExists("circom r1cs", r1csPath);
    await ensureExists("circom zkey", zkeyPath);

    const workDir = await mkdtemp(path.join(os.tmpdir(), "veilpay-proof-"));
    const inputPath = path.join(workDir, "input.json");
    const outPath = path.join(workDir, "proof.json");
    const vkPath = path.join(workDir, "vk.json");

    await writeFile(inputPath, JSON.stringify(parsed.data.input));
    await execFileAsync(proverBinary, [
      wasmPath,
      r1csPath,
      zkeyPath,
      inputPath,
      outPath,
      vkPath,
    ]);

    const proofJson = JSON.parse(await readFile(outPath, "utf8"));
    res.json(proofJson);
    await rm(workDir, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proof generation failed";
    res.status(500).json({ error: message });
  }
});

const executeSchema = z.object({
  transaction: z.string(),
  signer: z.string(),
  signature: z.string(),
  message: z.string(),
  expiresAt: z.number().optional(),
  lookupTableAddresses: z.array(z.string()).optional(),
});

const connection = new Connection(process.env.RELAYER_RPC_URL || "http://127.0.0.1:8899", "confirmed");
let cachedRelayerKeypair: Keypair | null = null;
let cachedLutAuthority: Keypair | null = null;

function buildRelayerMessageText(
  transactionBase64: string,
  signer: PublicKey,
  expiresAt: number,
  lookupTableAddresses?: string[]
) {
  const lines = [
    "VeilPay relayer intent",
    `signer:${signer.toBase58()}`,
    `expiresAt:${expiresAt}`,
    `transaction:${transactionBase64}`,
  ];
  if (lookupTableAddresses && lookupTableAddresses.length > 0) {
    lines.push(`lookupTableAddresses:${lookupTableAddresses.join(",")}`);
  }
  return lines.join("\n");
}

async function loadLutAuthorityKeypair(): Promise<Keypair> {
  if (cachedLutAuthority) {
    return cachedLutAuthority;
  }
  const lutAuthorityPath =
    process.env.RELAYER_LUT_AUTHORITY_KEYPAIR || process.env.RELAYER_KEYPAIR || "";
  if (!lutAuthorityPath) {
    throw new Error("RELAYER_LUT_AUTHORITY_KEYPAIR not configured");
  }
  const secret = JSON.parse(await readFile(lutAuthorityPath, "utf8"));
  if (!Array.isArray(secret)) {
    throw new Error("RELAYER_LUT_AUTHORITY_KEYPAIR must be a JSON array");
  }
  cachedLutAuthority = Keypair.fromSecretKey(Uint8Array.from(secret));
  return cachedLutAuthority;
}

async function loadRelayerKeypair(): Promise<Keypair> {
  if (cachedRelayerKeypair) {
    return cachedRelayerKeypair;
  }
  const relayerKeypairPath = process.env.RELAYER_KEYPAIR || "";
  if (!relayerKeypairPath) {
    throw new Error("RELAYER_KEYPAIR not configured");
  }
  const secret = JSON.parse(await readFile(relayerKeypairPath, "utf8"));
  if (!Array.isArray(secret)) {
    throw new Error("RELAYER_KEYPAIR must be a JSON array");
  }
  cachedRelayerKeypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  return cachedRelayerKeypair;
}

function assertAllowedPrograms(programIds: PublicKey[]) {
  const allowedProgramIds = (process.env.RELAYER_ALLOWED_PROGRAMS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new PublicKey(value));
  if (allowedProgramIds.length === 0) {
    throw new Error("RELAYER_ALLOWED_PROGRAMS not configured");
  }
  for (const programId of programIds) {
    if (!allowedProgramIds.some((allowed) => allowed.equals(programId))) {
      throw new Error(`Program not allowed: ${programId.toBase58()}`);
    }
  }
}

const getLutAddress = () => {
  const lut = (process.env.RELAYER_LUT_ADDRESS || "").trim();
  return lut ? new PublicKey(lut) : null;
};

const getMissingLutAddresses = (
  lookupTable: AddressLookupTableAccount,
  message: VersionedTransaction["message"]
) => {
  const lutSet = new Set(lookupTable.state.addresses.map((addr) => addr.toBase58()));
  const signerCount = message.header.numRequiredSignatures;
  const staticKeys = message.staticAccountKeys ?? [];
  const missing: PublicKey[] = [];
  for (let i = signerCount; i < staticKeys.length; i += 1) {
    const key = staticKeys[i];
    if (!lutSet.has(key.toBase58())) {
      missing.push(key);
    }
  }
  return missing;
};

async function extendLookupTable(
  lutAddress: PublicKey,
  authority: Keypair,
  addresses: PublicKey[]
) {
  if (addresses.length === 0) {
    return;
  }
  const chunkSize = 20;
  for (let i = 0; i < addresses.length; i += chunkSize) {
    const chunk = addresses.slice(i, i + chunkSize);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      lookupTable: lutAddress,
      authority: authority.publicKey,
      payer: authority.publicKey,
      addresses: chunk,
    });
    const tx = new Transaction().add(extendIx);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(authority);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction(sig, "confirmed");
  }
}

async function assertTxSuccess(signature: string) {
  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) {
    throw new Error("Transaction not found after confirmation.");
  }
  if (tx.meta?.err) {
    const logs = tx.meta.logMessages?.join("\n");
    throw new Error(
      `Relayed transaction failed: ${JSON.stringify(tx.meta.err)}${
        logs ? `\nLogs:\n${logs}` : ""
      }`
    );
  }
}

async function tryAutoExtendLut(tx: VersionedTransaction) {
  const lutAddress = getLutAddress();
  if (!lutAddress) {
    return null;
  }
  const lutInfo = await connection.getAddressLookupTable(lutAddress);
  if (!lutInfo.value) {
    throw new Error(`RELAYER_LUT_ADDRESS not found: ${lutAddress.toBase58()}`);
  }
  const missing = getMissingLutAddresses(lutInfo.value, tx.message);
  if (missing.length === 0) {
    return lutInfo.value;
  }
  const authority = await loadLutAuthorityKeypair();
  await extendLookupTable(lutAddress, authority, missing);
  const refreshed = await connection.getAddressLookupTable(lutAddress);
  if (!refreshed.value) {
    throw new Error(`Lookup table not found after extend: ${lutAddress.toBase58()}`);
  }
  return refreshed.value;
}

async function syncLookupTableFromClient(
  tx: VersionedTransaction,
  clientAddresses?: string[]
) {
  if (!clientAddresses || clientAddresses.length === 0) {
    return;
  }
  const lutAddress = getLutAddress();
  if (!lutAddress) {
    return;
  }
  const lookups = tx.message.addressTableLookups ?? [];
  if (lookups.length === 0) {
    return;
  }
  if (lookups.length > 1) {
    throw new Error("Relayer only supports auto-extending a single lookup table.");
  }
  if (!lookups[0].accountKey.equals(lutAddress)) {
    throw new Error(
      `Lookup table mismatch. Tx uses ${lookups[0].accountKey.toBase58()}, relayer configured ${lutAddress.toBase58()}.`
    );
  }
  const lutInfo = await connection.getAddressLookupTable(lutAddress);
  if (!lutInfo.value) {
    throw new Error(`RELAYER_LUT_ADDRESS not found: ${lutAddress.toBase58()}`);
  }
  const onChain = lutInfo.value.state.addresses.map((addr) => addr.toBase58());
  const maxPrefix = Math.min(onChain.length, clientAddresses.length);
  for (let i = 0; i < maxPrefix; i += 1) {
    if (onChain[i] !== clientAddresses[i]) {
      throw new Error(
        `Relayer LUT contents differ from client at index ${i}. Recreate or re-sync the LUT.`
      );
    }
  }
  if (onChain.length >= clientAddresses.length) {
    return;
  }
  const missing = clientAddresses
    .slice(onChain.length)
    .map((addr) => new PublicKey(addr));
  if (missing.length === 0) {
    return;
  }
  const authority = await loadLutAuthorityKeypair();
  await extendLookupTable(lutAddress, authority, missing);
}

app.post("/execute-relayed", async (req, res) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    if (parsed.data.expiresAt && Date.now() > parsed.data.expiresAt) {
      throw new Error("Relayer intent expired");
    }
    const signer = new PublicKey(parsed.data.signer);
    if (!parsed.data.expiresAt) {
      throw new Error("Relayer intent missing expiresAt");
    }
    const expectedMessage = buildRelayerMessageText(
      parsed.data.transaction,
      signer,
      parsed.data.expiresAt,
      parsed.data.lookupTableAddresses
    );
    const messageBytes = Buffer.from(expectedMessage, "utf8");
    const providedMessageBytes = Buffer.from(parsed.data.message, "base64");
    if (!providedMessageBytes.equals(messageBytes)) {
      throw new Error("Relayer intent message mismatch");
    }
    const signatureBytes = Buffer.from(parsed.data.signature, "base64");
    const signatureValid = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      signer.toBytes()
    );
    if (!signatureValid) {
      throw new Error("Invalid relayer signature");
    }
    const relayerKeypair = await loadRelayerKeypair();
    const txBytes = Buffer.from(parsed.data.transaction, "base64");
    let signature: string;
    try {
      const tx = Transaction.from(txBytes);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      const message = tx.compileMessage();
      if (message.header.numRequiredSignatures !== 1) {
        throw new Error("Unexpected required signer count");
      }
      const feePayer = tx.feePayer ?? message.accountKeys[0];
      if (!feePayer || !feePayer.equals(relayerKeypair.publicKey)) {
        throw new Error("Fee payer mismatch");
      }
      const feePayerBalance = await connection.getBalance(feePayer);
      if (feePayerBalance === 0) {
        throw new Error(
          `Fee payer has no balance on ${connection.rpcEndpoint}: ${feePayer.toBase58()}`
        );
      }
      assertAllowedPrograms(tx.instructions.map((ix) => ix.programId));
      tx.sign(relayerKeypair);
      signature = await connection.sendRawTransaction(tx.serialize());
    } catch (error) {
      const tx = VersionedTransaction.deserialize(txBytes);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.message.recentBlockhash = blockhash;
      if (tx.message.header.numRequiredSignatures !== 1) {
        throw new Error("Unexpected required signer count");
      }
      const feePayer = tx.message.staticAccountKeys[0];
      if (!feePayer.equals(relayerKeypair.publicKey)) {
        throw new Error("Fee payer mismatch");
      }
      const feePayerBalance = await connection.getBalance(feePayer);
      if (feePayerBalance === 0) {
        throw new Error(
          `Fee payer has no balance on ${connection.rpcEndpoint}: ${feePayer.toBase58()}`
        );
      }
      const programIds = tx.message.compiledInstructions.map(
        (ix) => tx.message.staticAccountKeys[ix.programIdIndex]
      );
      assertAllowedPrograms(programIds);
      await syncLookupTableFromClient(tx, parsed.data.lookupTableAddresses);
      tx.sign([relayerKeypair]);
      try {
        signature = await connection.sendRawTransaction(tx.serialize());
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : "";
        if (message.includes("too large") && getLutAddress()) {
          const lutAccount = await tryAutoExtendLut(tx);
          if (!lutAccount) {
            throw sendError;
          }
          const decompiled = TransactionMessage.decompile(tx.message, {
            addressLookupTableAccounts: [lutAccount],
          });
          const refreshedMessage = new TransactionMessage({
            payerKey: relayerKeypair.publicKey,
            recentBlockhash: blockhash,
            instructions: decompiled.instructions,
          }).compileToV0Message([lutAccount]);
          const rebuilt = new VersionedTransaction(refreshedMessage);
          rebuilt.sign([relayerKeypair]);
          signature = await connection.sendRawTransaction(rebuilt.serialize());
        } else {
          throw sendError;
        }
      }
    }
    await connection.confirmTransaction(signature, "confirmed");
    await assertTxSuccess(signature);
    res.json({ signature });
  } catch (error) {
    let message = error instanceof Error ? error.message : "Execution failed";
    let logs: string[] | undefined;
    if (error instanceof SendTransactionError) {
      try {
        logs = await error.getLogs(connection);
      } catch {
        logs = undefined;
      }
    } else if (error && typeof (error as any).getLogs === "function") {
      try {
        logs = await (error as any).getLogs(connection);
      } catch {
        logs = undefined;
      }
    }
    res.status(500).json({ error: message, logs });
  }
});
