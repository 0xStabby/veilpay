import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  createMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  mintTo,
  getAccount,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
  Keypair,
  SystemProgram,
  Connection,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
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
import { deriveViewKeypairFromSeed, recipientTagHashFromViewKey } from "../sdk/src/noteStore";
import { rescanIdentityRegistry } from "../sdk/src/identityScanner";
import { rescanNotesForOwner } from "../sdk/src/noteScanner";
import {
  restoreIdentitySecret,
  loadIdentityCommitments,
  saveIdentityCommitments,
  getIdentityMerklePath,
} from "../sdk/src/identity";
import { buildMerkleTree } from "../sdk/src/merkle";
import { computeIdentityCommitment } from "../sdk/src/prover";
import { selectNotesForAmount } from "../sdk/src/noteStore";
import { deriveProofAccount } from "../sdk/src/pda";

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

const buildLookupTable = async (
  connection: Connection,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount> => {
  const recentSlot = await connection.getSlot("finalized");
  const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot,
  });
  const createSig = await connection.sendTransaction(new Transaction().add(createIx), [payer], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(createSig, "finalized");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await connection.getAccountInfo(lookupTableAddress, "finalized");
    if (info && info.owner.equals(AddressLookupTableProgram.programId)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const unique = Array.from(new Set(addresses.map((key) => key.toBase58()))).map(
    (value) => new PublicKey(value)
  );
  const chunkSize = 20;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: lookupTableAddress,
      addresses: chunk,
    });
    const extendSig = await connection.sendTransaction(new Transaction().add(extendIx), [payer], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction(extendSig, "finalized");
  }
  const table = await connection.getAddressLookupTable(lookupTableAddress);
  if (!table.value) {
    throw new Error("Failed to create lookup table.");
  }
  return table.value;
};

const sendVersionedWithLookupTable = async (params: {
  connection: Connection;
  payer: Keypair;
  instructions: anchor.web3.TransactionInstruction[];
  lookupTable: AddressLookupTableAccount;
}) => {
  const { connection, payer, instructions, lookupTable } = params;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message([lookupTable]);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
};

const sendWithLut = async (params: {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
  verifierProgramId: PublicKey;
  ix: anchor.web3.TransactionInstruction;
}) => {
  const { connection, payer, programId, verifierProgramId, ix } = params;
  const lut = await buildLookupTable(connection, payer, [
    programId,
    verifierProgramId,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    ...ix.keys.map((key) => key.pubkey),
  ]);
  await sendVersionedWithLookupTable({
    connection,
    payer,
    instructions: [ix],
    lookupTable: lut,
  });
};

const ensureSystemAccount = async (
  connection: anchor.web3.Connection,
  pubkey: PublicKey
) => {
  const info = await connection.getAccountInfo(pubkey);
  if (info) return;
  const sig = await connection.requestAirdrop(pubkey, 1_000_000_000);
  await connection.confirmTransaction(sig, "confirmed");
};

