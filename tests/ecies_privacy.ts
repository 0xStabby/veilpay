import fs from "fs";
import path from "path";
import * as snarkjs from "snarkjs";
import { expect } from "chai";
import { randomBytes32 } from "../sdk/src/crypto";
import { poseidonHash } from "../sdk/src/poseidon";
import { getMerklePath } from "../sdk/src/merkle";
import {
  computeCommitment,
  recipientTagHashFromSecret,
  deriveRecipientKeypair,
  eciesEncrypt,
  eciesDecrypt,
} from "../sdk/src/notes";

describe("ecies privacy", () => {
  const buildDir = path.join(process.cwd(), "circuits", "build");
  const wasmPath = path.join(buildDir, "veilpay_js", "veilpay.wasm");
  const zkeyPath = path.join(buildDir, "veilpay_final.zkey");
  const vkeyPath = path.join(buildDir, "verification_key.json");

  it("encrypts and decrypts note payloads", async () => {
    const recipientSecret = randomBytes32();
    const { secretScalar, pubkey } = await deriveRecipientKeypair(recipientSecret);
    const amount = 12345n;
    const randomness = 67890n;

    const enc = await eciesEncrypt({ recipientPubkey: pubkey, amount, randomness });
    const dec = await eciesDecrypt({
      recipientSecret: secretScalar,
      c1x: enc.c1x,
      c1y: enc.c1y,
      c2Amount: enc.c2Amount,
      c2Randomness: enc.c2Randomness,
    });

    expect(dec.amount).to.equal(amount);
    expect(dec.randomness).to.equal(randomness);
  });

  it("rejects proofs with mismatched ciphertext", async () => {
    const recipientSecret = randomBytes32();
    const { secretScalar, pubkey } = await deriveRecipientKeypair(recipientSecret);
    const amount = 50000n;
    const randomness = 777n;
    const senderSecret = 999n;
    const leafIndex = 0n;

    const recipientTagHash = await recipientTagHashFromSecret(recipientSecret);
    const commitment = await computeCommitment(amount, randomness, recipientTagHash);
    const { root, pathElements, pathIndices } = await getMerklePath([commitment], 0);
    const nullifier = await poseidonHash([senderSecret, leafIndex]);
    const enc = await eciesEncrypt({ recipientPubkey: pubkey, amount, randomness });

    const input = {
      root: root.toString(),
      nullifier: nullifier.toString(),
      recipient_tag_hash: recipientTagHash.toString(),
      ciphertext_commitment: commitment.toString(),
      circuit_id: "0",
      amount: amount.toString(),
      randomness: randomness.toString(),
      sender_secret: senderSecret.toString(),
      leaf_index: leafIndex.toString(),
      path_elements: pathElements.map((value) => value.toString()),
      path_index: pathIndices,
      recipient_pubkey_x: pubkey[0].toString(),
      recipient_pubkey_y: pubkey[1].toString(),
      enc_randomness: enc.encRandomness.toString(),
      c1x: enc.c1x.toString(),
      c1y: enc.c1y.toString(),
      c2_amount: enc.c2Amount.toString(),
      c2_randomness: enc.c2Randomness.toString(),
    };

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      wasmPath,
      zkeyPath
    );
    const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    expect(ok).to.equal(true);

    const badInput = {
      ...input,
      c2_amount: (BigInt(input.c2_amount) + 1n).toString(),
    };
    let badVerified = false;
    try {
      const badProof = await snarkjs.groth16.fullProve(badInput, wasmPath, zkeyPath);
      badVerified = await snarkjs.groth16.verify(
        vkey,
        badProof.publicSignals,
        badProof.proof
      );
    } catch (error) {
      badVerified = false;
    }
    expect(badVerified).to.equal(false);
  });
});
