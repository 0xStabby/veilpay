use anyhow::{anyhow, Context, Result};
use num_bigint::BigUint;
use num_traits::Num;
use serde_json::Value;
use ark_bn254::{Fq, Fq2, G1Affine, G2Affine};
use ark_ff::PrimeField;
use solana_bn254::prelude::{
    alt_bn128_g1_addition_be, alt_bn128_g1_addition_le, alt_bn128_g1_multiplication_be,
    alt_bn128_g1_multiplication_le, alt_bn128_pairing_be, alt_bn128_pairing_le,
    ALT_BN128_G1_MULTIPLICATION_INPUT_SIZE, ALT_BN128_G1_POINT_SIZE,
    ALT_BN128_PAIRING_ELEMENT_SIZE, ALT_BN128_PAIRING_OUTPUT_SIZE,
};
use std::{env, fs};

const FIELD_MODULUS_HEX: &str =
    "30644e72e131a029b85045b18129442825a3a3472c78c5924fa346e227be2f39";

#[derive(Clone, Copy, Debug)]
enum G2Order {
    Snarkjs,
    Swapped,
}

#[derive(Clone, Copy, Debug)]
enum Endian {
    Be,
    Le,
}

fn parse_big(value: &Value) -> Result<BigUint> {
    let s = value
        .as_str()
        .ok_or_else(|| anyhow!("expected string"))?;
    BigUint::from_str_radix(s, 10).map_err(|err| anyhow!(err))
}

fn parse_hex_big(value: &Value) -> Result<BigUint> {
    let s = value
        .as_str()
        .ok_or_else(|| anyhow!("expected hex string"))?;
    let clean = s.strip_prefix("0x").unwrap_or(s);
    BigUint::from_str_radix(clean, 16).map_err(|err| anyhow!(err))
}

fn big_to_bytes32(value: &BigUint, endian: Endian) -> Result<[u8; 32]> {
    let mut out = [0u8; 32];
    let bytes = value.to_bytes_be();
    if bytes.len() > 32 {
        return Err(anyhow!("value exceeds 32 bytes"));
    }
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    if let Endian::Le = endian {
        out.reverse();
    }
    Ok(out)
}

fn bytes32_to_big(bytes: &[u8; 32]) -> BigUint {
    BigUint::from_bytes_be(bytes)
}

fn parse_g1(value: &Value) -> Result<[BigUint; 2]> {
    let arr = value.as_array().ok_or_else(|| anyhow!("g1 not array"))?;
    Ok([parse_big(&arr[0])?, parse_big(&arr[1])?])
}

fn parse_g2(value: &Value) -> Result<[[BigUint; 2]; 2]> {
    let arr = value.as_array().ok_or_else(|| anyhow!("g2 not array"))?;
    let x = arr[0].as_array().ok_or_else(|| anyhow!("g2 x not array"))?;
    let y = arr[1].as_array().ok_or_else(|| anyhow!("g2 y not array"))?;
    Ok([
        [parse_big(&x[0])?, parse_big(&x[1])?],
        [parse_big(&y[0])?, parse_big(&y[1])?],
    ])
}

fn fq_from_big(value: &BigUint, endian: Endian) -> Fq {
    let mut bytes = value.to_bytes_be();
    if let Endian::Le = endian {
        bytes.reverse();
    }
    Fq::from_be_bytes_mod_order(&bytes)
}

fn g1_on_curve(point: &[BigUint; 2], endian: Endian) -> bool {
    let x = fq_from_big(&point[0], endian);
    let y = fq_from_big(&point[1], endian);
    G1Affine::new_unchecked(x, y).is_on_curve()
}

fn g2_on_curve(point: &[[BigUint; 2]; 2], order: G2Order, endian: Endian) -> bool {
    let (x0, x1, y0, y1) = match order {
        G2Order::Snarkjs => (&point[0][0], &point[0][1], &point[1][0], &point[1][1]),
        G2Order::Swapped => (&point[0][1], &point[0][0], &point[1][1], &point[1][0]),
    };
    let x = Fq2::new(fq_from_big(x0, endian), fq_from_big(x1, endian));
    let y = Fq2::new(fq_from_big(y0, endian), fq_from_big(y1, endian));
    G2Affine::new_unchecked(x, y).is_on_curve()
}

