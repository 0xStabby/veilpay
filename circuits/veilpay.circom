pragma circom 2.1.6;

include "poseidon.circom";
include "bitify.circom";
include "babyjub.circom";
include "escalarmulfix.circom";
include "escalarmulany.circom";

// Proof circuit that binds public inputs to private values and checks Merkle membership.
template Veilpay() {
    var MERKLE_DEPTH = 20;
    signal input root;
    signal input nullifier;
    signal input recipient_tag_hash;
    signal input ciphertext_commitment;
    signal input circuit_id;

    signal input amount;
    signal input randomness;
    signal input sender_secret;
    signal input leaf_index;
    signal input path_elements[MERKLE_DEPTH];
    signal input path_index[MERKLE_DEPTH];
    signal input recipient_pubkey_x;
    signal input recipient_pubkey_y;
    signal input enc_randomness;
    signal input c1x;
    signal input c1y;
    signal input c2_amount;
    signal input c2_randomness;

    component amountBits = Num2Bits(64);
    amountBits.in <== amount;

    component nullifierHash = Poseidon(2);
    nullifierHash.inputs[0] <== sender_secret;
    nullifierHash.inputs[1] <== leaf_index;
    nullifierHash.out === nullifier;

    component commitmentHash = Poseidon(3);
    commitmentHash.inputs[0] <== amount;
    commitmentHash.inputs[1] <== randomness;
    commitmentHash.inputs[2] <== recipient_tag_hash;
    commitmentHash.out === ciphertext_commitment;

    component recipientCheck = BabyCheck();
    recipientCheck.x <== recipient_pubkey_x;
    recipientCheck.y <== recipient_pubkey_y;

    component encBits = Num2Bits(253);
    encBits.in <== enc_randomness;

    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];
    component c1Mul = EscalarMulFix(253, BASE8);
    for (var j = 0; j < 253; j++) {
        c1Mul.e[j] <== encBits.out[j];
    }
    c1Mul.out[0] === c1x;
    c1Mul.out[1] === c1y;

    component sharedMul = EscalarMulAny(253);
    for (var k = 0; k < 253; k++) {
        sharedMul.e[k] <== encBits.out[k];
    }
    sharedMul.p[0] <== recipient_pubkey_x;
    sharedMul.p[1] <== recipient_pubkey_y;

    component maskAmount = Poseidon(3);
    maskAmount.inputs[0] <== sharedMul.out[0];
    maskAmount.inputs[1] <== sharedMul.out[1];
    maskAmount.inputs[2] <== 0;
    c2_amount === amount + maskAmount.out;

    component maskRandomness = Poseidon(3);
    maskRandomness.inputs[0] <== sharedMul.out[0];
    maskRandomness.inputs[1] <== sharedMul.out[1];
    maskRandomness.inputs[2] <== 1;
    c2_randomness === randomness + maskRandomness.out;

    signal current[MERKLE_DEPTH + 1];
    current[0] <== ciphertext_commitment;
    component idxBits[MERKLE_DEPTH];
    component nodeHash[MERKLE_DEPTH];
    signal bit[MERKLE_DEPTH];
    signal left[MERKLE_DEPTH];
    signal right[MERKLE_DEPTH];
    for (var i = 0; i < MERKLE_DEPTH; i++) {
        idxBits[i] = Num2Bits(1);
        idxBits[i].in <== path_index[i];
        bit[i] <== idxBits[i].out[0];

        left[i] <== current[i] + bit[i] * (path_elements[i] - current[i]);
        right[i] <== path_elements[i] + bit[i] * (current[i] - path_elements[i]);

        nodeHash[i] = Poseidon(2);
        nodeHash[i].inputs[0] <== left[i];
        nodeHash[i].inputs[1] <== right[i];
        current[i + 1] <== nodeHash[i].out;
    }
    current[MERKLE_DEPTH] === root;

    // Bind remaining public inputs to the constraint system.
    signal root_check;
    root_check <== root + 0;
    signal id_check;
    id_check <== circuit_id + root_check;
    id_check === circuit_id + root_check;
}

component main { public [
    root,
    nullifier,
    recipient_tag_hash,
    ciphertext_commitment,
    circuit_id
] } = Veilpay();
