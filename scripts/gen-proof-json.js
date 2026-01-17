const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const { buildPoseidon } = require('circomlibjs');

async function main() {
  const buildDir = path.join(__dirname, '..', 'circuits', 'build');
  const wasmPath = path.join(buildDir, 'veilpay_js', 'veilpay.wasm');
  const zkeyPath = path.join(buildDir, 'veilpay_final.zkey');
  const outPath = path.join(buildDir, 'snarkjs_proof.json');
  const inputPath = path.join(buildDir, 'input.json');

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toField = (v) => BigInt(F.toString(v));

  const amount = 100000n;
  const randomness = 12345n;
  const senderSecret = 999n;
  const leafIndex = 1n;
  const recipientTagHash = 456n;

  const nullifier = toField(poseidon([senderSecret, leafIndex]));
  const commitment = toField(poseidon([amount, randomness, recipientTagHash]));

  const input = {
    root: '5',
    nullifier: nullifier.toString(),
    recipient_tag_hash: recipientTagHash.toString(),
    ciphertext_commitment: commitment.toString(),
    circuit_id: '0',
    amount: amount.toString(),
    randomness: randomness.toString(),
    sender_secret: senderSecret.toString(),
    leaf_index: leafIndex.toString(),
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