fn g1_bytes(point: &[BigUint; 2], endian: Endian) -> Result<[u8; 64]> {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&big_to_bytes32(&point[0], endian)?);
    out[32..].copy_from_slice(&big_to_bytes32(&point[1], endian)?);
    Ok(out)
}

fn g2_bytes(point: &[[BigUint; 2]; 2], order: G2Order, endian: Endian) -> Result<[u8; 128]> {
    let mut out = [0u8; 128];
    let (x0, x1, y0, y1) = match order {
        G2Order::Snarkjs => (&point[0][0], &point[0][1], &point[1][0], &point[1][1]),
        G2Order::Swapped => (&point[0][1], &point[0][0], &point[1][1], &point[1][0]),
    };
    out[0..32].copy_from_slice(&big_to_bytes32(x0, endian)?);
    out[32..64].copy_from_slice(&big_to_bytes32(x1, endian)?);
    out[64..96].copy_from_slice(&big_to_bytes32(y0, endian)?);
    out[96..128].copy_from_slice(&big_to_bytes32(y1, endian)?);
    Ok(out)
}

fn g1_add(a: &[u8; 64], b: &[u8; 64], endian: Endian) -> Result<[u8; 64]> {
    let mut input = [0u8; 128];
    input[..64].copy_from_slice(a);
    input[64..].copy_from_slice(b);
    let out = match endian {
        Endian::Be => alt_bn128_g1_addition_be(&input)
            .map_err(|_| anyhow!("g1 add failed"))?,
        Endian::Le => alt_bn128_g1_addition_le(&input)
            .map_err(|_| anyhow!("g1 add failed"))?,
    };
    if out.len() != ALT_BN128_G1_POINT_SIZE {
        return Err(anyhow!("invalid g1 add output"));
    }
    let mut fixed = [0u8; 64];
    fixed.copy_from_slice(&out[..64]);
    Ok(fixed)
}

fn g1_mul(point: &[u8; 64], scalar: &[u8; 32], endian: Endian) -> Result<[u8; 64]> {
    let mut input = [0u8; ALT_BN128_G1_MULTIPLICATION_INPUT_SIZE];
    input[..64].copy_from_slice(point);
    input[64..96].copy_from_slice(scalar);
    let out = match endian {
        Endian::Be => alt_bn128_g1_multiplication_be(&input)
            .map_err(|_| anyhow!("g1 mul failed"))?,
        Endian::Le => alt_bn128_g1_multiplication_le(&input)
            .map_err(|_| anyhow!("g1 mul failed"))?,
    };
    if out.len() != ALT_BN128_G1_POINT_SIZE {
        return Err(anyhow!("invalid g1 mul output"));
    }
    let mut fixed = [0u8; 64];
    fixed.copy_from_slice(&out[..64]);
    Ok(fixed)
}

fn negate_g1(point: &[u8; 64], endian: Endian) -> Result<[u8; 64]> {
    let mut out = *point;
    let mut y = [0u8; 32];
    y.copy_from_slice(&point[32..64]);
    if y.iter().all(|b| *b == 0) {
        return Ok(out);
    }
    let p = BigUint::from_str_radix(FIELD_MODULUS_HEX, 16)?;
    let y_bytes = match endian {
        Endian::Be => y,
        Endian::Le => {
            let mut tmp = y;
            tmp.reverse();
            tmp
        }
    };
    let y_big = bytes32_to_big(&y_bytes);
    let neg = (&p - y_big) % p;
    out[32..64].copy_from_slice(&big_to_bytes32(&neg, endian)?);
    Ok(out)
}

fn compute_vk_x(
    gamma_abc: &[[u8; 64]],
    public_inputs: &[[u8; 32]],
    endian: Endian,
) -> Result<[u8; 64]> {
    let mut acc = gamma_abc[0];
    for (i, input) in public_inputs.iter().enumerate() {
        let term = g1_mul(&gamma_abc[i + 1], input, endian)?;
        acc = g1_add(&acc, &term, endian)?;
    }
    Ok(acc)
}

