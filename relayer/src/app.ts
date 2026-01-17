import express, { type Express } from "express";
import cors from "cors";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { z } from "zod";
import nacl from "tweetnacl";
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

const intentSchema = z.object({
  intentHash: z.string(),
  mint: z.string(),
  payeeTagHash: z.string(),
  amountCiphertext: z.string(),
  expirySlot: z.string(),
  circuitId: z.number(),
  proofHash: z.string(),
  payer: z.string(),
  relayerPubkey: z.string().optional(),
  signature: z.string(),
  domain: z.string(),
});

app.post("/intent", (req, res) => {
  const parsed = intentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const intentHash = decodeBase64(parsed.data.intentHash, 32);
  const signature = decodeBase64(parsed.data.signature, 64);
  if (!intentHash || !signature) {
    res.status(400).json({ error: "Invalid signature payload" });
    return;
  }
  let payer: PublicKey;
  try {
    payer = new PublicKey(parsed.data.payer);
  } catch {
    res.status(400).json({ error: "Invalid payer" });
    return;
  }
  const message = Buffer.concat([
    Buffer.from(parsed.data.domain),
    Buffer.from(intentHash),
  ]);
  const ok = nacl.sign.detached.verify(
    message,
    new Uint8Array(signature),
    payer.toBytes()
  );
  if (!ok) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }
  res.json({ id: parsed.data.intentHash });
});

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

app.post("/execute", async (req, res) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const txBytes = Buffer.from(parsed.data.transaction, "base64");
    const tx = Transaction.from(txBytes);
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(signature, "confirmed");
    res.json({ signature });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execution failed";
    res.status(500).json({ error: message });
  }
});

function decodeBase64(value: string, expectedLen: number): Buffer | null {
  try {
    const buf = Buffer.from(value, "base64");
    if (buf.length !== expectedLen) {
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}
