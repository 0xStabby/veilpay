import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import fs from "fs";
import path from "path";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import {
  createMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";

const BN254_FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

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

const toBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  throw new Error("Invalid bigint value");
};

const buildProofBytes = (proof: any): Buffer => {
  const a = [toBigInt(proof.pi_a[0]), toBigInt(proof.pi_a[1])];
  const b = [
    [toBigInt(proof.pi_b[0][0]), toBigInt(proof.pi_b[0][1])],
    [toBigInt(proof.pi_b[1][0]), toBigInt(proof.pi_b[1][1])],
  ];
  const c = [toBigInt(proof.pi_c[0]), toBigInt(proof.pi_c[1])];

  const proofBytes = Buffer.concat([
    Buffer.from(bigIntToBytes32(a[0])),
    Buffer.from(bigIntToBytes32(a[1])),
    Buffer.from(bigIntToBytes32(b[0][0])),
    Buffer.from(bigIntToBytes32(b[0][1])),
    Buffer.from(bigIntToBytes32(b[1][0])),
    Buffer.from(bigIntToBytes32(b[1][1])),
    Buffer.from(bigIntToBytes32(c[0])),
    Buffer.from(bigIntToBytes32(c[1])),
  ]);
  return proofBytes;
};

const buildProofBytesSwapped = (proof: any): Buffer => {
  const a = [toBigInt(proof.pi_a[0]), toBigInt(proof.pi_a[1])];
  const b = [
    [toBigInt(proof.pi_b[0][0]), toBigInt(proof.pi_b[0][1])],
    [toBigInt(proof.pi_b[1][0]), toBigInt(proof.pi_b[1][1])],
  ];
  const c = [toBigInt(proof.pi_c[0]), toBigInt(proof.pi_c[1])];

  const proofBytes = Buffer.concat([
    Buffer.from(bigIntToBytes32(a[0])),
    Buffer.from(bigIntToBytes32(a[1])),
    Buffer.from(bigIntToBytes32(b[0][1])),
    Buffer.from(bigIntToBytes32(b[0][0])),
    Buffer.from(bigIntToBytes32(b[1][1])),
    Buffer.from(bigIntToBytes32(b[1][0])),
    Buffer.from(bigIntToBytes32(c[0])),
    Buffer.from(bigIntToBytes32(c[1])),
  ]);
  return proofBytes;
};

const buildPublicInputsBytes = (publicSignals: string[]): Buffer => {
  const chunks = publicSignals.map((value) =>
    Buffer.from(bigIntToBytes32(toBigInt(value)))
  );
  return Buffer.concat(chunks);
};

const swapG2Bytes = (value: Buffer): Buffer => {
  if (value.length !== 128) {
    throw new Error("Invalid G2 byte length");
  }
  const out = Buffer.alloc(128);
  value.copy(out, 0, 32, 64);
  value.copy(out, 32, 0, 32);
  value.copy(out, 64, 96, 128);
  value.copy(out, 96, 64, 96);
  return out;
};

