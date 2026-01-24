import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  createMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, Connection } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  bytesToBigIntBE,
  sha256,
  modField,
  randomBytes32,
  bigIntToBytes32,
} from "../sdk/src/crypto";
import {
  computeCommitment,
  recipientTagHashFromSecret,
  deriveRecipientKeypair,
  eciesEncrypt,
  eciesDecrypt,
} from "../sdk/src/notes";
import { rescanIdentityRegistry } from "../app/src/lib/identityScanner";
import { rescanNotesForOwner } from "../app/src/lib/noteScanner";
import {
  restoreIdentitySecret,
  loadIdentityCommitments,
  saveIdentityCommitments,
  getIdentityMerklePath,
} from "../app/src/lib/identity";
import { buildMerkleTree } from "../app/src/lib/merkle";
import { computeIdentityCommitment } from "../app/src/lib/prover";
import { selectNotesForAmount } from "../app/src/lib/notes";

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

const CIPHERTEXT = new Uint8Array(128);
const COMMITMENT = new Uint8Array(32);
const buf = (value: Uint8Array) => Buffer.from(value);

const zero32 = () => Buffer.alloc(32);
const u64ToBytes32 = (value: bigint) => {
  const out = Buffer.alloc(32);
  out.writeBigUInt64BE(value, 24);
  return out;
};
const u32ToBytes32 = (value: number) => {
  const out = Buffer.alloc(32);
  out.writeUInt32BE(value, 28);
  return out;
};
const makePublicInputs = (params: {
  root: Buffer;
  identityRoot: Buffer;
  nullifiers: Buffer[];
  outputCommitments: Buffer[];
  outputEnabled: number[];
  amountOut: bigint;
  feeAmount: bigint;
  circuitId: number;
}) => {
  const {
    root,
    identityRoot,
    nullifiers,
    outputCommitments,
    outputEnabled,
    amountOut,
    feeAmount,
    circuitId,
  } = params;
  const chunks = [
    root,
    identityRoot,
    ...nullifiers,
    ...outputCommitments,
    ...outputEnabled.map((value) => u64ToBytes32(BigInt(value))),
    u64ToBytes32(amountOut),
    u64ToBytes32(feeAmount),
    u32ToBytes32(circuitId),
  ];
  return Buffer.concat(chunks);
};

