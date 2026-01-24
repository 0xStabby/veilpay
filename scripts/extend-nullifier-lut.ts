import fs from "fs";
import path from "path";
import os from "os";
import * as anchor from "@coral-xyz/anchor";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { deriveConfig, deriveNullifierSet } from "../sdk/src/pda";

type EnvMap = Record<string, string>;

const DEFAULT_ENV_PATH = path.resolve(process.cwd(), ".env.devnet");

const loadEnv = (filePath: string): EnvMap => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing env file: ${filePath}`);
  }
  const out: EnvMap = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!key) continue;
    out[key] = rest.join("=");
  }
  return out;
};

const loadKeypair = (): Keypair => {
  const walletPath =
    process.env.ANCHOR_WALLET ||
    path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Missing deployer keypair: ${walletPath}`);
  }
  const secret = JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[];
  return Keypair.fromSecretKey(new Uint8Array(secret));
};

async function confirmFinalized(connection: Connection, signature: string) {
  await connection.confirmTransaction(signature, "finalized");
}

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const envPath = envIndex >= 0 ? args[envIndex + 1] : DEFAULT_ENV_PATH;
const startIndex = Number(args[args.indexOf("--start") + 1] || "0");
const countIndex = Number(args[args.indexOf("--count") + 1] || "0");

async function main() {
  if (!Number.isFinite(startIndex) || startIndex < 0) {
    throw new Error("Missing or invalid --start");
  }
  if (!Number.isFinite(countIndex) || countIndex <= 0) {
    throw new Error("Missing or invalid --count");
  }

  const env = loadEnv(envPath);
  const rpc = env.RPC_URL;
  const veilpayId = env.VITE_VEILPAY_PROGRAM_ID;
  const lutAddressRaw = env.VITE_LUT_ADDRESS;
  if (!rpc || !veilpayId || !lutAddressRaw) {
    throw new Error("Missing RPC_URL, VITE_VEILPAY_PROGRAM_ID, or VITE_LUT_ADDRESS in env.");
  }

  const connection = new Connection(rpc, "confirmed");
  const keypair = loadKeypair();
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const veilpayIdlPath = path.resolve(process.cwd(), "target", "idl", "veilpay.json");
  if (!fs.existsSync(veilpayIdlPath)) {
    throw new Error("Missing veilpay IDL in target/idl. Run anchor build/deploy first.");
  }
  const veilpayIdl = JSON.parse(fs.readFileSync(veilpayIdlPath, "utf8"));
  const veilpayProgram = new (anchor as any).Program(
    { ...veilpayIdl, address: veilpayId },
    provider
  );

  const lutAddress = new PublicKey(lutAddressRaw);
  const lutInfo = await connection.getAddressLookupTable(lutAddress);
  if (!lutInfo.value) {
    throw new Error(`Lookup table not found: ${lutAddress.toBase58()}`);
  }

  const mint = NATIVE_MINT;
  const config = deriveConfig(veilpayProgram.programId);
  const addresses: PublicKey[] = [];
  for (let i = 0; i < countIndex; i += 1) {
    const chunkIndex = startIndex + i;
    const nullifierSet = deriveNullifierSet(veilpayProgram.programId, mint, chunkIndex);
    const info = await connection.getAccountInfo(nullifierSet);
    if (!info) {
      const sig = await veilpayProgram.methods
        .initializeNullifierChunk(chunkIndex)
        .accounts({
          config,
          nullifierSet,
          payer: wallet.publicKey,
          mint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await confirmFinalized(connection, sig);
    }
    addresses.push(nullifierSet);
  }

  const chunkSize = 20;
  for (let i = 0; i < addresses.length; i += chunkSize) {
    const chunk = addresses.slice(i, i + chunkSize);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      lookupTable: lutAddress,
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      addresses: chunk,
    });
    const tx = new Transaction().add(extendIx);
    tx.feePayer = wallet.publicKey;
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(keypair);
    try {
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        preflightCommitment: "confirmed",
      });
      await confirmFinalized(connection, sig);
    } catch (error) {
      if (error instanceof SendTransactionError) {
        const logs = await error.getLogs(connection);
        if (logs?.length) {
          console.error(logs.join("\n"));
        }
      }
      throw error;
    }
  }

  console.log(
    `Extended LUT ${lutAddress.toBase58()} with nullifier chunks ${startIndex}..${startIndex + countIndex - 1}.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
