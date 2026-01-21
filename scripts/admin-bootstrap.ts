import fs from "fs";
import path from "path";
import os from "os";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SendTransactionError, SystemProgram, Transaction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import {
  deriveConfig,
  deriveIdentityRegistry,
  deriveNullifierSet,
  deriveShielded,
  deriveVault,
  deriveVkRegistry,
  deriveVerifierKey,
} from "../sdk/src/pda";

type EnvMap = Record<string, string>;

const DEFAULT_ENV_PATH = path.resolve(process.cwd(), ".env.dev");
const DEFAULT_WRAP_AMOUNT = "1";

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

const hexToBuffer = (hex: string): Buffer => Buffer.from(hex, "hex");

const parseTokenAmount = (amount: string, decimals: number): bigint => {
  const normalized = amount.trim();
  if (!normalized) throw new Error("Missing amount");
  const [whole, frac = ""] = normalized.split(".");
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  if (frac.length > decimals) {
    throw new Error(`Too many decimal places for amount: ${amount}`);
  }
  const padded = frac.padEnd(decimals, "0");
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return BigInt(combined || "0");
};

async function confirmFinalized(connection: Connection, signature: string) {
  await connection.confirmTransaction(signature, "finalized");
}

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const envPath = envIndex >= 0 ? args[envIndex + 1] : DEFAULT_ENV_PATH;
const wrapIndex = args.indexOf("--wsol-amount");
const wrapAmount = wrapIndex >= 0 ? args[wrapIndex + 1] : process.env.WSOL_WRAP_AMOUNT || DEFAULT_WRAP_AMOUNT;