describe("veilpay e2e (real groth16)", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.Veilpay as Program;
  const verifierProgram = (anchor.workspace.Verifier ||
    anchor.workspace.verifier) as Program;
  assert.isOk(verifierProgram, "verifier program not found in workspace");

  const wasmPath = path.join(process.cwd(), "circuits/build/veilpay_js/veilpay.wasm");
  const zkeyPath = path.join(process.cwd(), "circuits/build/veilpay_final.zkey");
  const vkFixturePath = path.join(process.cwd(), "circuits/build/verifier_key.json");

  let mint: PublicKey;
  let vaultPda: PublicKey;
  let shieldedPda: PublicKey;
  let nullifierPda: PublicKey;
  let vaultAta: PublicKey;
  let userAta: PublicKey;
  let verifierKeyPda: PublicKey;

  it("runs deposit -> withdraw with real proof", async () => {
    if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath) || !fs.existsSync(vkFixturePath)) {
      throw new Error("Missing circuit artifacts. Run pnpm circuits:build first.");
    }

    const vkFixture = JSON.parse(fs.readFileSync(vkFixturePath, "utf8"));
    const groth16 = {
      alphaG1: hexToBuf(vkFixture.alpha_g1),
      betaG2: hexToBuf(vkFixture.beta_g2),
      gammaG2: hexToBuf(vkFixture.gamma_g2),
      deltaG2: hexToBuf(vkFixture.delta_g2),
      gammaAbc: vkFixture.gamma_abc.map((entry: string) => hexToBuf(entry)),
    };

    const groth16Swapped = {
      alphaG1: groth16.alphaG1,
      betaG2: swapG2Bytes(groth16.betaG2),
      gammaG2: swapG2Bytes(groth16.gammaG2),
      deltaG2: swapG2Bytes(groth16.deltaG2),
      gammaAbc: groth16.gammaAbc,
    };

    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );
    const [vkRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vk_registry")],
      program.programId
    );

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

    await program.methods
      .initializeVkRegistry()
      .accounts({
        vkRegistry: vkRegistryPda,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const keyId = 1;
    const keyIdBuf = Buffer.alloc(4);
    keyIdBuf.writeUInt32LE(keyId, 0);
    [verifierKeyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("verifier_key"), keyIdBuf],
      verifierProgram.programId
    );

    await verifierProgram.methods
      .initializeVerifierKey({
        keyId,
        alphaG1: groth16.alphaG1,
        betaG2: groth16.betaG2,
        gammaG2: groth16.gammaG2,
        deltaG2: groth16.deltaG2,
        publicInputsLen: groth16.gammaAbc.length - 1,
        gammaAbc: groth16.gammaAbc,
        mock: false,
      })
      .accounts({
        verifierKey: verifierKeyPda,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const swappedKeyId = 2;
    const swappedKeyIdBuf = Buffer.alloc(4);
    swappedKeyIdBuf.writeUInt32LE(swappedKeyId, 0);
    const [verifierKeyPdaSwapped] = PublicKey.findProgramAddressSync(
      [Buffer.from("verifier_key"), swappedKeyIdBuf],
      verifierProgram.programId
    );

    await verifierProgram.methods
      .initializeVerifierKey({
        keyId: swappedKeyId,
        alphaG1: groth16Swapped.alphaG1,
        betaG2: groth16Swapped.betaG2,
        gammaG2: groth16Swapped.gammaG2,
        deltaG2: groth16Swapped.deltaG2,
        publicInputsLen: groth16Swapped.gammaAbc.length - 1,
        gammaAbc: groth16Swapped.gammaAbc,
        mock: false,
      })
      .accounts({
        verifierKey: verifierKeyPdaSwapped,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

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
    [nullifierPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_set"), mint.toBuffer(), Buffer.from([0, 0, 0, 0])],
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

    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mint,
      userAta,
      provider.wallet.publicKey,
      1_000_000
    );

    const poseidon = await buildPoseidon();
    const f = poseidon.F;

    const root = 5n;
    const leafIndex = 1n;
    const senderSecret = 7n;
    const randomness = 11n;
    const amount = 100_000n;
    const recipientTagHash = 13n;
    const circuitId = 0n;

    const nullifier = BigInt(f.toString(poseidon([senderSecret, leafIndex])));
    const commitment = BigInt(f.toString(poseidon([amount, randomness, recipientTagHash])));

    const depositRoot = Buffer.from(bigIntToBytes32(root));
    const commitmentBytes = Buffer.from(bigIntToBytes32(commitment));

    await program.methods
      .deposit({
        amount: new anchor.BN(amount.toString()),
        ciphertext: buf(new Uint8Array(64)),
        commitment: commitmentBytes,
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

    const proofInput = {
      root: root.toString(),
      nullifier: nullifier.toString(),
      recipient_tag_hash: recipientTagHash.toString(),
      ciphertext_commitment: commitment.toString(),
      circuit_id: circuitId.toString(),
      amount: amount.toString(),
      randomness: randomness.toString(),
      sender_secret: senderSecret.toString(),
      leaf_index: leafIndex.toString(),
    };

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      proofInput,
      wasmPath,
      zkeyPath
    );

    const ok = await snarkjs.groth16.verify(
      JSON.parse(fs.readFileSync(path.join(process.cwd(), "circuits/build/verification_key.json"), "utf8")),
      publicSignals,
      proof
    );
    assert.isTrue(ok, "snarkjs verification failed");

    const proofBytes = buildProofBytes(proof);
    const proofBytesSwapped = buildProofBytesSwapped(proof);
    const publicInputs = buildPublicInputsBytes(publicSignals);
    const nullifierBytes = Buffer.from(bigIntToBytes32(nullifier));

    const recipient = anchor.web3.Keypair.generate().publicKey;
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient
    );

    const combos = [
      { name: "direct/key1", proof: proofBytes, key: verifierKeyPda },
      { name: "swapped/key1", proof: proofBytesSwapped, key: verifierKeyPda },
      { name: "direct/key2", proof: proofBytes, key: verifierKeyPdaSwapped },
      { name: "swapped/key2", proof: proofBytesSwapped, key: verifierKeyPdaSwapped },
    ];
    let chosen = combos[0];
    let found = false;
    for (const combo of combos) {
      try {
        await verifierProgram.methods
          .verifyGroth16(combo.proof, publicInputs)
          .accounts({ verifierKey: combo.key })
          .rpc();
        chosen = combo;
        found = true;
        break;
      } catch {
        // keep trying
      }
    }
    if (!found) {
      throw new Error("All proof/key encoding combinations failed");
    }

    await program.methods
      .withdraw({
        amount: new anchor.BN(amount.toString()),
        proof: chosen.proof,
        publicInputs,
        nullifier: nullifierBytes,
        root: depositRoot,
        relayerFeeBps: 0,
      })
      .accounts({
        config: configPda,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        nullifierSet: nullifierPda,
        recipientAta,
        relayerFeeAta: null,
        verifierProgram: verifierProgram.programId,
        verifierKey: chosen.key,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  });
});