const dummyG1 = Buffer.alloc(64);
const dummyG2 = Buffer.alloc(128);
const dummyGammaAbc = [Buffer.alloc(64)];
const dummyProof = Buffer.alloc(32);

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

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
  let identityRegistryPda: PublicKey;
  let identityMemberPda: PublicKey;
  let identityCommitment: bigint | null = null;
  let vaultAta: PublicKey;
  let userAta: PublicKey;
  let verifierKeyPda: PublicKey;
  const relayer = Keypair.generate();

  before(() => {
    if (!(globalThis as any).crypto?.subtle) {
      (globalThis as any).crypto = require("crypto").webcrypto;
    }
    if (!(globalThis as any).localStorage) {
      (globalThis as any).localStorage = new MemoryStorage();
    }
  });

  const getRoots = async () => {
    const shielded = await program.account.shieldedState.fetch(shieldedPda);
    const identity = await program.account.identityRegistry.fetch(identityRegistryPda);
    const rootBytes =
      Buffer.from(
        (shielded.merkleRoot as number[] | undefined) ??
          (shielded.merkle_root as number[] | undefined) ??
          []
      );
    const identityRootBytes =
      Buffer.from(
        (identity.merkleRoot as number[] | undefined) ??
          (identity.merkle_root as number[] | undefined) ??
          []
      );
    return { rootBytes, identityRootBytes };
  };

  it("initializes config and registry", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );

    const [vkRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vk_registry")],
      program.programId
    );
    [identityRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("identity_registry")],
      program.programId
    );
    [identityMemberPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("identity_member"), provider.wallet.publicKey.toBuffer()],
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
          alphaG1: dummyG1,
          betaG2: dummyG2,
          gammaG2: dummyG2,
          deltaG2: dummyG2,
          publicInputsLen: 13,
          gammaAbc: dummyGammaAbc,
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
      .verifyGroth16(dummyProof, Buffer.concat(Array.from({ length: 13 }, () => zero32())))
      .accounts({
        verifierKey: verifierKeyPda,
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

    const memberInfo = await provider.connection.getAccountInfo(identityMemberPda);
    if (!memberInfo) {
      const owner = provider.wallet.publicKey;
      const signMessage = async (message: Uint8Array) =>
        nacl.sign.detached(message, provider.wallet.payer.secretKey);
      const secretBytes = await restoreIdentitySecret(owner, program.programId, signMessage);
      const secret = modField(bytesToBigIntBE(secretBytes));
      const commitment = await computeIdentityCommitment(secret);
      console.log(
        `[identity-rescan] debug registered commitment=${Buffer.from(bigIntToBytes32(commitment)).toString("hex")}`
      );
      identityCommitment = commitment;
      const { root } = await buildMerkleTree([commitment]);
      await program.methods
        .registerIdentity({
          commitment: buf(bigIntToBytes32(commitment)),
          newRoot: buf(bigIntToBytes32(root)),
        })
        .accounts({
          identityRegistry: identityRegistryPda,
          identityMember: identityMemberPda,
          payer: owner,
          user: owner,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

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
        identityMember: identityMemberPda,
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

    const { rootBytes, identityRootBytes } = await getRoots();
    const publicInputs = makePublicInputs({
      root: rootBytes,
      identityRoot: identityRootBytes,
      nullifiers: [buf(NULLIFIER), zero32(), zero32(), zero32()],
      outputCommitments: [zero32(), zero32()],
      outputEnabled: [0, 0],
      amountOut: 100_000n,
      feeAmount: 0n,
      circuitId: 0,
    });

    await program.methods
      .withdraw({
        amount: new anchor.BN(100_000),
        proof: dummyProof,
        publicInputs,
        relayerFeeBps: 0,
        newRoot: buf(NEW_ROOT),
        outputCiphertexts: Buffer.alloc(0),
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

    const { rootBytes, identityRootBytes } = await getRoots();
    const publicInputs = makePublicInputs({
      root: rootBytes,
      identityRoot: identityRootBytes,
      nullifiers: [buf(feeNullifier), zero32(), zero32(), zero32()],
      outputCommitments: [zero32(), zero32()],
      outputEnabled: [0, 0],
      amountOut: 100_000n,
      feeAmount: 250n,
      circuitId: 0,
    });

    await program.methods
      .withdraw({
        amount: new anchor.BN(100_000),
        proof: dummyProof,
        publicInputs,
        relayerFeeBps: 25,
        newRoot: buf(NEW_ROOT),
        outputCiphertexts: Buffer.alloc(0),
      })
      .accounts({
        config: configPda,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        identityRegistry: identityRegistryPda,
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
      const { rootBytes, identityRootBytes } = await getRoots();
      const publicInputs = makePublicInputs({
        root: rootBytes,
        identityRoot: identityRootBytes,
        nullifiers: [buf(NULLIFIER), zero32(), zero32(), zero32()],
        outputCommitments: [zero32(), zero32()],
        outputEnabled: [0, 0],
        amountOut: 10_000n,
        feeAmount: 0n,
        circuitId: 0,
      });
      await program.methods
        .withdraw({
          amount: new anchor.BN(10_000),
          proof: dummyProof,
          publicInputs,
          relayerFeeBps: 0,
          newRoot: buf(NEW_ROOT),
          outputCiphertexts: Buffer.alloc(0),
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
      const { identityRootBytes } = await getRoots();
      const publicInputs = makePublicInputs({
        root: buf(ROOT),
        identityRoot: identityRootBytes,
        nullifiers: [buf(newNullifier), zero32(), zero32(), zero32()],
        outputCommitments: [zero32(), zero32()],
        outputEnabled: [0, 0],
        amountOut: 10_000n,
        feeAmount: 0n,
        circuitId: 0,
      });
      await program.methods
      .withdraw({
        amount: new anchor.BN(10_000),
        proof: dummyProof,
        publicInputs,
        relayerFeeBps: 0,
        newRoot: buf(NEW_ROOT),
        outputCiphertexts: Buffer.alloc(0),
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
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw);
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

    const { rootBytes, identityRootBytes } = await getRoots();
    const internalInputs = makePublicInputs({
      root: rootBytes,
      identityRoot: identityRootBytes,
      nullifiers: [buf(internalNullifier), zero32(), zero32(), zero32()],
      outputCommitments: [zero32(), zero32()],
      outputEnabled: [1, 0],
      amountOut: 0n,
      feeAmount: 0n,
      circuitId: 0,
    });

    await program.methods
      .internalTransfer({
        proof: dummyProof,
        publicInputs: internalInputs,
        newRoot: buf(internalRoot),
        outputCiphertexts: Buffer.alloc(128),
      })
      .accounts({
        config: configPda,
        shieldedState: shieldedPda,
        identityRegistry: identityRegistryPda,
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

    const externalInputs = makePublicInputs({
      root: buf(internalRoot),
      identityRoot: identityRootBytes,
      nullifiers: [buf(externalNullifier), zero32(), zero32(), zero32()],
      outputCommitments: [zero32(), zero32()],
      outputEnabled: [0, 0],
      amountOut: 25_000n,
      feeAmount: 0n,
      circuitId: 0,
    });

    await program.methods
      .externalTransfer({
        amount: new anchor.BN(25_000),
        proof: dummyProof,
        publicInputs: externalInputs,
        relayerFeeBps: 0,
        newRoot: buf(NEW_ROOT),
        outputCiphertexts: Buffer.alloc(0),
      })
      .accounts({
        config: configPda,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        identityRegistry: identityRegistryPda,
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

  it("emits note outputs that can be recovered with a view-key signature", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );

    const shieldedBefore = await program.account.shieldedState.fetch(shieldedPda);
    const leafIndex = Number(
      shieldedBefore.commitmentCount?.toString?.() ??
        shieldedBefore.commitment_count?.toString?.() ??
        0
    );

    const owner = provider.wallet.payer;
    const viewMessage = Buffer.from(
      `VeilPay:view-key:${owner.publicKey.toBase58()}`
    );
    const signature = nacl.sign.detached(viewMessage, owner.secretKey);
    const viewSecret = sha256(signature);

    const amount = 42_000n;
    const randomness = modField(bytesToBigIntBE(randomBytes32()));
    const tagHash = await recipientTagHashFromSecret(viewSecret);
    const commitment = await computeCommitment(amount, randomness, tagHash);
    const { pubkey, secretScalar } = await deriveRecipientKeypair(viewSecret);
    const enc = await eciesEncrypt({ recipientPubkey: pubkey, amount, randomness });

    const signatureTx = await program.methods
      .deposit({
        amount: new anchor.BN(amount.toString()),
        ciphertext: Buffer.from(enc.ciphertext),
        commitment: Buffer.from(bigIntToBytes32(commitment)),
        newRoot: buf(NEW_ROOT),
      })
      .accounts({
        config: configPda,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        user: owner.publicKey,
        identityMember: identityMemberPda,
        userAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const fetchTxWithLogs = async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const tx = await provider.connection.getTransaction(signatureTx, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (tx?.meta?.logMessages) {
          return tx;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return null;
    };

    const tx = await fetchTxWithLogs();
    assert.isOk(tx?.meta?.logMessages, "missing logs for deposit tx");

    let eventData: any = null;
    const logs = tx!.meta!.logMessages!;
    for (const log of logs) {
      if (!log.startsWith("Program data: ")) continue;
      const data = log.slice("Program data: ".length);
      const decoded = (program.coder as any).events.decode(data);
      if (decoded?.name === "noteOutputEvent") {
        eventData = decoded.data;
        break;
      }
    }
    if (!eventData) {
      const idlEvents = (program.idl as any).events?.map((e: any) => e.name) ?? [];
      throw new Error(
        `missing noteOutputEvent. idlEvents=${idlEvents.join(",")} logs=${JSON.stringify(logs)}`
      );
    }

    const eventLeaf = eventData.leafIndex?.toNumber?.() ??
      eventData.leaf_index?.toNumber?.() ??
      Number(eventData.leafIndex ?? eventData.leaf_index);
    assert.equal(eventLeaf, leafIndex);
    assert.equal(new PublicKey(eventData.mint).toBase58(), mint.toBase58());
    assert.equal(Buffer.from(eventData.commitment).toString("hex"), Buffer.from(bigIntToBytes32(commitment)).toString("hex"));
    assert.equal(Buffer.from(eventData.ciphertext).toString("hex"), Buffer.from(enc.ciphertext).toString("hex"));

    const cipher = Buffer.from(eventData.ciphertext);
    const c1x = bytesToBigIntBE(cipher.subarray(0, 32));
    const c1y = bytesToBigIntBE(cipher.subarray(32, 64));
    const c2Amount = bytesToBigIntBE(cipher.subarray(64, 96));
    const c2Randomness = bytesToBigIntBE(cipher.subarray(96, 128));
    const dec = await eciesDecrypt({
      recipientSecret: secretScalar,
      c1x,
      c1y,
      c2Amount,
      c2Randomness,
    });
    assert.equal(dec.amount.toString(), amount.toString());
    assert.equal(dec.randomness.toString(), randomness.toString());
  });

  it("rescans identity registry after storage reset", async () => {
    const owner = provider.wallet.publicKey;
    const signMessage = async (message: Uint8Array) =>
      nacl.sign.detached(message, provider.wallet.payer.secretKey);
    (globalThis as any).localStorage.clear();

    const confirmedConnection = new Connection(provider.connection.rpcEndpoint, {
      commitment: "confirmed",
    });
    await rescanIdentityRegistry({
      program,
      owner,
      connectionOverride: confirmedConnection,
      onStatus: () => {},
      signMessage,
    });
    const commitments = loadIdentityCommitments(program.programId);
    const identityAccount = await program.account.identityRegistry.fetch(identityRegistryPda);
    const onChainRoot =
      Buffer.from(
        (identityAccount.merkleRoot as number[] | undefined) ??
          (identityAccount.merkle_root as number[] | undefined) ??
          []
      );
    const onChainCount = Number(
      identityAccount.commitmentCount?.toString?.() ??
        identityAccount.commitment_count?.toString?.() ??
        0
    );
    assert.equal(commitments.length, onChainCount);
    const { root } = await buildMerkleTree(commitments);
    if (identityCommitment) {
      assert.equal(
        Buffer.from(bigIntToBytes32(root)).toString("hex"),
        onChainRoot.toString("hex")
      );
    }
    const { root: pathRoot } = await getIdentityMerklePath(
      owner,
      program.programId,
      signMessage
    );
    if (identityCommitment) {
      assert.equal(
        Buffer.from(bigIntToBytes32(pathRoot)).toString("hex"),
        onChainRoot.toString("hex")
      );
    }
  });

  it("rescans notes and supports multi-input selection after storage reset", async () => {
    (globalThis as any).localStorage.clear();

    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );

    const owner = provider.wallet.payer;
    const viewMessage = Buffer.from(
      `VeilPay:view-key:${owner.publicKey.toBase58()}`
    );
    const viewSignature = nacl.sign.detached(viewMessage, owner.secretKey);
    const viewSecret = sha256(viewSignature);
    const tagHash = await recipientTagHashFromSecret(viewSecret);
    const { pubkey } = await deriveRecipientKeypair(viewSecret);

    const awaitLogs = async (signature: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const tx = await provider.connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (tx?.meta?.logMessages) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("missing logs for deposit tx");
    };

    const depositNote = async (amount: bigint) => {
      const randomness = modField(bytesToBigIntBE(randomBytes32()));
      const commitment = await computeCommitment(amount, randomness, tagHash);
      const enc = await eciesEncrypt({
        recipientPubkey: pubkey,
        amount,
        randomness,
      });
      const signatureTx = await program.methods
        .deposit({
          amount: new anchor.BN(amount.toString()),
          ciphertext: Buffer.from(enc.ciphertext),
          commitment: Buffer.from(bigIntToBytes32(commitment)),
          newRoot: buf(NEW_ROOT),
        })
        .accounts({
          config: configPda,
          vault: vaultPda,
          vaultAta,
          shieldedState: shieldedPda,
          user: owner.publicKey,
          identityMember: identityMemberPda,
          userAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      await awaitLogs(signatureTx);
      return { commitment, amount };
    };

    const amountA = 1_000n;
    const amountB = 2_000n;
    const startSlot = await provider.connection.getSlot("confirmed");
    await depositNote(amountA);
    await depositNote(amountB);

    const signMessage = async (message: Uint8Array) =>
      nacl.sign.detached(message, owner.secretKey);

    const { notes, balance } = await rescanNotesForOwner({
      program,
      mint,
      owner: owner.publicKey,
      signMessage,
      startSlot,
    });

    const spendable = notes.filter((note) => !note.spent);
    assert.equal(spendable.length, 2);
    assert.equal(balance.toString(), (amountA + amountB).toString());

    const selection = selectNotesForAmount(mint, owner.publicKey, amountA + amountB, 4);
    assert.equal(selection.notes.length, 2);
    assert.equal(selection.total.toString(), (amountA + amountB).toString());
  });
});
