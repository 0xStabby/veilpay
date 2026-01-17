import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import fs from "fs";
import path from "path";
import {
  createMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";

const NULLIFIER = new Uint8Array(32);
NULLIFIER[0] = 0;
NULLIFIER[1] = 0;
NULLIFIER[2] = 0;
NULLIFIER[3] = 0;
NULLIFIER[4] = 3;
NULLIFIER[5] = 0;

const ROOT = new Uint8Array(32);
ROOT[0] = 9;

const NEW_ROOT = new Uint8Array(32);
NEW_ROOT[0] = 10;

const CIPHERTEXT = new Uint8Array(64);
const COMMITMENT = new Uint8Array(32);
const buf = (value: Uint8Array) => Buffer.from(value);

const fixturePath = path.join(process.cwd(), "tests/fixtures/groth16.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const hexToBuf = (hex: string) => Buffer.from(hex, "hex");
const groth16 = {
  alphaG1: hexToBuf(fixture.alpha_g1),
  betaG2: hexToBuf(fixture.beta_g2),
  gammaG2: hexToBuf(fixture.gamma_g2),
  deltaG2: hexToBuf(fixture.delta_g2),
  gammaAbc: fixture.gamma_abc.map((entry: string) => hexToBuf(entry)),
  proof: hexToBuf(fixture.proof),
  publicInputs: Buffer.concat(
    fixture.public_inputs.map((entry: string) => hexToBuf(entry))
  ),
};

describe("veilpay", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.Veilpay as Program;
  const verifierProgram = (anchor.workspace.Verifier ||
    anchor.workspace.verifier) as Program;
  assert.isOk(verifierProgram, "verifier program not found in workspace");

  let mint: PublicKey;
  let vaultPda: PublicKey;
  let shieldedPda: PublicKey;
  let nullifierPda: PublicKey;
  let vaultAta: PublicKey;
  let userAta: PublicKey;
  let verifierKeyPda: PublicKey;
  const relayer = Keypair.generate();

  it("initializes config and registry", async () => {
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

    const keyId = 0;
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
          publicInputsLen: fixture.public_inputs.length,
          gammaAbc: groth16.gammaAbc,
          mock: true,
        })
        .accounts({
          verifierKey: verifierKeyPda,
          admin: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    await verifierProgram.methods
      .verifyGroth16(groth16.proof, groth16.publicInputs)
      .accounts({
        verifierKey: verifierKeyPda,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.feeBps, 25);
  });

  it("registers mint and initializes mint state", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );

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
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(vaultAtaIx));

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

    const vault = await program.account.vaultPool.fetch(vaultPda);
    assert.equal(vault.mint.toBase58(), mint.toBase58());
  });

  it("deposits and withdraws with mock proof", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );

    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mint,
      userAta,
      provider.wallet.publicKey,
      1_000_000
    );

    await program.methods
      .deposit({
        amount: new anchor.BN(500_000),
        ciphertext: buf(CIPHERTEXT),
        commitment: buf(COMMITMENT),
        newRoot: buf(NEW_ROOT),
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

    const recipient = Keypair.generate();
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );

    await program.methods
      .withdraw({
        amount: new anchor.BN(100_000),
        proof: groth16.proof,
        publicInputs: groth16.publicInputs,
        nullifier: buf(NULLIFIER),
        root: buf(NEW_ROOT),
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
        verifierKey: verifierKeyPda,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const recipientAccount = await getAccount(provider.connection, recipientAta);
    assert.equal(Number(recipientAccount.amount), 100_000);
  });

  it("pays relayer fee on withdraw", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );

    const relayerAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      relayer.publicKey
    );

    const recipient = Keypair.generate();
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );

    const feeNullifier = new Uint8Array(32);
    feeNullifier[0] = 0;
    feeNullifier[4] = 9;

    await program.methods
      .withdraw({
        amount: new anchor.BN(100_000),
        proof: groth16.proof,
        publicInputs: groth16.publicInputs,
        nullifier: buf(feeNullifier),
        root: buf(NEW_ROOT),
        relayerFeeBps: 25,
      })
      .accounts({
        config: configPda,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        nullifierSet: nullifierPda,
        recipientAta,
        relayerFeeAta: relayerAta,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const recipientAccount = await getAccount(provider.connection, recipientAta);
    const relayerAccount = await getAccount(provider.connection, relayerAta);
    assert.equal(Number(recipientAccount.amount), 99_750);
    assert.equal(Number(relayerAccount.amount), 250);
  });

  it("prevents double spend", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );
    const recipient = Keypair.generate();
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );

    let threw = false;
    try {
      await program.methods
        .withdraw({
          amount: new anchor.BN(10_000),
          proof: groth16.proof,
          publicInputs: groth16.publicInputs,
          nullifier: buf(NULLIFIER),
          root: buf(NEW_ROOT),
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
          verifierKey: verifierKeyPda,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw);
  });

  it("rejects unknown roots", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );
    const recipient = Keypair.generate();
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );

    const newNullifier = new Uint8Array(32);
    newNullifier[0] = 0;
    newNullifier[4] = 8;

    let threw = false;
    try {
      await program.methods
      .withdraw({
        amount: new anchor.BN(10_000),
        proof: groth16.proof,
        publicInputs: groth16.publicInputs,
        nullifier: buf(newNullifier),
        root: buf(ROOT),
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
          verifierKey: verifierKeyPda,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw);
  });

  it("creates and settles authorization", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );

    const intentHash = new Uint8Array(32);
    intentHash[0] = 7;
    const [authPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("auth"), Buffer.from(intentHash)],
      program.programId
    );

    await program.methods
      .createAuthorization({
        intentHash: buf(intentHash),
        payeeTagHash: buf(new Uint8Array(32)),
        mint,
        amountCiphertext: buf(CIPHERTEXT),
        expirySlot: new anchor.BN(0),
        circuitId: 0,
        proofHash: buf(new Uint8Array(32)),
        relayerPubkey: relayer.publicKey,
      })
      .accounts({
        config: configPda,
        authorization: authPda,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const recipient = Keypair.generate();
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );

    const newNullifier = new Uint8Array(32);
    newNullifier[0] = 0;
    newNullifier[4] = 7;

    await program.methods
      .settleAuthorization({
        amount: new anchor.BN(50_000),
        proof: groth16.proof,
        publicInputs: groth16.publicInputs,
        nullifier: buf(newNullifier),
        root: buf(NEW_ROOT),
        relayerFeeBps: 0,
      })
      .accounts({
        config: configPda,
        authorization: authPda,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        nullifierSet: nullifierPda,
        recipientAta,
        relayerFeeAta: null,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const auth = await program.account.authorization.fetch(authPda);
    assert.equal(auth.status, 1);
  });

  it("supports internal and external transfers", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );

    const internalNullifier = new Uint8Array(32);
    internalNullifier[0] = 0;
    internalNullifier[4] = 11;
    const internalRoot = new Uint8Array(32);
    internalRoot[0] = 55;

    await program.methods
      .internalTransfer({
        proof: groth16.proof,
        publicInputs: groth16.publicInputs,
        nullifier: buf(internalNullifier),
        root: buf(NEW_ROOT),
        newRoot: buf(internalRoot),
        ciphertextNew: buf(CIPHERTEXT),
        recipientTagHash: buf(new Uint8Array(32)),
      })
      .accounts({
        config: configPda,
        shieldedState: shieldedPda,
        nullifierSet: nullifierPda,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint,
      })
      .rpc();

    const shielded = await program.account.shieldedState.fetch(shieldedPda);
    assert.equal(shielded.merkleRoot[0], internalRoot[0]);

    const externalNullifier = new Uint8Array(32);
    externalNullifier[0] = 0;
    externalNullifier[4] = 12;

    const recipient = Keypair.generate();
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );

    await program.methods
      .externalTransfer({
        amount: new anchor.BN(25_000),
        proof: groth16.proof,
        publicInputs: groth16.publicInputs,
        nullifier: buf(externalNullifier),
        root: buf(internalRoot),
        relayerFeeBps: 0,
      })
      .accounts({
        config: configPda,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        nullifierSet: nullifierPda,
        destinationAta: recipientAta,
        relayerFeeAta: null,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const recipientAccount = await getAccount(provider.connection, recipientAta);
    assert.equal(Number(recipientAccount.amount), 25_000);
  });
});
