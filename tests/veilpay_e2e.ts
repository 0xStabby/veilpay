import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import * as snarkjs from "snarkjs";
import {
  createMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";

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
  let vaultAta: PublicKey;
  let userAta: PublicKey;
  let verifierKeyPda: PublicKey;

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
        payer: provider.wallet.publicKey,
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

    const recipient = anchor.web3.Keypair.generate().publicKey;
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient
    );

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
      })
      .accounts({
        config: configPda,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: nullifierPda,
        recipientAta,
        relayerFeeAta: null,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  });
});