fn pairing_is_one(output: &[u8]) -> bool {
    output.len() == ALT_BN128_PAIRING_OUTPUT_SIZE
        && output.iter().take(31).all(|b| *b == 0)
        && output[31] == 1
}

fn verify(
    a: &[u8; 64],
    b: &[u8; 128],
    c: &[u8; 64],
    key_alpha: &[u8; 64],
    key_beta: &[u8; 128],
    key_gamma: &[u8; 128],
    key_delta: &[u8; 128],
    gamma_abc: &[[u8; 64]],
    public_inputs: &[[u8; 32]],
    endian: Endian,
) -> Result<bool> {
    let vk_x = compute_vk_x(gamma_abc, public_inputs, endian)?;
    let neg_alpha = negate_g1(key_alpha, endian)?;
    let neg_vk_x = negate_g1(&vk_x, endian)?;
    let neg_c = negate_g1(c, endian)?;

    let mut pairing_input =
        Vec::with_capacity(ALT_BN128_PAIRING_ELEMENT_SIZE * 4);
    pairing_input.extend_from_slice(a);
    pairing_input.extend_from_slice(b);
    pairing_input.extend_from_slice(&neg_alpha);
    pairing_input.extend_from_slice(key_beta);
    pairing_input.extend_from_slice(&neg_vk_x);
    pairing_input.extend_from_slice(key_gamma);
    pairing_input.extend_from_slice(&neg_c);
    pairing_input.extend_from_slice(key_delta);

    let result = match endian {
        Endian::Be => alt_bn128_pairing_be(&pairing_input),
        Endian::Le => alt_bn128_pairing_le(&pairing_input),
    }
    .map_err(|err| anyhow!("pairing failed: {err:?}"))?;
    Ok(pairing_is_one(&result))
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        return Err(anyhow!(
            "Usage: snarkjs_compat <verification_key.json> <proof.json>"
        ));
    }
    let vkey_path = &args[1];
    let proof_path = &args[2];

    let vkey_json: Value = serde_json::from_str(&fs::read_to_string(vkey_path)?)?;
    let proof_json: Value = serde_json::from_str(&fs::read_to_string(proof_path)?)?;

    let proof_value = proof_json
        .get("proof")
        .unwrap_or(&proof_json);
    let public_signals = proof_json
        .get("publicSignals")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("publicSignals missing"))?;

    let vk_alpha = parse_g1(vkey_json.get("vk_alpha_1").context("vk_alpha_1")?)?;
    let vk_beta = parse_g2(vkey_json.get("vk_beta_2").context("vk_beta_2")?)?;
    let vk_gamma = parse_g2(vkey_json.get("vk_gamma_2").context("vk_gamma_2")?)?;
    let vk_delta = parse_g2(vkey_json.get("vk_delta_2").context("vk_delta_2")?)?;
    let ic = vkey_json.get("IC").context("IC")?.as_array().context("IC array")?;

    let input_values: Vec<BigUint> = if let Some(solidity) = proof_json.get("solidity") {
        let inputs = solidity
            .get("inputs")
            .context("solidity.inputs")?
            .as_array()
            .context("inputs array")?;
        inputs.iter().map(parse_hex_big).collect::<Result<_>>()?
    } else {
        public_signals.iter().map(parse_big).collect::<Result<_>>()?
    };

    let pub_inputs_be: Vec<[u8; 32]> = input_values
        .iter()
        .map(|entry| big_to_bytes32(entry, Endian::Be))
        .collect::<Result<_>>()?;

    let pub_inputs_le: Vec<[u8; 32]> = input_values
        .iter()
        .map(|entry| big_to_bytes32(entry, Endian::Le))
        .collect::<Result<_>>()?;

    let (proof_a, proof_b, proof_c) = if let Some(solidity) = proof_json.get("solidity") {
        let a = solidity.get("a").context("solidity.a")?.as_array().context("a array")?;
        let b = solidity.get("b").context("solidity.b")?.as_array().context("b array")?;
        let c = solidity.get("c").context("solidity.c")?.as_array().context("c array")?;
        let b0 = b[0].as_array().context("b[0] array")?;
        let b1 = b[1].as_array().context("b[1] array")?;
        let a0 = parse_hex_big(&a[0])?;
        let a1 = parse_hex_big(&a[1])?;
        let c0 = parse_hex_big(&c[0])?;
        let c1 = parse_hex_big(&c[1])?;
        let b00 = parse_hex_big(&b0[0])?;
        let b01 = parse_hex_big(&b0[1])?;
        let b10 = parse_hex_big(&b1[0])?;
        let b11 = parse_hex_big(&b1[1])?;
        (
            [a0, a1],
            [[b00, b01], [b10, b11]],
            [c0, c1],
        )
    } else {
        (
            parse_g1(proof_value.get("pi_a").context("pi_a")?)?,
            parse_g2(proof_value.get("pi_b").context("pi_b")?)?,
            parse_g1(proof_value.get("pi_c").context("pi_c")?)?,
        )
    };

    for endian in [Endian::Be, Endian::Le] {
        println!(
            "curve check endian={:?}: g1_a={} g1_c={} g2_b(snarkjs)={} g2_b(swapped)={}",
            endian,
            g1_on_curve(&proof_a, endian),
            g1_on_curve(&proof_c, endian),
            g2_on_curve(&proof_b, G2Order::Snarkjs, endian),
            g2_on_curve(&proof_b, G2Order::Swapped, endian)
        );
        println!(
            "vk g2 endian={:?}: beta(snarkjs)={} beta(swapped)={} gamma(snarkjs)={} gamma(swapped)={} delta(snarkjs)={} delta(swapped)={}",
            endian,
            g2_on_curve(&vk_beta, G2Order::Snarkjs, endian),
            g2_on_curve(&vk_beta, G2Order::Swapped, endian),
            g2_on_curve(&vk_gamma, G2Order::Snarkjs, endian),
            g2_on_curve(&vk_gamma, G2Order::Swapped, endian),
            g2_on_curve(&vk_delta, G2Order::Snarkjs, endian),
            g2_on_curve(&vk_delta, G2Order::Swapped, endian)
        );
        let gamma_abc: Vec<[u8; 64]> = ic
            .iter()
            .map(|entry| g1_bytes(&parse_g1(entry)?, endian))
            .collect::<Result<_>>()?;
        let a_bytes = g1_bytes(&proof_a, endian)?;
        let c_bytes = g1_bytes(&proof_c, endian)?;
        let pub_inputs = match endian {
            Endian::Be => &pub_inputs_be,
            Endian::Le => &pub_inputs_le,
        };
        let alpha_bytes = g1_bytes(&vk_alpha, endian)?;

        for vk_order in [G2Order::Snarkjs, G2Order::Swapped] {
            let beta_bytes = g2_bytes(&vk_beta, vk_order, endian)?;
            let gamma_bytes = g2_bytes(&vk_gamma, vk_order, endian)?;
            let delta_bytes = g2_bytes(&vk_delta, vk_order, endian)?;
            for proof_order in [G2Order::Snarkjs, G2Order::Swapped] {
                let b_bytes = g2_bytes(&proof_b, proof_order, endian)?;
                let result = verify(
                    &a_bytes,
                    &b_bytes,
                    &c_bytes,
                    &alpha_bytes,
                    &beta_bytes,
                    &gamma_bytes,
                    &delta_bytes,
                    &gamma_abc,
                    pub_inputs,
                    endian,
                );
                match result {
                    Ok(ok) => {
                        println!(
                            "endian={:?} vk_g2={:?} proof_g2={:?} -> {}",
                            endian,
                            vk_order,
                            proof_order,
                            if ok { "ok" } else { "fail" }
                        );
                    }
                    Err(err) => {
                        println!(
                            "endian={:?} vk_g2={:?} proof_g2={:?} -> error: {}",
                            endian, vk_order, proof_order, err
                        );
                    }
                }
            }
        }
    }

    Ok(())
}