async function main() {
  const env = loadEnv(envPath);
  const rpc = env.RPC_URL;
  const veilpayId = env.VITE_VEILPAY_PROGRAM_ID;
  const verifierId = env.VITE_VERIFIER_PROGRAM_ID;
  if (!rpc || !veilpayId || !verifierId) {
    throw new Error("Missing VITE_RPC_ENDPOINT or program IDs in app env.");
  }

  const connection = new Connection(rpc, "confirmed");
  const keypair = loadKeypair();
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const veilpayIdlPath = path.resolve(process.cwd(), "target", "idl", "veilpay.json");
  const verifierIdlPath = path.resolve(process.cwd(), "target", "idl", "verifier.json");
  if (!fs.existsSync(veilpayIdlPath) || !fs.existsSync(verifierIdlPath)) {
    throw new Error("Missing IDLs in target/idl. Run anchor build/deploy first.");
  }
  const veilpayIdl = JSON.parse(fs.readFileSync(veilpayIdlPath, "utf8"));
  const verifierIdl = JSON.parse(fs.readFileSync(verifierIdlPath, "utf8"));
  const veilpayProgram = new (anchor as any).Program({ ...veilpayIdl, address: veilpayId }, provider);
  const verifierProgram = new (anchor as any).Program({ ...verifierIdl, address: verifierId }, provider);

  const logClusterHealth = async (label: string) => {
    try {
      const [slot, blockhashInfo] = await Promise.all([
        connection.getSlot("confirmed"),
        connection.getLatestBlockhash("confirmed"),
      ]);
      console.error(
        `[admin-bootstrap] ${label} rpc=${connection.rpcEndpoint} slot=${slot} blockhash=${blockhashInfo.blockhash} lastValidBlockHeight=${blockhashInfo.lastValidBlockHeight}`
      );
    } catch (logError) {
      console.error(`[admin-bootstrap] ${label} failed to fetch cluster status`, logError);
    }
  };

  const sendTransactionLikeWallet = async (tx: Transaction) => {
    const { context, value } = await connection.getLatestBlockhashAndContext("confirmed");
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = value.blockhash;
    tx.sign(keypair);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      minContextSlot: context.slot,
    });
    await connection.confirmTransaction(
      { signature, blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight },
      "confirmed"
    );
    return signature;
  };

  const sendWithLogs = async <T>(label: string, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      console.error(`[admin-bootstrap] ${label} failed`);
      await logClusterHealth(label);
      if (error instanceof SendTransactionError) {
        const logs = await error.getLogs(connection);
        if (logs?.length) {
          console.error(logs.join("\n"));
        }
      } else if (error && typeof (error as { logs?: unknown }).logs !== "undefined") {
        console.error((error as { logs?: unknown }).logs);
      }
      throw error;
    }
  };

  console.log("Checking admin SOL balance...");
  const balance = await connection.getBalance(wallet.publicKey);
  if (balance < 0.5 * 1e9) {
    console.log("Balance low, requesting airdrop...");
    const sig = await sendWithLogs("requestAirdrop", () =>
      connection.requestAirdrop(wallet.publicKey, 2 * 1e9)
    );
    await confirmFinalized(connection, sig);
    console.log("Airdrop finalized.");
  }

  const config = deriveConfig(veilpayProgram.programId);
  const vkRegistry = deriveVkRegistry(veilpayProgram.programId);
  const identityRegistry = deriveIdentityRegistry(veilpayProgram.programId);
  const configInfo = await connection.getAccountInfo(config);
  if (!configInfo) {
    console.log("Initializing config...");
    const sig = await sendWithLogs("initializeConfig", () =>
      veilpayProgram.methods
        .initializeConfig({
          feeBps: 25,
          relayerFeeBpsMax: 50,
          vkRegistry,
          mintAllowlist: [],
          circuitIds: [0],
        })
        .accounts({
          config,
          admin: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    await confirmFinalized(connection, sig);
    console.log("Config initialized.");
  } else {
    console.log("Config already initialized.");
  }

  const vkRegistryInfo = await connection.getAccountInfo(vkRegistry);
  if (!vkRegistryInfo) {
    console.log("Initializing VK registry...");
    const sig = await sendWithLogs("initializeVkRegistry", () =>
      veilpayProgram.methods
        .initializeVkRegistry()
        .accounts({
          vkRegistry,
          admin: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    await confirmFinalized(connection, sig);
    console.log("VK registry initialized.");
  } else {
    console.log("VK registry already initialized.");
  }

  const identityRegistryInfo = await connection.getAccountInfo(identityRegistry);
  if (!identityRegistryInfo) {
    console.log("Initializing identity registry...");
    const sig = await sendWithLogs("initializeIdentityRegistry", () =>
      veilpayProgram.methods
        .initializeIdentityRegistry()
        .accounts({
          identityRegistry,
          admin: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    await confirmFinalized(connection, sig);
    console.log("Identity registry initialized.");
  } else {
    console.log("Identity registry already initialized.");
  }

  const verifierKeyPda = deriveVerifierKey(verifierProgram.programId, 0);
  const verifierKeyInfo = await connection.getAccountInfo(verifierKeyPda);
  if (!verifierKeyInfo) {
    console.log("Initializing verifier key...");
    const fixturePath = path.resolve(process.cwd(), "app", "src", "fixtures", "verifier_key.json");
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Missing verifier key fixture: ${fixturePath}`);
    }
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const gammaAbc = fixture.gamma_abc.map((entry: string) => hexToBuffer(entry));
    const sig = await sendWithLogs("initializeVerifierKey", () =>
      verifierProgram.methods
        .initializeVerifierKey({
          keyId: 0,
          alphaG1: hexToBuffer(fixture.alpha_g1),
          betaG2: hexToBuffer(fixture.beta_g2),
          gammaG2: hexToBuffer(fixture.gamma_g2),
          deltaG2: hexToBuffer(fixture.delta_g2),
          publicInputsLen: gammaAbc.length - 1,
          gammaAbc,
          mock: false,
        })
        .accounts({
          verifierKey: verifierKeyPda,
          admin: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    await confirmFinalized(connection, sig);
    console.log("Verifier key initialized.");
  } else {
    const fixturePath = path.resolve(process.cwd(), "app", "src", "fixtures", "verifier_key.json");
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Missing verifier key fixture: ${fixturePath}`);
    }
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const onchain = await (verifierProgram.account as any).verifierKey.fetch(verifierKeyPda);
    const matches =
      Buffer.from(onchain.alphaG1).equals(hexToBuffer(fixture.alpha_g1)) &&
      Buffer.from(onchain.betaG2).equals(hexToBuffer(fixture.beta_g2)) &&
      Buffer.from(onchain.gammaG2).equals(hexToBuffer(fixture.gamma_g2)) &&
      Buffer.from(onchain.deltaG2).equals(hexToBuffer(fixture.delta_g2)) &&
      Array.isArray(onchain.gammaAbc) &&
      onchain.gammaAbc.length === fixture.gamma_abc.length &&
      onchain.gammaAbc.every((entry: number[], idx: number) =>
        Buffer.from(entry).equals(hexToBuffer(fixture.gamma_abc[idx]))
      );
    if (!matches) {
      throw new Error(
        "Verifier key on-chain does not match app fixtures. Re-run setup-devnet.sh --reset-keys (and build circuits) to reinitialize."
      );
    }
    console.log("Verifier key already initialized.");
  }

  const mint = NATIVE_MINT;
  const configAccount = await (veilpayProgram.account as any).config.fetch(config);
  const alreadyRegistered = configAccount.mintAllowlist.some((entry: PublicKey) => entry.equals(mint));
  if (!alreadyRegistered) {
    console.log("Registering mint...");
    const sig = await sendWithLogs("registerMint", () =>
      veilpayProgram.methods
        .registerMint(mint)
        .accounts({ config, admin: wallet.publicKey })
        .rpc()
    );
    await confirmFinalized(connection, sig);
    console.log("Mint registered.");
  } else {
    console.log("Mint already registered.");
  }

  const vault = deriveVault(veilpayProgram.programId, mint);
  const shieldedState = deriveShielded(veilpayProgram.programId, mint);
  const nullifierSet = deriveNullifierSet(veilpayProgram.programId, mint, 0);
  const vaultInfo = await connection.getAccountInfo(vault);
  const shieldedInfo = await connection.getAccountInfo(shieldedState);
  const nullifierInfo = await connection.getAccountInfo(nullifierSet);
  if (!vaultInfo || !shieldedInfo || !nullifierInfo) {
    console.log("Initializing mint state and token accounts...");
    const vaultAta = await getAssociatedTokenAddress(mint, vault, true);
    const adminAta = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const instructions = [];
    try {
      await getAccount(connection, adminAta);
    } catch {
      instructions.push(createAssociatedTokenAccountInstruction(wallet.publicKey, adminAta, wallet.publicKey, mint));
    }
    try {
      await getAccount(connection, vaultAta);
    } catch {
      instructions.push(createAssociatedTokenAccountInstruction(wallet.publicKey, vaultAta, vault, mint));
    }
    if (instructions.length > 0) {
      console.log("Creating associated token accounts...");
      const sig = await sendWithLogs("createTokenAccounts", () =>
        sendTransactionLikeWallet(new Transaction().add(...instructions))
      );
      await confirmFinalized(connection, sig);
      console.log("Token accounts created.");
    }

    console.log("Initializing mint state...");
    const sig = await sendWithLogs("initializeMintState", () =>
      veilpayProgram.methods
        .initializeMintState(0)
        .accounts({
          config,
          vault,
          vaultAta,
          shieldedState,
          nullifierSet,
          admin: wallet.publicKey,
          mint,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    await confirmFinalized(connection, sig);
    console.log("Mint state initialized.");
  } else {
    console.log("Mint state already initialized.");
  }

  const mintInfo = await getMint(connection, mint);
  const lamports = parseTokenAmount(wrapAmount, mintInfo.decimals);
  if (lamports > 0n) {
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
    let current = 0n;
    try {
      const account = await getAccount(connection, ata);
      current = account.amount;
    } catch {
      current = 0n;
    }
    if (current < lamports) {
      console.log("Wrapping SOL into WSOL...");
      const instructions = [];
      try {
        await getAccount(connection, ata);
      } catch {
        instructions.push(createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint));
      }
      if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WSOL wrap amount is too large.");
      }
      instructions.push(
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata, lamports: Number(lamports) }),
        createSyncNativeInstruction(ata)
      );
      const sig = await sendWithLogs("wrapWsol", () =>
        sendTransactionLikeWallet(new Transaction().add(...instructions))
      );
      await confirmFinalized(connection, sig);
      console.log("WSOL wrapped.");
    } else {
      console.log("WSOL balance already sufficient.");
    }
  } else {
    console.log("Skipping WSOL wrap (amount is 0).");
  }

  console.log("Admin bootstrap complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
