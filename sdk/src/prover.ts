import { bigIntToBytes32 } from "./crypto";
import { poseidonHash } from "./poseidon";

export async function computeNullifier(senderSecret: bigint, leafIndex: bigint): Promise<bigint> {
  return poseidonHash([senderSecret, leafIndex]);
}

export async function computeCommitment(
  amount: bigint,
  randomness: bigint,
  recipientTagHash: bigint
): Promise<bigint> {
  return poseidonHash([amount, randomness, recipientTagHash]);
}

export async function computeIdentityCommitment(identitySecret: bigint): Promise<bigint> {
  return poseidonHash([identitySecret]);
}

export { bigIntToBytes32, poseidonHash };
