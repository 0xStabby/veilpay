pragma circom 2.1.6;

include "poseidon.circom";
include "bitify.circom";

// Minimal proof circuit that binds public inputs to private values.
template Veilpay() {
    signal input root;
    signal input nullifier;
    signal input recipient_tag_hash;
    signal input ciphertext_commitment;
    signal input circuit_id;

    signal input amount;
    signal input randomness;
    signal input sender_secret;
    signal input leaf_index;

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

    // Bind remaining public inputs to the constraint system.
    signal root_check;
    root_check <== root + 0;
    signal id_check;
    id_check <== circuit_id + root_check;
    id_check === circuit_id + root_check;
}

component main { public [root, nullifier, recipient_tag_hash, ciphertext_commitment, circuit_id] } = Veilpay();
