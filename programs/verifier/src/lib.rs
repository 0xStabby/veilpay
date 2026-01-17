use anchor_lang::prelude::*;
use solana_bn254::prelude::{
    alt_bn128_g1_addition_be, alt_bn128_g1_multiplication_be, alt_bn128_pairing_be,
    ALT_BN128_G1_POINT_SIZE, ALT_BN128_G1_MULTIPLICATION_INPUT_SIZE,
    ALT_BN128_PAIRING_ELEMENT_SIZE, ALT_BN128_PAIRING_OUTPUT_SIZE,
};

declare_id!("CRZejShyrDfr86ZnBZbGG2hyfD9jz82cX3XhoFEtFWCm");

const MAX_PUBLIC_INPUTS: usize = 8;

#[program]
pub mod verifier {
    use super::*;

    pub fn initialize_verifier_key(
        ctx: Context<InitializeVerifierKey>,
        args: InitializeVerifierKeyArgs,
    ) -> Result<()> {
        require!(
            args.gamma_abc.len() <= MAX_PUBLIC_INPUTS + 1,
            VerifierError::TooManyInputs
        );
        require!(
            args.public_inputs_len as usize + 1 == args.gamma_abc.len(),
            VerifierError::InvalidInputCount
        );

        let key = &mut ctx.accounts.verifier_key;
        key.alpha_g1 = to_fixed_64(&args.alpha_g1)?;
        key.beta_g2 = to_fixed_128(&args.beta_g2)?;
        key.gamma_g2 = to_fixed_128(&args.gamma_g2)?;
        key.delta_g2 = to_fixed_128(&args.delta_g2)?;
        key.public_inputs_len = args.public_inputs_len;
        key.gamma_abc = args
            .gamma_abc
            .into_iter()
            .map(|v| to_fixed_64(&v))
            .collect::<Result<Vec<[u8; 64]>>>()?;
        key.mock = args.mock;
        key.bump = ctx.bumps.verifier_key;
        Ok(())
    }

    pub fn verify_groth16(
        ctx: Context<VerifyGroth16>,
        proof: Vec<u8>,
        public_inputs: Vec<u8>,
    ) -> Result<()> {
        let key = &ctx.accounts.verifier_key;
        require!(
            public_inputs.len() == key.public_inputs_len as usize * 32,
            VerifierError::InvalidInputCount
        );
        if key.mock {
            let _ = parse_proof(&proof)?;
            return Ok(());
        }

        let (a, b, c) = parse_proof(&proof)?;
        let vk_x = compute_vk_x(&key.gamma_abc, &public_inputs)?;

        let neg_alpha = negate_g1(&key.alpha_g1);
        let neg_vk_x = negate_g1(&vk_x);
        let neg_c = negate_g1(&c);

        let mut pairing_input = Vec::with_capacity(ALT_BN128_PAIRING_ELEMENT_SIZE * 4);
        pairing_input.extend_from_slice(&a);
        pairing_input.extend_from_slice(&b);
        pairing_input.extend_from_slice(&neg_alpha);
        pairing_input.extend_from_slice(&key.beta_g2);
        pairing_input.extend_from_slice(&neg_vk_x);
        pairing_input.extend_from_slice(&key.gamma_g2);
        pairing_input.extend_from_slice(&neg_c);
        pairing_input.extend_from_slice(&key.delta_g2);

        let result = alt_bn128_pairing_be(&pairing_input).map_err(|_| VerifierError::PairingFailed)?;
        require!(pairing_is_one(&result), VerifierError::InvalidProof);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(args: InitializeVerifierKeyArgs)]
pub struct InitializeVerifierKey<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + VerifierKey::INIT_SPACE,
        seeds = [b"verifier_key", args.key_id.to_le_bytes().as_ref()],
        bump
    )]
    pub verifier_key: Account<'info, VerifierKey>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyGroth16<'info> {
    pub verifier_key: Account<'info, VerifierKey>,
}

