pragma circom 2.1.6;

include "poseidon.circom";
include "bitify.circom";
include "babyjub.circom";
include "escalarmulfix.circom";
include "escalarmulany.circom";

template MerkleRoot(depth) {
    signal input leaf;
    signal input path_elements[depth];
    signal input path_index[depth];
    signal output root;

    signal current[depth + 1];
    current[0] <== leaf;
    component idxBits[depth];
    component nodeHash[depth];
    signal bit[depth];
    signal left[depth];
    signal right[depth];
    for (var i = 0; i < depth; i++) {
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
    root <== current[depth];
}

template Veilpay() {
    var MERKLE_DEPTH = 20;
    var IDENTITY_DEPTH = 20;
    var MAX_INPUTS = 4;
    var MAX_OUTPUTS = 2;

    signal input root;
    signal input identity_root;
    signal input nullifier[MAX_INPUTS];
    signal input output_commitment[MAX_OUTPUTS];
    signal input output_enabled[MAX_OUTPUTS];
    signal input amount_out;
    signal input fee_amount;
    signal input circuit_id;

    signal input input_enabled[MAX_INPUTS];
    signal input input_amount[MAX_INPUTS];
    signal input input_randomness[MAX_INPUTS];
    signal input input_sender_secret[MAX_INPUTS];
    signal input input_leaf_index[MAX_INPUTS];
    signal input input_path_elements[MAX_INPUTS][MERKLE_DEPTH];
    signal input input_path_index[MAX_INPUTS][MERKLE_DEPTH];
    signal input input_recipient_tag_hash[MAX_INPUTS];

    signal input identity_secret;
    signal input identity_path_elements[IDENTITY_DEPTH];
    signal input identity_path_index[IDENTITY_DEPTH];

    signal input output_amount[MAX_OUTPUTS];
    signal input output_randomness[MAX_OUTPUTS];
    signal input output_recipient_tag_hash[MAX_OUTPUTS];
    signal input output_recipient_pubkey_x[MAX_OUTPUTS];
    signal input output_recipient_pubkey_y[MAX_OUTPUTS];
    signal input output_enc_randomness[MAX_OUTPUTS];
    signal input output_c1x[MAX_OUTPUTS];
    signal input output_c1y[MAX_OUTPUTS];
    signal input output_c2_amount[MAX_OUTPUTS];
    signal input output_c2_randomness[MAX_OUTPUTS];

    component outBits = Num2Bits(64);
    outBits.in <== amount_out;
    component feeBits = Num2Bits(64);
    feeBits.in <== fee_amount;

    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    // Identity membership
    component identityCommitment = Poseidon(1);
    identityCommitment.inputs[0] <== identity_secret;
    component identityRoot = MerkleRoot(IDENTITY_DEPTH);
    identityRoot.leaf <== identityCommitment.out;
    for (var id = 0; id < IDENTITY_DEPTH; id++) {
        identityRoot.path_elements[id] <== identity_path_elements[id];
        identityRoot.path_index[id] <== identity_path_index[id];
    }
    identityRoot.root === identity_root;

    // Inputs
    component inputBits[MAX_INPUTS];
    component nullifierHash[MAX_INPUTS];
    component inputCommitment[MAX_INPUTS];
    component inputRoot[MAX_INPUTS];
    signal root_check[MAX_INPUTS];
    signal total_in[MAX_INPUTS + 1];
    total_in[0] <== 0;
    for (var i = 0; i < MAX_INPUTS; i++) {
        input_enabled[i] * (input_enabled[i] - 1) === 0;
        inputBits[i] = Num2Bits(64);
        inputBits[i].in <== input_amount[i];

        nullifierHash[i] = Poseidon(2);
        nullifierHash[i].inputs[0] <== input_sender_secret[i];
        nullifierHash[i].inputs[1] <== input_leaf_index[i];
        nullifier[i] === input_enabled[i] * nullifierHash[i].out;

        inputCommitment[i] = Poseidon(3);
        inputCommitment[i].inputs[0] <== input_amount[i];
        inputCommitment[i].inputs[1] <== input_randomness[i];
        inputCommitment[i].inputs[2] <== input_recipient_tag_hash[i];

        inputRoot[i] = MerkleRoot(MERKLE_DEPTH);
        inputRoot[i].leaf <== inputCommitment[i].out;
        for (var d = 0; d < MERKLE_DEPTH; d++) {
            inputRoot[i].path_elements[d] <== input_path_elements[i][d];
            inputRoot[i].path_index[d] <== input_path_index[i][d];
        }
        root_check[i] <== input_enabled[i] * (inputRoot[i].root - root);
        root_check[i] === 0;

        total_in[i + 1] <== total_in[i] + input_enabled[i] * input_amount[i];
    }

    // Outputs
    component outputBits[MAX_OUTPUTS];
    component outputCommitment[MAX_OUTPUTS];
    component recipientCheck[MAX_OUTPUTS];
    component encBits[MAX_OUTPUTS];
    component c1Mul[MAX_OUTPUTS];
    signal c1x_check[MAX_OUTPUTS];
    signal c1y_check[MAX_OUTPUTS];
    component sharedMul[MAX_OUTPUTS];
    component maskAmount[MAX_OUTPUTS];
    component maskRandomness[MAX_OUTPUTS];
    signal c2_amount_check[MAX_OUTPUTS];
    signal c2_randomness_check[MAX_OUTPUTS];
    signal total_out[MAX_OUTPUTS + 1];
    total_out[0] <== amount_out + fee_amount;
    for (var j = 0; j < MAX_OUTPUTS; j++) {
        output_enabled[j] * (output_enabled[j] - 1) === 0;
        outputBits[j] = Num2Bits(64);
        outputBits[j].in <== output_amount[j];

        outputCommitment[j] = Poseidon(3);
        outputCommitment[j].inputs[0] <== output_amount[j];
        outputCommitment[j].inputs[1] <== output_randomness[j];
        outputCommitment[j].inputs[2] <== output_recipient_tag_hash[j];
        output_commitment[j] === output_enabled[j] * outputCommitment[j].out;

        recipientCheck[j] = BabyCheck();
        recipientCheck[j].x <== output_recipient_pubkey_x[j];
        recipientCheck[j].y <== output_recipient_pubkey_y[j];

        encBits[j] = Num2Bits(253);
        encBits[j].in <== output_enc_randomness[j];
        c1Mul[j] = EscalarMulFix(253, BASE8);
        for (var k = 0; k < 253; k++) {
            c1Mul[j].e[k] <== encBits[j].out[k];
        }
        c1x_check[j] <== output_enabled[j] * (output_c1x[j] - c1Mul[j].out[0]);
        c1y_check[j] <== output_enabled[j] * (output_c1y[j] - c1Mul[j].out[1]);
        c1x_check[j] === 0;
        c1y_check[j] === 0;

        sharedMul[j] = EscalarMulAny(253);
        for (var s = 0; s < 253; s++) {
            sharedMul[j].e[s] <== encBits[j].out[s];
        }
        sharedMul[j].p[0] <== output_recipient_pubkey_x[j];
        sharedMul[j].p[1] <== output_recipient_pubkey_y[j];

        maskAmount[j] = Poseidon(3);
        maskAmount[j].inputs[0] <== sharedMul[j].out[0];
        maskAmount[j].inputs[1] <== sharedMul[j].out[1];
        maskAmount[j].inputs[2] <== 0;
        maskRandomness[j] = Poseidon(3);
        maskRandomness[j].inputs[0] <== sharedMul[j].out[0];
        maskRandomness[j].inputs[1] <== sharedMul[j].out[1];
        maskRandomness[j].inputs[2] <== 1;

        c2_amount_check[j] <== output_enabled[j] * (output_c2_amount[j] - (output_amount[j] + maskAmount[j].out));
        c2_randomness_check[j] <== output_enabled[j] * (output_c2_randomness[j] - (output_randomness[j] + maskRandomness[j].out));
        c2_amount_check[j] === 0;
        c2_randomness_check[j] === 0;

        total_out[j + 1] <== total_out[j] + output_enabled[j] * output_amount[j];
    }

    total_in[MAX_INPUTS] === total_out[MAX_OUTPUTS];

    signal final_root_check;
    final_root_check <== root + 0;
    signal id_check;
    id_check <== circuit_id + final_root_check;
    id_check === circuit_id + final_root_check;
}

component main { public [
    root,
    identity_root,
    nullifier,
    output_commitment,
    output_enabled,
    amount_out,
    fee_amount,
    circuit_id
] } = Veilpay();
