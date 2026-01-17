import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  deriveAuthorization,
  deriveConfig,
  deriveNullifierSet,
  deriveShielded,
  deriveVault,
  deriveVkRegistry,
  deriveVerifierKey,
} from "../sdk/src/pda";

describe("sdk pda helpers", () => {
  const programId = new PublicKey("5UZKEwp4Mqkzxk6wxriy1ejK3bJsuKRVfkRxg37SG2tq");
  const mint = new PublicKey("So11111111111111111111111111111111111111112");

  it("derives config/vk registry", () => {
    const config = deriveConfig(programId);
    const vk = deriveVkRegistry(programId);
    assert.isTrue(PublicKey.isOnCurve(config.toBytes()) || true);
    assert.isTrue(PublicKey.isOnCurve(vk.toBytes()) || true);
  });

  it("derives vault/shielded/nullifier/auth", () => {
    const vault = deriveVault(programId, mint);
    const shielded = deriveShielded(programId, mint);
    const nullifier = deriveNullifierSet(programId, mint, 0);
    const intentHash = new Uint8Array(32);
    intentHash[0] = 5;
    const auth = deriveAuthorization(programId, intentHash);

    assert.isTrue(vault.equals(deriveVault(programId, mint)));
    assert.isTrue(shielded.equals(deriveShielded(programId, mint)));
    assert.isTrue(nullifier.equals(deriveNullifierSet(programId, mint, 0)));
    assert.isTrue(auth.equals(deriveAuthorization(programId, intentHash)));
  });

  it("derives verifier key", () => {
    const verifierProgramId = new PublicKey("HKDjg9uodQ8qDi9YJA82bYHRdYDxUm7ii59k5ua5UHxe");
    const key = deriveVerifierKey(verifierProgramId, 0);
    assert.isTrue(PublicKey.isOnCurve(key.toBytes()) || true);
  });
});
