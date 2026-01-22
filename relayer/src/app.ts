import express, { type Express } from "express";
import cors from "cors";
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
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
});

const connection = new Connection(process.env.RELAYER_RPC_URL || "http://127.0.0.1:8899", "confirmed");
let cachedRelayerKeypair: Keypair | null = null;

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

app.post("/execute-relayed", async (req, res) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
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
    } catch {
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
      tx.sign([relayerKeypair]);
      signature = await connection.sendRawTransaction(tx.serialize());
    }
    await connection.confirmTransaction(signature, "confirmed");
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