const deriveTempAuthority = async (
  program: Program,
  vaultPda: PublicKey,
  recipient: PublicKey
) => {
  const vault = await program.account.vaultPool.fetch(vaultPda);
  const nonceBytes = (vault.nonce as anchor.BN).toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("temp_wsol"), recipient.toBuffer(), nonceBytes],
    program.programId
  )[0];
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
    const dummyProof = Buffer.alloc(256);

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

  let proofNonce = 1n;
  const nextProofNonce = () => proofNonce++;

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

  it("deposits and external transfers with mock proof", async () => {
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
    await ensureSystemAccount(provider.connection, recipient.publicKey);
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );
    const tempAuthority = await deriveTempAuthority(program, vaultPda, recipient.publicKey);
    const tempWsolAta = await getAssociatedTokenAddress(mint, tempAuthority, true);

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

    const proofOwner = provider.wallet.publicKey;
    const proofNonce = nextProofNonce();
    const proofAccount = deriveProofAccount(program.programId, mint, proofNonce);
    await program.methods
      .storeProof({
        nonce: new anchor.BN(proofNonce.toString()),
        recipient: recipient.publicKey,
        destinationAta: recipientAta,
        mint,
        proof: dummyProof,
        publicInputs,
      })
      .accounts({
        proofAccount,
        payer: proofOwner,
        mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .externalTransferWithProof({
        amount: new anchor.BN(100_000),
        relayerFeeBps: 0,
        newRoot: buf(NEW_ROOT),
        outputCiphertexts: Buffer.alloc(0),
        deliverSol: false,
      })
      .accounts({
        config: configPda,
        payer: provider.wallet.publicKey,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: nullifierPda,
        proofAccount,
        destinationAta: recipientAta,
        recipient: recipient.publicKey,
        tempAuthority,
        tempWsolAta,
        relayerFeeAta: null,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const recipientAccount = await getAccount(provider.connection, recipientAta);
    assert.equal(Number(recipientAccount.amount), 100_000);
  });

  it("pays relayer fee on external transfer", async () => {
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
    await ensureSystemAccount(provider.connection, recipient.publicKey);
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );
    const tempAuthority = await deriveTempAuthority(program, vaultPda, recipient.publicKey);
    const tempWsolAta = await getAssociatedTokenAddress(mint, tempAuthority, true);

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

    const feeProofOwner = provider.wallet.publicKey;
    const feeProofNonce = nextProofNonce();
    const feeProofAccount = deriveProofAccount(program.programId, mint, feeProofNonce);
    await program.methods
      .storeProof({
        nonce: new anchor.BN(feeProofNonce.toString()),
        recipient: recipient.publicKey,
        destinationAta: recipientAta,
        mint,
        proof: dummyProof,
        publicInputs,
      })
      .accounts({
        proofAccount: feeProofAccount,
        payer: feeProofOwner,
        mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const withdrawIx = await program.methods
      .externalTransferWithProof({
        amount: new anchor.BN(100_000),
        relayerFeeBps: 25,
        newRoot: buf(NEW_ROOT),
        outputCiphertexts: Buffer.alloc(0),
        deliverSol: false,
      })
      .accounts({
        config: configPda,
        payer: provider.wallet.publicKey,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: nullifierPda,
        proofAccount: feeProofAccount,
        destinationAta: recipientAta,
        recipient: recipient.publicKey,
        tempAuthority,
        tempWsolAta,
        relayerFeeAta: relayerAta,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const lut = await buildLookupTable(provider.connection, provider.wallet.payer, [
      program.programId,
      verifierProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SystemProgram.programId,
      ...withdrawIx.keys.map((key) => key.pubkey),
    ]);
    await sendVersionedWithLookupTable({
      connection: provider.connection,
      payer: provider.wallet.payer,
      instructions: [withdrawIx],
      lookupTable: lut,
    });

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
    await ensureSystemAccount(provider.connection, recipient.publicKey);
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );
    const tempAuthority = await deriveTempAuthority(program, vaultPda, recipient.publicKey);
    const tempWsolAta = await getAssociatedTokenAddress(mint, tempAuthority, true);

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
      const dsProofOwner = provider.wallet.publicKey;
      const dsProofNonce = nextProofNonce();
      const dsProofAccount = deriveProofAccount(program.programId, mint, dsProofNonce);
      await program.methods
        .storeProof({
          nonce: new anchor.BN(dsProofNonce.toString()),
          recipient: recipient.publicKey,
          destinationAta: recipientAta,
          mint,
          proof: dummyProof,
          publicInputs,
        })
        .accounts({
          proofAccount: dsProofAccount,
          payer: dsProofOwner,
          mint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await program.methods
        .externalTransferWithProof({
          amount: new anchor.BN(10_000),
          relayerFeeBps: 0,
          newRoot: buf(NEW_ROOT),
          outputCiphertexts: Buffer.alloc(0),
          deliverSol: false,
        })
        .accounts({
          config: configPda,
          payer: provider.wallet.publicKey,
          vault: vaultPda,
          vaultAta,
          shieldedState: shieldedPda,
          identityRegistry: identityRegistryPda,
          nullifierSet: nullifierPda,
          proofAccount: dsProofAccount,
          destinationAta: recipientAta,
          recipient: recipient.publicKey,
          tempAuthority,
          tempWsolAta,
          relayerFeeAta: null,
          verifierProgram: verifierProgram.programId,
          verifierKey: verifierKeyPda,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
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
    await ensureSystemAccount(provider.connection, recipient.publicKey);
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );
    const tempAuthority = await deriveTempAuthority(program, vaultPda, recipient.publicKey);
    const tempWsolAta = await getAssociatedTokenAddress(mint, tempAuthority, true);

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
      const urProofOwner = provider.wallet.publicKey;
      const urProofNonce = nextProofNonce();
      const urProofAccount = deriveProofAccount(program.programId, mint, urProofNonce);
      await program.methods
        .storeProof({
          nonce: new anchor.BN(urProofNonce.toString()),
          recipient: recipient.publicKey,
          destinationAta: recipientAta,
          mint,
          proof: dummyProof,
          publicInputs,
        })
        .accounts({
          proofAccount: urProofAccount,
          payer: urProofOwner,
          mint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await program.methods
        .externalTransferWithProof({
          amount: new anchor.BN(10_000),
          relayerFeeBps: 0,
          newRoot: buf(NEW_ROOT),
          outputCiphertexts: Buffer.alloc(0),
          deliverSol: false,
        })
        .accounts({
          config: configPda,
          payer: provider.wallet.publicKey,
          vault: vaultPda,
          vaultAta,
          shieldedState: shieldedPda,
          identityRegistry: identityRegistryPda,
          nullifierSet: nullifierPda,
          proofAccount: urProofAccount,
          destinationAta: recipientAta,
          recipient: recipient.publicKey,
          tempAuthority,
          tempWsolAta,
          relayerFeeAta: null,
          verifierProgram: verifierProgram.programId,
          verifierKey: verifierKeyPda,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
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

    const internalProofOwner = provider.wallet.publicKey;
    const internalProofNonce = nextProofNonce();
    const internalProofAccount = deriveProofAccount(program.programId, mint, internalProofNonce);
    await program.methods
      .storeProof({
        nonce: new anchor.BN(internalProofNonce.toString()),
        recipient: internalProofOwner,
        destinationAta: internalProofOwner,
        mint,
        proof: dummyProof,
        publicInputs: internalInputs,
      })
      .accounts({
        proofAccount: internalProofAccount,
        payer: internalProofOwner,
        mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await program.methods
      .internalTransferWithProof({
        newRoot: buf(internalRoot),
        outputCiphertexts: Buffer.alloc(128),
      })
      .accounts({
        config: configPda,
        payer: provider.wallet.publicKey,
        shieldedState: shieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: nullifierPda,
        proofAccount: internalProofAccount,
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
    await ensureSystemAccount(provider.connection, recipient.publicKey);
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      recipient.publicKey
    );
    const tempAuthority = await deriveTempAuthority(program, vaultPda, recipient.publicKey);
    const tempWsolAta = await getAssociatedTokenAddress(mint, tempAuthority, true);

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

    const extProofOwner = provider.wallet.publicKey;
    const extProofNonce = nextProofNonce();
    const extProofAccount = deriveProofAccount(program.programId, mint, extProofNonce);
    await program.methods
      .storeProof({
        nonce: new anchor.BN(extProofNonce.toString()),
        recipient: recipient.publicKey,
        destinationAta: recipientAta,
        mint,
        proof: dummyProof,
        publicInputs: externalInputs,
      })
      .accounts({
        proofAccount: extProofAccount,
        payer: extProofOwner,
        mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const externalIx = await program.methods
      .externalTransferWithProof({
        amount: new anchor.BN(25_000),
        relayerFeeBps: 0,
        newRoot: buf(NEW_ROOT),
        outputCiphertexts: Buffer.alloc(0),
        deliverSol: false,
      })
      .accounts({
        config: configPda,
        payer: provider.wallet.publicKey,
        vault: vaultPda,
        vaultAta,
        shieldedState: shieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: nullifierPda,
        proofAccount: extProofAccount,
        destinationAta: recipientAta,
        recipient: recipient.publicKey,
        tempAuthority,
        tempWsolAta,
        relayerFeeAta: null,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await sendWithLut({
      connection: provider.connection,
      payer: provider.wallet.payer,
      programId: program.programId,
      verifierProgramId: verifierProgram.programId,
      ix: externalIx,
    });

    const recipientAccount = await getAccount(provider.connection, recipientAta);
    assert.equal(Number(recipientAccount.amount), 25_000);
  });

  it("supports external transfers delivering SOL", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), program.programId.toBuffer()],
      program.programId
    );

    const wsolMint = NATIVE_MINT;
    await program.methods
      .registerMint(wsolMint)
      .accounts({
        config: configPda,
        admin: provider.wallet.publicKey,
      })
      .rpc();

    const [wsolVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), wsolMint.toBuffer()],
      program.programId
    );
    const [wsolShieldedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("shielded"), wsolMint.toBuffer()],
      program.programId
    );
    const [wsolNullifierPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_set"), wsolMint.toBuffer(), Buffer.from([0, 0, 0, 0])],
      program.programId
    );

    const wsolVaultAta = await getAssociatedTokenAddress(wsolMint, wsolVaultPda, true);
    const vaultAtaInfo = await provider.connection.getAccountInfo(wsolVaultAta);
    if (!vaultAtaInfo) {
      const vaultAtaIx = createAssociatedTokenAccountInstruction(
        provider.wallet.publicKey,
        wsolVaultAta,
        wsolVaultPda,
        wsolMint
      );
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(vaultAtaIx));
    }

    const vaultInfo = await provider.connection.getAccountInfo(wsolVaultPda);
    if (!vaultInfo) {
      await program.methods
        .initializeMintState(0)
        .accounts({
          config: configPda,
          vault: wsolVaultPda,
          vaultAta: wsolVaultAta,
          shieldedState: wsolShieldedPda,
          nullifierSet: wsolNullifierPda,
          admin: provider.wallet.publicKey,
          mint: wsolMint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const fundLamports = 200_000;
    const fundIx = SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: wsolVaultAta,
      lamports: fundLamports,
    });
    const syncIx = createSyncNativeInstruction(wsolVaultAta);
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(fundIx, syncIx));

    const wsolShielded = await program.account.shieldedState.fetch(wsolShieldedPda);
    const identity = await program.account.identityRegistry.fetch(identityRegistryPda);
    const wsolRootBytes = Buffer.from(
      (wsolShielded.merkleRoot as number[] | undefined) ??
        (wsolShielded.merkle_root as number[] | undefined) ??
        []
    );
    const identityRootBytes = Buffer.from(
      (identity.merkleRoot as number[] | undefined) ??
        (identity.merkle_root as number[] | undefined) ??
        []
    );

    const internalNullifier = new Uint8Array(32);
    internalNullifier[0] = 0;
    internalNullifier[4] = 21;
    const internalRoot = new Uint8Array(32);
    internalRoot[0] = 77;
    const internalInputs = makePublicInputs({
      root: wsolRootBytes,
      identityRoot: identityRootBytes,
      nullifiers: [buf(internalNullifier), zero32(), zero32(), zero32()],
      outputCommitments: [zero32(), zero32()],
      outputEnabled: [1, 0],
      amountOut: 0n,
      feeAmount: 0n,
      circuitId: 0,
    });

    const wsolInternalProofOwner = provider.wallet.publicKey;
    const wsolInternalProofNonce = nextProofNonce();
    const wsolInternalProofAccount = deriveProofAccount(
      program.programId,
      wsolMint,
      wsolInternalProofNonce
    );
    await program.methods
      .storeProof({
        nonce: new anchor.BN(wsolInternalProofNonce.toString()),
        recipient: wsolInternalProofOwner,
        destinationAta: wsolInternalProofOwner,
        mint: wsolMint,
        proof: dummyProof,
        publicInputs: internalInputs,
      })
      .accounts({
        proofAccount: wsolInternalProofAccount,
        payer: wsolInternalProofOwner,
        mint: wsolMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await program.methods
      .internalTransferWithProof({
        newRoot: buf(internalRoot),
        outputCiphertexts: Buffer.alloc(128),
      })
      .accounts({
        config: configPda,
        payer: provider.wallet.publicKey,
        shieldedState: wsolShieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: wsolNullifierPda,
        proofAccount: wsolInternalProofAccount,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint: wsolMint,
      })
      .rpc();

    const recipient = Keypair.generate();
    await ensureSystemAccount(provider.connection, recipient.publicKey);
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      wsolMint,
      recipient.publicKey
    );
    const tempAuthority = await deriveTempAuthority(program, wsolVaultPda, recipient.publicKey);
    const tempWsolAta = await getAssociatedTokenAddress(wsolMint, tempAuthority, true);

    const externalNullifier = new Uint8Array(32);
    externalNullifier[0] = 0;
    externalNullifier[4] = 22;
    const amountOut = 100_000n;
    const externalInputs = makePublicInputs({
      root: buf(internalRoot),
      identityRoot: identityRootBytes,
      nullifiers: [buf(externalNullifier), zero32(), zero32(), zero32()],
      outputCommitments: [zero32(), zero32()],
      outputEnabled: [0, 0],
      amountOut,
      feeAmount: 0n,
      circuitId: 0,
    });

    const beforeBalance = await provider.connection.getBalance(recipient.publicKey);
    const wsolExtProofOwner = provider.wallet.publicKey;
    const wsolExtProofNonce = nextProofNonce();
    const wsolExtProofAccount = deriveProofAccount(program.programId, wsolMint, wsolExtProofNonce);
    await program.methods
      .storeProof({
        nonce: new anchor.BN(wsolExtProofNonce.toString()),
        recipient: recipient.publicKey,
        destinationAta: recipientAta,
        mint: wsolMint,
        proof: dummyProof,
        publicInputs: externalInputs,
      })
      .accounts({
        proofAccount: wsolExtProofAccount,
        payer: wsolExtProofOwner,
        mint: wsolMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await program.methods
      .externalTransferWithProof({
        amount: new anchor.BN(amountOut.toString()),
        relayerFeeBps: 0,
        newRoot: buf(NEW_ROOT),
        outputCiphertexts: Buffer.alloc(0),
        deliverSol: true,
      })
      .accounts({
        config: configPda,
        payer: provider.wallet.publicKey,
        vault: wsolVaultPda,
        vaultAta: wsolVaultAta,
        shieldedState: wsolShieldedPda,
        identityRegistry: identityRegistryPda,
        nullifierSet: wsolNullifierPda,
        proofAccount: wsolExtProofAccount,
        destinationAta: recipientAta,
        recipient: recipient.publicKey,
        tempAuthority,
        tempWsolAta,
        relayerFeeAta: null,
        verifierProgram: verifierProgram.programId,
        verifierKey: verifierKeyPda,
        mint: wsolMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const afterBalance = await provider.connection.getBalance(recipient.publicKey);
    assert.isAtLeast(afterBalance - beforeBalance, Number(amountOut));
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
    const viewSecret = await sha256(signature);

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
    const viewSecret = await sha256(viewSignature);
    const viewKey = await deriveViewKeypairFromSeed(viewSecret, 0);
    const tagHash = await recipientTagHashFromViewKey(viewKey.pubkey);
    const pubkey = viewKey.pubkey;

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
