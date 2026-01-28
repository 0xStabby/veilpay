import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";

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

}
