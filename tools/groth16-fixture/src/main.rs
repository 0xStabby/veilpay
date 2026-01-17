use ark_bn254::{Bn254, Fr, Fq2, G1Affine, G2Affine};
use ark_ec::{AffineRepr, CurveGroup};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::{r1cs_to_qap::LibsnarkReduction, Groth16};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_r1cs_std::{alloc::AllocVar, eq::EqGadget, fields::fp::FpVar, fields::FieldVar};
use ark_snark::SNARK;
use rand::thread_rng;
use serde::Serialize;
use std::{fs, path::PathBuf};
use solana_bn254::prelude::{alt_bn128_pairing_be, ALT_BN128_PAIRING_ELEMENT_SIZE};

#[derive(Clone)]
struct OneCircuit {
    pub x: Fr,
}

impl ConstraintSynthesizer<Fr> for OneCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let x_var = FpVar::new_input(cs, || Ok(self.x))?;
        let one = FpVar::constant(Fr::from(1u64));
        x_var.enforce_equal(&one)?;
        Ok(())
    }
}

#[derive(Serialize)]
struct Fixture {
    alpha_g1: String,
    beta_g2: String,
    gamma_g2: String,
    delta_g2: String,
    gamma_abc: Vec<String>,
    proof: String,
    public_inputs: Vec<String>,
}

fn main() -> anyhow::Result<()> {
    let mut rng = thread_rng();
    let circuit = OneCircuit { x: Fr::from(1u64) };
    let (pk, vk) =
        Groth16::<Bn254, LibsnarkReduction>::circuit_specific_setup(circuit.clone(), &mut rng)?;
    let proof = Groth16::<Bn254, LibsnarkReduction>::prove(&pk, circuit, &mut rng)?;
    let public_inputs = vec![Fr::from(1u64)];

    let ok = Groth16::<Bn254, LibsnarkReduction>::verify(&vk, &public_inputs, &proof)?;
    if !ok {
        anyhow::bail!("fixture proof did not verify");
    }

    if !verify_with_solana_bn254(&vk, &proof, &public_inputs)? {
        anyhow::bail!("solana-bn254 pairing check failed");
    }

    let gamma_abc: Vec<String> = vk
        .gamma_abc_g1
        .iter()
        .map(|g1| hex_encode(&g1_to_be(g1)))
        .collect();

    let fixture = Fixture {
        alpha_g1: hex_encode(&g1_to_be(&vk.alpha_g1)),
        beta_g2: hex_encode(&g2_to_be(&vk.beta_g2)),
        gamma_g2: hex_encode(&g2_to_be(&vk.gamma_g2)),
        delta_g2: hex_encode(&g2_to_be(&vk.delta_g2)),
        gamma_abc,
        proof: hex_encode(&proof_to_be(&proof.a, &proof.b, &proof.c)),
        public_inputs: public_inputs
            .iter()
            .map(|fr| hex_encode(&fr_to_be(fr)))
            .collect(),
    };

    let out_path = PathBuf::from("../../tests/fixtures/groth16.json");
    fs::create_dir_all(out_path.parent().unwrap())?;
    fs::write(out_path, serde_json::to_vec_pretty(&fixture)?)?;
    Ok(())
}

fn fr_to_be(fr: &Fr) -> [u8; 32] {
    fq_to_be(&fr.into_bigint())
}

fn fq_to_be(fq: &impl BigInteger) -> [u8; 32] {
    let mut out = [0u8; 32];
    let bytes = fq.to_bytes_be();
    let start = 32 - bytes.len();
    out[start..].copy_from_slice(&bytes);
    out
}

fn g1_to_be(point: &G1Affine) -> [u8; 64] {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&fq_to_be(&point.x.into_bigint()));
    out[32..].copy_from_slice(&fq_to_be(&point.y.into_bigint()));
    out
}

fn g2_to_be(point: &G2Affine) -> [u8; 128] {
    let mut out = [0u8; 128];
    let Fq2 { c0, c1 } = point.x;
    let Fq2 { c0: y0, c1: y1 } = point.y;
    out[0..32].copy_from_slice(&fq_to_be(&c1.into_bigint()));
    out[32..64].copy_from_slice(&fq_to_be(&c0.into_bigint()));
    out[64..96].copy_from_slice(&fq_to_be(&y1.into_bigint()));
    out[96..128].copy_from_slice(&fq_to_be(&y0.into_bigint()));
    out
}

fn proof_to_be(a: &G1Affine, b: &G2Affine, c: &G1Affine) -> [u8; 256] {
    let mut out = [0u8; 256];
    out[..64].copy_from_slice(&g1_to_be(a));
    out[64..192].copy_from_slice(&g2_to_be(b));
    out[192..].copy_from_slice(&g1_to_be(c));
    out
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn verify_with_solana_bn254(
    vk: &ark_groth16::VerifyingKey<Bn254>,
    proof: &ark_groth16::Proof<Bn254>,
    public_inputs: &[Fr],
) -> anyhow::Result<bool> {
    let mut acc = vk.gamma_abc_g1[0].into_group();
    for (i, input) in public_inputs.iter().enumerate() {
        let mut term = vk.gamma_abc_g1[i + 1].into_group();
        term *= *input;
        acc += term;
    }
    let vk_x = acc.into_affine();

    let a = g1_to_be(&proof.a);
    let b = g2_to_be(&proof.b);
    let neg_alpha = g1_to_be(&(-vk.alpha_g1));
    let neg_vk_x = g1_to_be(&(-vk_x));
    let neg_c = g1_to_be(&(-proof.c));

    let mut pairing_input = Vec::with_capacity(ALT_BN128_PAIRING_ELEMENT_SIZE * 4);
    pairing_input.extend_from_slice(&a);
    pairing_input.extend_from_slice(&b);
    pairing_input.extend_from_slice(&neg_alpha);
    pairing_input.extend_from_slice(&g2_to_be(&vk.beta_g2));
    pairing_input.extend_from_slice(&neg_vk_x);
    pairing_input.extend_from_slice(&g2_to_be(&vk.gamma_g2));
    pairing_input.extend_from_slice(&neg_c);
    pairing_input.extend_from_slice(&g2_to_be(&vk.delta_g2));

    let result = alt_bn128_pairing_be(&pairing_input)?;
    Ok(result.len() == 32 && result[..31].iter().all(|b| *b == 0) && result[31] == 1)
}