#[account]
#[derive(InitSpace)]
pub struct VerifierKey {
    pub alpha_g1: [u8; 64],
    pub beta_g2: [u8; 128],
    pub gamma_g2: [u8; 128],
    pub delta_g2: [u8; 128],
    pub public_inputs_len: u32,
    #[max_len(MAX_PUBLIC_INPUTS + 1)]
    pub gamma_abc: Vec<[u8; 64]>,
    pub mock: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeVerifierKeyArgs {
    pub key_id: u32,
    pub alpha_g1: Vec<u8>,
    pub beta_g2: Vec<u8>,
    pub gamma_g2: Vec<u8>,
    pub delta_g2: Vec<u8>,
    pub public_inputs_len: u32,
    pub gamma_abc: Vec<Vec<u8>>,
    pub mock: bool,
}

fn parse_proof(proof: &[u8]) -> Result<([u8; 64], [u8; 128], [u8; 64])> {
    require!(proof.len() == 256, VerifierError::InvalidProof);
    let a = to_fixed_64(&proof[0..64])?;
    let b = to_fixed_128(&proof[64..192])?;
    let c = to_fixed_64(&proof[192..256])?;
    Ok((a, b, c))
}

fn compute_vk_x(gamma_abc: &[[u8; 64]], public_inputs: &[u8]) -> Result<[u8; 64]> {
    require!(!gamma_abc.is_empty(), VerifierError::InvalidVerifierKey);
    let mut acc = gamma_abc[0];
    let input_chunks = public_inputs.chunks(32).enumerate();
    for (i, chunk) in input_chunks {
        let scalar = to_fixed_32(chunk)?;
        let term = g1_mul(&gamma_abc[i + 1], &scalar)?;
        acc = g1_add(&acc, &term)?;
    }
    Ok(acc)
}

fn g1_add(a: &[u8; 64], b: &[u8; 64]) -> Result<[u8; 64]> {
    let mut input = [0u8; 128];
    input[..64].copy_from_slice(a);
    input[64..].copy_from_slice(b);
    let out = alt_bn128_g1_addition_be(&input).map_err(|_| VerifierError::AdditionFailed)?;
    require!(out.len() == ALT_BN128_G1_POINT_SIZE, VerifierError::AdditionFailed);
    Ok(to_fixed_64(&out)?)
}

fn g1_mul(point: &[u8; 64], scalar: &[u8; 32]) -> Result<[u8; 64]> {
    let mut input = [0u8; ALT_BN128_G1_MULTIPLICATION_INPUT_SIZE];
    input[..64].copy_from_slice(point);
    input[64..96].copy_from_slice(scalar);
    let out = alt_bn128_g1_multiplication_be(&input).map_err(|_| VerifierError::MultiplicationFailed)?;
    require!(out.len() == ALT_BN128_G1_POINT_SIZE, VerifierError::MultiplicationFailed);
    Ok(to_fixed_64(&out)?)
}

fn negate_g1(point: &[u8; 64]) -> [u8; 64] {
    let mut out = *point;
    let mut y = [0u8; 32];
    y.copy_from_slice(&point[32..64]);
    if y.iter().all(|b| *b == 0) {
        return out;
    }
    let p = field_modulus();
    let neg_y = sub_mod_be(&p, &y);
    out[32..64].copy_from_slice(&neg_y);
    out
}

fn pairing_is_one(output: &[u8]) -> bool {
    if output.len() != ALT_BN128_PAIRING_OUTPUT_SIZE {
        return false;
    }
    output.iter().take(31).all(|b| *b == 0) && output[31] == 1
}

fn to_fixed_32(bytes: &[u8]) -> Result<[u8; 32]> {
    require!(bytes.len() == 32, VerifierError::InvalidLength);
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn to_fixed_64(bytes: &[u8]) -> Result<[u8; 64]> {
    require!(bytes.len() == 64, VerifierError::InvalidLength);
    let mut out = [0u8; 64];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn to_fixed_128(bytes: &[u8]) -> Result<[u8; 128]> {
    require!(bytes.len() == 128, VerifierError::InvalidLength);
    let mut out = [0u8; 128];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn field_modulus() -> [u8; 32] {
    [
        48, 100, 78, 114, 225, 49, 160, 41, 184, 80, 69, 182, 129, 129, 88, 93, 151, 129,
        106, 145, 104, 113, 202, 141, 60, 32, 140, 22, 216, 124, 253, 71,
    ]
}

fn sub_mod_be(modulus: &[u8; 32], value: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let a = modulus[i] as i16;
        let b = value[i] as i16 + borrow as i16;
        if a >= b {
            out[i] = (a - b) as u8;
            borrow = 0;
        } else {
            out[i] = (a + 256 - b) as u8;
            borrow = 1;
        }
    }
    out
}

#[error_code]
pub enum VerifierError {
    #[msg("Invalid proof")]
    InvalidProof,
    #[msg("Invalid length")]
    InvalidLength,
    #[msg("Invalid verifier key")]
    InvalidVerifierKey,
    #[msg("Invalid public input count")]
    InvalidInputCount,
    #[msg("Too many public inputs")]
    TooManyInputs,
    #[msg("Pairing check failed")]
    PairingFailed,
    #[msg("G1 addition failed")]
    AdditionFailed,
    #[msg("G1 multiplication failed")]
    MultiplicationFailed,
}
