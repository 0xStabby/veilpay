const path = require('path');
const snarkjs = require('snarkjs');
const { buildPoseidon } = require('circomlibjs');

async function main() {
  const buildDir = path.join(__dirname, '..', 'circuits', 'build');
  const wasmPath = path.join(buildDir, 'veilpay_js', 'veilpay.wasm');
  const zkeyPath = path.join(buildDir, 'veilpay_final.zkey');
  const vkeyPath = path.join(buildDir, 'verification_key.json');

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toField = (v) => BigInt(F.toString(v));

  const amount = 50000n;
  const randomness = 12345n;
  const senderSecret = 999n;
  const leafIndex = 1n;
  const recipientTagHash = 456n;

  const nullifier = toField(poseidon([senderSecret, leafIndex]));
  const commitment = toField(poseidon([amount, randomness, recipientTagHash]));

  const input = {
    root: '123',
    nullifier: nullifier.toString(),
    recipient_tag_hash: recipientTagHash.toString(),
    ciphertext_commitment: commitment.toString(),
    fee_bps: '25',
    relayer_fee_bps: '0',
    circuit_id: '0',
    amount: amount.toString(),
    randomness: randomness.toString(),
    sender_secret: senderSecret.toString(),
    leaf_index: leafIndex.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const vkey = require(vkeyPath);
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);

  if (!ok) {
    throw new Error('Groth16 proof verification failed');
  }
  console.log('Groth16 proof verified');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
