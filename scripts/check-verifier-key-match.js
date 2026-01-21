const fs = require("fs");
const os = require("os");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const { web3 } = anchor;

const loadEnv = (filePath) => {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
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

const loadKeypair = () => {
  const walletPath =
    process.env.ANCHOR_WALLET ||
    path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Missing deployer keypair: ${walletPath}`);
  }
  const secret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  return web3.Keypair.fromSecretKey(new Uint8Array(secret));
};

const deriveVerifierKey = (programId, keyId) => {
  const keyIdBuf = Buffer.alloc(4);
  keyIdBuf.writeUInt32LE(keyId, 0);
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_key"), keyIdBuf],
    programId
  );
  return pda;
};

const hex = (bytes) => Buffer.from(bytes).toString("hex");

async function main() {
  const rootDir = process.cwd();
  const env = loadEnv(path.join(rootDir, ".env.devnet"));
  const rpc =
    process.env.ANCHOR_PROVIDER_URL ||
    env.RPC_URL ||
    env.VITE_RPC_ENDPOINT;
  if (!rpc) {
    throw new Error("Missing RPC_URL or VITE_RPC_ENDPOINT in .env.devnet.");
  }

  const verifierIdlPath = path.join(rootDir, "target", "idl", "verifier.json");
  const fixturePath = path.join(rootDir, "app", "src", "fixtures", "verifier_key.json");
  if (!fs.existsSync(verifierIdlPath)) {
    throw new Error(`Missing IDL: ${verifierIdlPath}`);
  }
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Missing fixture: ${fixturePath}`);
  }

  const verifierIdl = JSON.parse(fs.readFileSync(verifierIdlPath, "utf8"));
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  const connection = new web3.Connection(rpc, "confirmed");
  const keypair = loadKeypair();
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const program = new anchor.Program(verifierIdl, provider);
  const verifierKeyPda = deriveVerifierKey(program.programId, 0);
  const onchain = await program.account.verifierKey.fetch(verifierKeyPda);

  const mismatches = [];
  if (hex(onchain.alphaG1) !== fixture.alpha_g1) mismatches.push("alpha_g1");
  if (hex(onchain.betaG2) !== fixture.beta_g2) mismatches.push("beta_g2");
  if (hex(onchain.gammaG2) !== fixture.gamma_g2) mismatches.push("gamma_g2");
  if (hex(onchain.deltaG2) !== fixture.delta_g2) mismatches.push("delta_g2");

  if (onchain.gammaAbc.length !== fixture.gamma_abc.length) {
    mismatches.push(`gamma_abc_len=${onchain.gammaAbc.length}`);
  } else {
    onchain.gammaAbc.forEach((entry, idx) => {
      if (hex(entry) !== fixture.gamma_abc[idx]) {
        mismatches.push(`gamma_abc[${idx}]`);
      }
    });
  }

  if (mismatches.length === 0) {
    console.log("onchain matches fixture: true");
  } else {
    console.log("onchain matches fixture: false");
    console.log(`mismatch: ${mismatches.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
