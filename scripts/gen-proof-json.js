const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const { buildBabyjub, buildPoseidon } = require('circomlibjs');

async function main() {
  const buildDir = path.join(__dirname, '..', 'circuits', 'build');
  const wasmPath = path.join(buildDir, 'veilpay_js', 'veilpay.wasm');
  const zkeyPath = path.join(buildDir, 'veilpay_final.zkey');
  const outPath = path.join(buildDir, 'snarkjs_proof.json');
  const inputPath = path.join(buildDir, 'input.json');

  const poseidon = await buildPoseidon();
  const babyjub = await buildBabyjub();
  const FIELD_MODULUS = BigInt(
    "21888242871839275222246405745257275088548364400416034343698204186575808495617"
  );
  const modField = (v) => {
    const value = BigInt(v) % FIELD_MODULUS;
    return value < 0n ? value + FIELD_MODULUS : value;
  };
  const toField = (v) => {
    if (typeof v === "bigint") return modField(v);
    if (ArrayBuffer.isView(v)) return modField(poseidon.F.toObject(v));
    return modField(v);
  };
  const hashPair = (left, right) => toField(poseidon([left, right]));

  const amount = 100000n;
  const randomness = 12345n;
  const senderSecret = 999n;
  const leafIndex = 0n;
  const recipientTagHash = 456n;
  const depth = 20;

  const recipientSecret = 123456789n;
  const recipientPubkey = babyjub.mulPointEscalar(babyjub.Base8, recipientSecret);
  const recipientPubkeyX = BigInt(babyjub.F.toObject(recipientPubkey[0]));
  const recipientPubkeyY = BigInt(babyjub.F.toObject(recipientPubkey[1]));
  const encRandomness = 424242n;
  const c1 = babyjub.mulPointEscalar(babyjub.Base8, encRandomness);
  const c1x = BigInt(babyjub.F.toObject(c1[0]));
  const c1y = BigInt(babyjub.F.toObject(c1[1]));
  const shared = babyjub.mulPointEscalar(recipientPubkey, encRandomness);
  const sharedX = BigInt(babyjub.F.toObject(shared[0]));
  const sharedY = BigInt(babyjub.F.toObject(shared[1]));
  const maskAmount = toField(poseidon([sharedX, sharedY, 0n]));
  const maskRandomness = toField(poseidon([sharedX, sharedY, 1n]));
  const c2Amount = toField(amount + maskAmount);
  const c2Randomness = toField(randomness + maskRandomness);

  const nullifier = toField(poseidon([senderSecret, leafIndex]));
  const commitment = toField(poseidon([amount, randomness, recipientTagHash]));

  const zeroes = [0n];
  for (let i = 1; i <= depth; i += 1) {
    zeroes.push(hashPair(zeroes[i - 1], zeroes[i - 1]));
  }

  const leaves = [commitment];
  const levels = [leaves];
  for (let level = 0; level < depth; level += 1) {
    const current = levels[level];
    const next = [];
    const width = Math.max(current.length, 1);
    for (let i = 0; i < width; i += 2) {
      const left = current[i] ?? zeroes[level];
      const right = current[i + 1] ?? zeroes[level];
      next.push(hashPair(left, right));
    }
    levels.push(next);
  }
  const root = levels[depth][0] ?? zeroes[depth];
  const pathElements = [];
  const pathIndex = [];
  let index = Number(leafIndex);
  for (let level = 0; level < depth; level += 1) {
    const current = levels[level];
    const siblingIndex = index ^ 1;
    const sibling = current[siblingIndex] ?? zeroes[level];
    pathElements.push(sibling.toString());
    pathIndex.push(index & 1);
    index = Math.floor(index / 2);
  }

  const input = {
    root: root.toString(),
    nullifier: nullifier.toString(),
    recipient_tag_hash: recipientTagHash.toString(),
    ciphertext_commitment: commitment.toString(),
    circuit_id: '0',
    amount: amount.toString(),
    randomness: randomness.toString(),
    sender_secret: senderSecret.toString(),
    leaf_index: leafIndex.toString(),
    path_elements: pathElements,
    path_index: pathIndex,
    recipient_pubkey_x: recipientPubkeyX.toString(),
    recipient_pubkey_y: recipientPubkeyY.toString(),
    enc_randomness: encRandomness.toString(),
    c1x: c1x.toString(),
    c1y: c1y.toString(),
    c2_amount: c2Amount.toString(),
    c2_randomness: c2Randomness.toString(),
  };
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));
  console.log(`Wrote ${inputPath}`);

  console.log('Generating Groth16 proof (this can take a while)...');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const callData = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const argv = callData.replace(/["[\]\s]/g, '').split(',').filter(Boolean);
  const solidity = {
    a: [argv[0], argv[1]],
    b: [
      [argv[2], argv[3]],
      [argv[4], argv[5]],
    ],
    c: [argv[6], argv[7]],
    inputs: argv.slice(8),
  };

  fs.writeFileSync(outPath, JSON.stringify({ proof, publicSignals, solidity }, null, 2));
  console.log(`Wrote ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
