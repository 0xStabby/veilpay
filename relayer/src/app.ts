import express from "express";
import cors from "cors";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { z } from "zod";
import nacl from "tweetnacl";

export const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

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

app.post("/proof", (_req, res) => {
  res.json({ ok: true });
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
