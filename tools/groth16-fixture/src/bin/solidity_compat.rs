use anyhow::{anyhow, Context, Result};
use solana_bn254::prelude::{
    alt_bn128_g1_addition_be, alt_bn128_g1_addition_le, alt_bn128_g1_multiplication_be,
    alt_bn128_g1_multiplication_le, alt_bn128_pairing_be, alt_bn128_pairing_le,
    ALT_BN128_G1_MULTIPLICATION_INPUT_SIZE, ALT_BN128_G1_POINT_SIZE,
    ALT_BN128_PAIRING_ELEMENT_SIZE, ALT_BN128_PAIRING_OUTPUT_SIZE,
};
use std::{env, fs};
use ark_bn254::{Fq, Fq2, G1Affine, G2Affine};
use ark_ff::PrimeField;

#[derive(Clone, Copy, Debug)]
enum Endian {
    Be,
    Le,
}

fn hex_to_bytes<const N: usize>(value: &str) -> Result<[u8; N]> {
    let clean = value.strip_prefix("0x").unwrap_or(value);
    let bytes = hex::decode(clean)?;
    if bytes.len() != N {
        return Err(anyhow!("expected {N} bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn fq_from_be(bytes: &[u8; 32]) -> Fq {
    Fq::from_be_bytes_mod_order(bytes)
}

fn g1_on_curve(bytes: &[u8; 64]) -> bool {
    let mut x = [0u8; 32];
    let mut y = [0u8; 32];
    x.copy_from_slice(&bytes[0..32]);
    y.copy_from_slice(&bytes[32..64]);
    let p = G1Affine::new_unchecked(fq_from_be(&x), fq_from_be(&y));
    p.is_on_curve()
}

fn g2_on_curve(bytes: &[u8; 128], swapped: bool) -> (bool, bool) {
    let mut x0 = [0u8; 32];
    let mut x1 = [0u8; 32];
    let mut y0 = [0u8; 32];
    let mut y1 = [0u8; 32];
    if swapped {
        x0.copy_from_slice(&bytes[32..64]);
        x1.copy_from_slice(&bytes[0..32]);
        y0.copy_from_slice(&bytes[96..128]);
        y1.copy_from_slice(&bytes[64..96]);
    } else {
        x0.copy_from_slice(&bytes[0..32]);
        x1.copy_from_slice(&bytes[32..64]);
        y0.copy_from_slice(&bytes[64..96]);
        y1.copy_from_slice(&bytes[96..128]);
    }
    let x = Fq2::new(fq_from_be(&x0), fq_from_be(&x1));
    let y = Fq2::new(fq_from_be(&y0), fq_from_be(&y1));
    let p = G2Affine::new_unchecked(x, y);
    (p.is_on_curve(), p.is_in_correct_subgroup_assuming_on_curve())
}

fn pairing_is_one(output: &[u8]) -> bool {
    output.len() == ALT_BN128_PAIRING_OUTPUT_SIZE
        && output.iter().take(31).all(|b| *b == 0)
        && output[31] == 1
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
    let p = [
        48, 100, 78, 114, 225, 49, 160, 41, 184, 80, 69, 182, 129, 129, 88, 93, 151, 129,
        106, 145, 104, 113, 202, 141, 60, 32, 140, 22, 216, 124, 253, 71,
    ];
    let mut y_be = y;
    if let Endian::Le = endian {
        y_be.reverse();
    }
    let mut neg = [0u8; 32];
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let a = p[i] as i16;
        let b = y_be[i] as i16 + borrow as i16;
        if a < b {
            neg[i] = (a + 256 - b) as u8;
            borrow = 1;
        } else {
            neg[i] = (a - b) as u8;
            borrow = 0;
        }
    }
    if let Endian::Le = endian {
        neg.reverse();
    }
    out[32..64].copy_from_slice(&neg);
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
            "Usage: solidity_compat <verifier_key.json> <snarkjs_proof.json>"
        ));
    }
    let vk_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&args[1])?)?;
    let proof_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&args[2])?)?;

    let alpha_g1 = hex_to_bytes::<64>(
        vk_json
            .get("alpha_g1")
            .and_then(|v| v.as_str())
            .context("alpha_g1")?,
    )?;
    let beta_g2 = hex_to_bytes::<128>(
        vk_json
            .get("beta_g2")
            .and_then(|v| v.as_str())
            .context("beta_g2")?,
    )?;
    let gamma_g2 = hex_to_bytes::<128>(
        vk_json
            .get("gamma_g2")
            .and_then(|v| v.as_str())
            .context("gamma_g2")?,
    )?;
    let delta_g2 = hex_to_bytes::<128>(
        vk_json
            .get("delta_g2")
            .and_then(|v| v.as_str())
            .context("delta_g2")?,
    )?;
    let gamma_abc = vk_json
        .get("gamma_abc")
        .and_then(|v| v.as_array())
        .context("gamma_abc")?
        .iter()
        .map(|v| hex_to_bytes::<64>(v.as_str().context("gamma_abc entry")?))
        .collect::<Result<Vec<_>>>()?;

    let solidity = proof_json
        .get("solidity")
        .and_then(|v| v.as_object())
        .context("solidity")?;
    let a = solidity.get("a").context("a")?.as_array().context("a array")?;
    let b = solidity.get("b").context("b")?.as_array().context("b array")?;
    let c = solidity.get("c").context("c")?.as_array().context("c array")?;
    let inputs = solidity
        .get("inputs")
        .context("inputs")?
        .as_array()
        .context("inputs array")?;

    let a_bytes = [
        hex_to_bytes::<32>(a[0].as_str().context("a0")?)?,
        hex_to_bytes::<32>(a[1].as_str().context("a1")?)?,
    ]
    .concat();
    let b0 = b[0].as_array().context("b0 array")?;
    let b1 = b[1].as_array().context("b1 array")?;
    let b_bytes_direct = [
        hex_to_bytes::<32>(b0[0].as_str().context("b00")?)?,
        hex_to_bytes::<32>(b0[1].as_str().context("b01")?)?,
        hex_to_bytes::<32>(b1[0].as_str().context("b10")?)?,
        hex_to_bytes::<32>(b1[1].as_str().context("b11")?)?,
    ]
    .concat();
    let b_bytes_swapped = [
        hex_to_bytes::<32>(b0[1].as_str().context("b01")?)?,
        hex_to_bytes::<32>(b0[0].as_str().context("b00")?)?,
        hex_to_bytes::<32>(b1[1].as_str().context("b11")?)?,
        hex_to_bytes::<32>(b1[0].as_str().context("b10")?)?,
    ]
    .concat();
    let c_bytes = [
        hex_to_bytes::<32>(c[0].as_str().context("c0")?)?,
        hex_to_bytes::<32>(c[1].as_str().context("c1")?)?,
    ]
    .concat();

    let mut a_fixed = [0u8; 64];
    a_fixed.copy_from_slice(&a_bytes);
    let mut c_fixed = [0u8; 64];
    c_fixed.copy_from_slice(&c_bytes);

    let mut b_direct = [0u8; 128];
    b_direct.copy_from_slice(&b_bytes_direct);
    let mut b_swapped = [0u8; 128];
    b_swapped.copy_from_slice(&b_bytes_swapped);

    let (b_on, b_sub) = g2_on_curve(&b_direct, false);
    let (b_sw_on, b_sw_sub) = g2_on_curve(&b_direct, true);
    let (b2_on, b2_sub) = g2_on_curve(&b_swapped, false);
    let (b2_sw_on, b2_sw_sub) = g2_on_curve(&b_swapped, true);
    let (beta_on, beta_sub) = g2_on_curve(&beta_g2, false);
    let (beta_sw_on, beta_sw_sub) = g2_on_curve(&beta_g2, true);
    let (gamma_on, gamma_sub) = g2_on_curve(&gamma_g2, false);
    let (gamma_sw_on, gamma_sw_sub) = g2_on_curve(&gamma_g2, true);
    let (delta_on, delta_sub) = g2_on_curve(&delta_g2, false);
    let (delta_sw_on, delta_sw_sub) = g2_on_curve(&delta_g2, true);

    println!("A on curve: {}", g1_on_curve(&a_fixed));
    println!("C on curve: {}", g1_on_curve(&c_fixed));
    println!("B direct on curve (as-is): {b_on} subgroup: {b_sub}");
    println!("B direct on curve (swapped): {b_sw_on} subgroup: {b_sw_sub}");
    println!("B swapped on curve (as-is): {b2_on} subgroup: {b2_sub}");
    println!("B swapped on curve (swapped): {b2_sw_on} subgroup: {b2_sw_sub}");
    println!("vk beta on curve (as-is): {beta_on} subgroup: {beta_sub}");
    println!("vk beta on curve (swapped): {beta_sw_on} subgroup: {beta_sw_sub}");
    println!("vk gamma on curve (as-is): {gamma_on} subgroup: {gamma_sub}");
    println!("vk gamma on curve (swapped): {gamma_sw_on} subgroup: {gamma_sw_sub}");
    println!("vk delta on curve (as-is): {delta_on} subgroup: {delta_sub}");
    println!("vk delta on curve (swapped): {delta_sw_on} subgroup: {delta_sw_sub}");

    let public_inputs = inputs
        .iter()
        .map(|v| hex_to_bytes::<32>(v.as_str().context("input")?))
        .collect::<Result<Vec<_>>>()?;

    for (label, b_fixed) in [("direct", b_direct), ("swapped", b_swapped)] {
        for endian in [Endian::Be, Endian::Le] {
            match verify(
                &a_fixed,
                &b_fixed,
                &c_fixed,
                &alpha_g1,
                &beta_g2,
                &gamma_g2,
                &delta_g2,
                &gamma_abc,
                &public_inputs,
                endian,
            ) {
                Ok(ok) => println!("{label} {endian:?} -> {ok}"),
                Err(err) => println!("{label} {endian:?} -> error: {err}"),
            }
        }
    }

    Ok(())
}
