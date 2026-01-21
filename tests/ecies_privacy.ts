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
import { buildBabyjub } from "circomlibjs";

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
    const babyjub = await buildBabyjub();
    const FIELD_MODULUS = BigInt(
      "21888242871839275222246405745257275088548364400416034343698204186575808495617"
    );
    const modField = (value: bigint) => {
      const mod = value % FIELD_MODULUS;
      return mod >= 0n ? mod : mod + FIELD_MODULUS;
    };
    const encRandomness = 424242n;
    const c1Point = babyjub.mulPointEscalar(babyjub.Base8, encRandomness);
    const c1x = BigInt(babyjub.F.toObject(c1Point[0]));
    const c1y = BigInt(babyjub.F.toObject(c1Point[1]));
    const sharedPoint = babyjub.mulPointEscalar(
      [babyjub.F.e(pubkey[0]), babyjub.F.e(pubkey[1])],
      encRandomness
    );
    const sharedX = BigInt(babyjub.F.toObject(sharedPoint[0]));
    const sharedY = BigInt(babyjub.F.toObject(sharedPoint[1]));
    const maskAmount = await poseidonHash([sharedX, sharedY, 0n]);
    const maskRandomness = await poseidonHash([sharedX, sharedY, 1n]);
    const c2Amount = modField(amount + maskAmount);
    const c2Randomness = modField(randomness + maskRandomness);

    const identitySecret = 222222n;
    const identityCommitment = await poseidonHash([identitySecret]);
    const {
      root: identityRoot,
      pathElements: identityPathElements,
      pathIndices: identityPathIndices,
    } = await getMerklePath([identityCommitment], 0);

    const input = {
      root: root.toString(),
      identity_root: identityRoot.toString(),
      nullifier: [nullifier.toString(), "0", "0", "0"],
      output_commitment: [commitment.toString(), "0"],
      output_enabled: [1, 0],
      amount_out: "0",
      fee_amount: "0",
      circuit_id: "0",
      input_enabled: [1, 0, 0, 0],
      input_amount: [amount.toString(), "0", "0", "0"],
      input_randomness: [randomness.toString(), "0", "0", "0"],
      input_sender_secret: [senderSecret.toString(), "0", "0", "0"],
      input_leaf_index: [leafIndex.toString(), "0", "0", "0"],
      input_recipient_tag_hash: [recipientTagHash.toString(), "0", "0", "0"],
      input_path_elements: [
        pathElements.map((value) => value.toString()),
        pathElements.map(() => "0"),
        pathElements.map(() => "0"),
        pathElements.map(() => "0"),
      ],
      input_path_index: [
        pathIndices,
        pathIndices.map(() => 0),
        pathIndices.map(() => 0),
        pathIndices.map(() => 0),
      ],
      identity_secret: identitySecret.toString(),
      identity_path_elements: identityPathElements.map((value) => value.toString()),
      identity_path_index: identityPathIndices,
      output_amount: [amount.toString(), "0"],
      output_randomness: [randomness.toString(), "0"],
      output_recipient_tag_hash: [recipientTagHash.toString(), "0"],
      output_recipient_pubkey_x: [pubkey[0].toString(), pubkey[0].toString()],
      output_recipient_pubkey_y: [pubkey[1].toString(), pubkey[1].toString()],
      output_enc_randomness: [encRandomness.toString(), "0"],
      output_c1x: [c1x.toString(), "0"],
      output_c1y: [c1y.toString(), "0"],
      output_c2_amount: [c2Amount.toString(), "0"],
      output_c2_randomness: [c2Randomness.toString(), "0"],
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
      output_c2_amount: [
        (BigInt(input.output_c2_amount[0]) + 1n).toString(),
        input.output_c2_amount[1],
      ],
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
