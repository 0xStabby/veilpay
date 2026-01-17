import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { Intent, TransferArgs } from "./types";

export class VeilpayClient {
  readonly program: Program;
  readonly provider: AnchorProvider;

  constructor(program: Program, provider: AnchorProvider) {
    this.program = program;
    this.provider = provider;
  }

  static async fromAnchor(program: Program, provider: AnchorProvider): Promise<VeilpayClient> {
    return new VeilpayClient(program, provider);
  }

  async buildDepositIx(args: {
    amount: bigint;
    ciphertext: Uint8Array;
    commitment: Uint8Array;
    newRoot: Uint8Array;
    config: PublicKey;
    vault: PublicKey;
    vaultAta: PublicKey;
    shieldedState: PublicKey;
    userAta: PublicKey;
    mint: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.program.methods
      .deposit({
        amount: new BN(args.amount.toString()),
        ciphertext: Buffer.from(args.ciphertext),
        commitment: Buffer.from(args.commitment),
        newRoot: Buffer.from(args.newRoot),
      })
      .accounts({
        config: args.config,
        vault: args.vault,
        vaultAta: args.vaultAta,
        shieldedState: args.shieldedState,
        user: this.provider.wallet.publicKey,
        userAta: args.userAta,
        mint: args.mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async buildWithdrawIx(args: TransferArgs & {
    config: PublicKey;
    vault: PublicKey;
    vaultAta: PublicKey;
    shieldedState: PublicKey;
    nullifierSet: PublicKey;
    recipientAta: PublicKey;
    relayerFeeAta?: PublicKey | null;
    verifierProgram: PublicKey;
    verifierKey: PublicKey;
    mint: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.program.methods
      .withdraw({
        amount: new BN(args.amount.toString()),
        proof: Buffer.from(args.proof),
        nullifier: Buffer.from(args.nullifier),
        root: Buffer.from(args.root),
        publicInputs: Buffer.from(args.publicInputs),
        relayerFeeBps: args.relayerFeeBps,
      })
      .accounts({
        config: args.config,
        vault: args.vault,
        vaultAta: args.vaultAta,
        shieldedState: args.shieldedState,
        nullifierSet: args.nullifierSet,
        recipientAta: args.recipientAta,
        relayerFeeAta: args.relayerFeeAta ?? null,
        verifierProgram: args.verifierProgram,
        verifierKey: args.verifierKey,
        mint: args.mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async buildCreateAuthorizationIx(args: { intent: Intent; config: PublicKey; authorization: PublicKey }): Promise<TransactionInstruction> {
    return await this.program.methods
      .createAuthorization({
        intentHash: Buffer.from(args.intent.intentHash),
        payeeTagHash: Buffer.from(args.intent.payeeTagHash),
        mint: args.intent.mint,
        amountCiphertext: Buffer.from(args.intent.amountCiphertext),
        expirySlot: new BN(args.intent.expirySlot.toString()),
        circuitId: args.intent.circuitId,
        proofHash: Buffer.from(args.intent.proofHash),
        relayerPubkey: args.intent.relayerPubkey ?? PublicKey.default,
      })
      .accounts({
        config: args.config,
        authorization: args.authorization,
        payer: this.provider.wallet.publicKey,
      })
      .instruction();
  }

  async signIntent(wallet: Wallet, domain: string, intentHash: Uint8Array): Promise<Uint8Array> {
    const message = Buffer.concat([Buffer.from(domain), Buffer.from(intentHash)]);
    const signature = await wallet.signMessage(message);
    return signature;
  }
}
