use anyhow::{anyhow, Context, Result};
use ark_bn254::{Bn254, Fr};
use ark_circom::{read_zkey, CircomBuilder, CircomConfig};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::Groth16;
use ark_snark::SNARK;
use ark_std::rand::thread_rng;
use num_bigint::{BigInt, BigUint};
use serde_json::Value;
use std::{env, fs::File, path::PathBuf};
use tokio::runtime::Runtime;

// Shim for wasmer on some toolchains that don't export __rust_probestack.
#[unsafe(no_mangle)]
pub extern "C" fn __rust_probestack() {}

fn parse_big(value: &Value) -> Result<BigUint> {
    match value {
        Value::String(s) => BigUint::parse_bytes(s.as_bytes(), 10)
            .ok_or_else(|| anyhow!("invalid decimal string")),
        Value::Number(n) => BigUint::parse_bytes(n.to_string().as_bytes(), 10)
            .ok_or_else(|| anyhow!("invalid number")),
        _ => Err(anyhow!("invalid input value")),
    }
}

fn fq_to_be(fq: &impl BigInteger) -> [u8; 32] {
    let mut out = [0u8; 32];
    let bytes = fq.to_bytes_be();
    let start = 32 - bytes.len();
    out[start..].copy_from_slice(&bytes);
    out
}

fn g1_to_be(point: &ark_bn254::G1Affine) -> [u8; 64] {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&fq_to_be(&point.x.into_bigint()));
    out[32..].copy_from_slice(&fq_to_be(&point.y.into_bigint()));
    out
}

fn g2_to_be(point: &ark_bn254::G2Affine) -> [u8; 128] {
    let mut out = [0u8; 128];
    let ark_bn254::Fq2 { c0, c1 } = point.x;
    let ark_bn254::Fq2 { c0: y0, c1: y1 } = point.y;
    out[0..32].copy_from_slice(&fq_to_be(&c1.into_bigint()));
    out[32..64].copy_from_slice(&fq_to_be(&c0.into_bigint()));
    out[64..96].copy_from_slice(&fq_to_be(&y1.into_bigint()));
    out[96..128].copy_from_slice(&fq_to_be(&y0.into_bigint()));
    out
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 7 {
        return Err(anyhow!(
            "Usage: ark-prover <wasm> <r1cs> <zkey> <input.json> <out.json> <vk.json>"
        ));
    }
    let wasm_path = PathBuf::from(&args[1]);
    let r1cs_path = PathBuf::from(&args[2]);
    let zkey_path = PathBuf::from(&args[3]);
    let input_path = PathBuf::from(&args[4]);
    let out_path = PathBuf::from(&args[5]);
    let vk_path = PathBuf::from(&args[6]);

    let input_value: Value =
        serde_json::from_reader(File::open(&input_path).context("open input")?)?;
    let input_obj = input_value
        .as_object()
        .ok_or_else(|| anyhow!("input must be a JSON object"))?;

    let cfg = CircomConfig::<Fr>::new(wasm_path, r1cs_path)
        .map_err(|err| anyhow!("circom config failed: {err:?}"))?;
    let mut builder = CircomBuilder::new(cfg);
    for (key, value) in input_obj {
        let big = parse_big(value)?;
        let big_int = BigInt::from(big);
        builder.push_input(key, big_int);
    }

    let circom = builder
        .build()
        .map_err(|err| anyhow!("circom build failed: {err:?}"))?;
    let public_inputs = circom
        .get_public_inputs()
        .ok_or_else(|| anyhow!("missing public inputs"))?;

    let expected_inputs = [
        "root",
        "nullifier",
        "recipient_tag_hash",
        "ciphertext_commitment",
        "circuit_id",
    ];
    for (index, name) in expected_inputs.iter().enumerate() {
        let value = input_obj
            .get(*name)
            .ok_or_else(|| anyhow!("missing input {name}"))?;
        let big = parse_big(value)?;
        let fr = Fr::from_be_bytes_mod_order(&big.to_bytes_be());
        if public_inputs
            .get(index)
            .ok_or_else(|| anyhow!("public input {name} missing"))?
            != &fr
        {
            return Err(anyhow!("public input mismatch for {name}"));
        }
    }

    let mut zkey_file = File::open(&zkey_path).context("open zkey")?;
    let (pk, _) = read_zkey(&mut zkey_file)
        .map_err(|err| anyhow!("read zkey failed: {err:?}"))?;

    let mut rng = thread_rng();
    let proof = Groth16::<Bn254>::prove(&pk, circom, &mut rng)
        .map_err(|err| anyhow!("proof failed: {err:?}"))?;
    let ok = Groth16::<Bn254>::verify(&pk.vk, &public_inputs, &proof)
        .map_err(|err| anyhow!("verify failed: {err:?}"))?;
    if !ok {
        return Err(anyhow!("arkworks verification failed"));
    }

    let a = g1_to_be(&proof.a);
    let b = g2_to_be(&proof.b);
    let c = g1_to_be(&proof.c);
    let mut proof_bytes = Vec::with_capacity(256);
    proof_bytes.extend_from_slice(&a);
    proof_bytes.extend_from_slice(&b);
    proof_bytes.extend_from_slice(&c);

    let public_inputs_bytes: Vec<u8> = public_inputs
        .iter()
        .flat_map(|fr| fq_to_be(&fr.into_bigint()))
        .collect();

    let out = serde_json::json!({
        "proof_bytes": hex_encode(&proof_bytes),
        "public_inputs_bytes": hex_encode(&public_inputs_bytes),
        "public_inputs": public_inputs.iter().map(|fr| fr.into_bigint().to_string()).collect::<Vec<_>>(),
    });
    serde_json::to_writer_pretty(File::create(&out_path)?, &out)?;

    let vk = pk.vk;
    let vk_out = serde_json::json!({
        "alpha_g1": hex_encode(&g1_to_be(&vk.alpha_g1)),
        "beta_g2": hex_encode(&g2_to_be(&vk.beta_g2)),
        "gamma_g2": hex_encode(&g2_to_be(&vk.gamma_g2)),
        "delta_g2": hex_encode(&g2_to_be(&vk.delta_g2)),
        "gamma_abc": vk.gamma_abc_g1.iter().map(|g1| hex_encode(&g1_to_be(g1))).collect::<Vec<_>>(),
    });
    serde_json::to_writer_pretty(File::create(&vk_path)?, &vk_out)?;

    Ok(())
}

fn main() -> Result<()> {
    let rt = Runtime::new().context("create tokio runtime")?;
    rt.block_on(async { run() })
}
