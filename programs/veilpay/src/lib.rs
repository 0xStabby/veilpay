use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use verifier::cpi::accounts::VerifyGroth16 as VerifyGroth16Cpi;

declare_id!("4C6H1aqxks1AgjtsLPbNrDXFsb6DwQ6c1Jhw2ZugTLv2");

const MAX_ALLOWLIST: usize = 32;
const MAX_CIRCUITS: usize = 8;
const MAX_INPUTS: usize = 4;
const MAX_OUTPUTS: usize = 2;
const PUBLIC_INPUTS_LEN: usize = 13;
const MAX_ROOT_HISTORY: usize = 32;
const MAX_VK_ENTRIES: usize = 16;
const NULLIFIER_BITS: usize = 8192;
const NULLIFIER_BYTES: usize = NULLIFIER_BITS / 8;
const ZERO_ROOT: [u8; 32] = [
    0x21, 0x34, 0xE7, 0x6A, 0xC5, 0xD2, 0x1A, 0xAB,
    0x18, 0x6C, 0x2B, 0xE1, 0xDD, 0x8F, 0x84, 0xEE,
    0x88, 0x0A, 0x1E, 0x46, 0xEA, 0xF7, 0x12, 0xF9,
    0xD3, 0x71, 0xB6, 0xDF, 0x22, 0x19, 0x1F, 0x3E,
];

#[program]
pub mod veilpay {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        require!(
            args.mint_allowlist.len() <= MAX_ALLOWLIST,
            VeilpayError::AllowlistTooLarge
        );
        require!(
            args.circuit_ids.len() <= MAX_CIRCUITS,
            VeilpayError::CircuitListTooLarge
        );

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.fee_bps = args.fee_bps;
        config.relayer_fee_bps_max = args.relayer_fee_bps_max;
        config.vk_registry = args.vk_registry;
        config.mint_allowlist = args.mint_allowlist;
        config.circuit_ids = args.circuit_ids;
        config.paused = false;
        config.version = 1;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn register_mint(ctx: Context<RegisterMint>, mint: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.admin == ctx.accounts.admin.key(), VeilpayError::Unauthorized);
        require!(
            config.mint_allowlist.len() < MAX_ALLOWLIST,
            VeilpayError::AllowlistTooLarge
        );
        if !config.mint_allowlist.contains(&mint) {
            config.mint_allowlist.push(mint);
        }
        Ok(())
    }

    pub fn initialize_vk_registry(ctx: Context<InitializeVkRegistry>) -> Result<()> {
        let registry = &mut ctx.accounts.vk_registry;
        registry.entries = Vec::new();
        registry.bump = ctx.bumps.vk_registry;
        Ok(())
    }

    pub fn initialize_identity_registry(ctx: Context<InitializeIdentityRegistry>) -> Result<()> {
        let registry = &mut ctx.accounts.identity_registry;
        registry.merkle_root = ZERO_ROOT;
        registry.commitment_count = 0;
        registry.bump = ctx.bumps.identity_registry;
        Ok(())
    }

    pub fn register_identity(ctx: Context<RegisterIdentity>, args: RegisterIdentityArgs) -> Result<()> {
        let _commitment = to_fixed_32(&args.commitment)?;
        let new_root = to_fixed_32(&args.new_root)?;
        let registry = &mut ctx.accounts.identity_registry;
        registry.commitment_count = registry.commitment_count.saturating_add(1);
        registry.merkle_root = new_root;
        Ok(())
    }

    pub fn initialize_mint_state(ctx: Context<InitializeMintState>, chunk_index: u32) -> Result<()> {
        require!(
            ctx.accounts.config.admin == ctx.accounts.admin.key(),
            VeilpayError::Unauthorized
        );
        require!(
            ctx.accounts.config.mint_allowlist.contains(&ctx.accounts.mint.key()),
            VeilpayError::MintNotAllowed
        );
        let vault_key = ctx.accounts.vault.key();
        let vault_ata_key = ctx.accounts.vault_ata.key();
        let mint_key = ctx.accounts.mint.key();

        let vault = &mut ctx.accounts.vault;
        vault.vault_pda = vault_key;
        vault.vault_ata = vault_ata_key;
        vault.mint = mint_key;
        vault.total_deposited = 0;
        vault.total_withdrawn = 0;
        vault.nonce = 0;
        vault.bump = ctx.bumps.vault;

        let shielded = &mut ctx.accounts.shielded_state;
        shielded.mint = mint_key;
        shielded.merkle_root = ZERO_ROOT;
        shielded.root_history = Vec::new();
        shielded.root_history_index = 0;
        shielded.commitment_count = 0;
        shielded.circuit_id = 0;
        shielded.version = 1;
        shielded.bump = ctx.bumps.shielded_state;

        let nullifier = &mut ctx.accounts.nullifier_set;
        nullifier.mint = mint_key;
        nullifier.chunk_index = chunk_index;
        nullifier.bitset = [0u8; NULLIFIER_BYTES];
        nullifier.count = 0;
        nullifier.bump = ctx.bumps.nullifier_set;

        Ok(())
    }

    pub fn initialize_nullifier_chunk(
        ctx: Context<InitializeNullifierChunk>,
        chunk_index: u32,
    ) -> Result<()> {
        require!(
            ctx.accounts.config.mint_allowlist.contains(&ctx.accounts.mint.key()),
            VeilpayError::MintNotAllowed
        );
        let nullifier = &mut ctx.accounts.nullifier_set;
        nullifier.mint = ctx.accounts.mint.key();
        nullifier.chunk_index = chunk_index;
        nullifier.bitset = [0u8; NULLIFIER_BYTES];
        nullifier.count = 0;
        nullifier.bump = ctx.bumps.nullifier_set;
        Ok(())
    }

    pub fn configure_fees(ctx: Context<ConfigureFees>, fee_bps: u16, relayer_fee_bps_max: u16) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.admin == ctx.accounts.admin.key(), VeilpayError::Unauthorized);
        config.fee_bps = fee_bps;
        config.relayer_fee_bps_max = relayer_fee_bps_max;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, args: DepositArgs) -> Result<()> {
        require!(!ctx.accounts.config.paused, VeilpayError::ProtocolPaused);
        require!(
            ctx.accounts.config.mint_allowlist.contains(&ctx.accounts.mint.key()),
            VeilpayError::MintNotAllowed
        );
        require!(
            ctx.accounts.vault_ata.owner == ctx.accounts.vault.key(),
            VeilpayError::InvalidVaultAuthority
        );
        let new_root = to_fixed_32(&args.new_root)?;
        let _commitment = to_fixed_32(&args.commitment)?;
        let _ciphertext = to_fixed_128(&args.ciphertext)?;

        let cpi_accounts = anchor_spl::token::Transfer {
            from: ctx.accounts.user_ata.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        anchor_spl::token::transfer(cpi_ctx, args.amount)?;

        let vault = &mut ctx.accounts.vault;
        vault.total_deposited = vault
            .total_deposited
            .checked_add(args.amount)
            .ok_or(VeilpayError::MathOverflow)?;
        vault.nonce = vault.nonce.saturating_add(1);

        let shielded = &mut ctx.accounts.shielded_state;
        shielded.commitment_count = shielded.commitment_count.saturating_add(1);
        append_root(shielded, new_root);
        Ok(())
    }

    pub fn withdraw<'info>(
        ctx: Context<'_, '_, 'info, 'info, Withdraw<'info>>,
        args: WithdrawArgs,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, VeilpayError::ProtocolPaused);
        require!(
            args.relayer_fee_bps <= ctx.accounts.config.relayer_fee_bps_max,
            VeilpayError::RelayerFeeTooHigh
        );
        require!(
            ctx.accounts.config.mint_allowlist.contains(&ctx.accounts.mint.key()),
            VeilpayError::MintNotAllowed
        );
        require!(
            ctx.accounts.vault_ata.owner == ctx.accounts.vault.key(),
            VeilpayError::InvalidVaultAuthority
        );
        verify_groth16(
            &ctx.accounts.verifier_program,
            &ctx.accounts.verifier_key,
            args.proof.clone(),
            args.public_inputs.clone(),
        )?;
        let parsed = parse_public_inputs(&args.public_inputs)?;
        require!(
            parsed.amount_out == args.amount,
            VeilpayError::AmountMismatch
        );
        require!(
            parsed.output_enabled[0] == 0,
            VeilpayError::InvalidOutputFlags
        );
        require!(
            ctx.accounts.config.circuit_ids.contains(&parsed.circuit_id),
            VeilpayError::CircuitNotAllowed
        );
        require!(
            parsed.identity_root == ctx.accounts.identity_registry.merkle_root,
            VeilpayError::IdentityRootMismatch
        );
        require!(
            root_known(&ctx.accounts.shielded_state, parsed.root),
            VeilpayError::UnknownRoot
        );
        let (net_amount, fee_amount) = split_relayer_fee(args.amount, args.relayer_fee_bps)?;
        require!(fee_amount == parsed.fee_amount, VeilpayError::FeeMismatch);
        mark_nullifiers(
            &mut ctx.accounts.nullifier_set,
            ctx.remaining_accounts,
            &parsed.nullifiers,
        )?;

        let bump_seed = [ctx.accounts.vault.bump];
        let mint_key = ctx.accounts.mint.key();
        let vault_seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &bump_seed];
        let signer_seeds: &[&[&[u8]]] = &[vault_seeds];

        if fee_amount > 0 {
            let relayer_fee_ata = ctx
                .accounts
                .relayer_fee_ata
                .as_ref()
                .ok_or(VeilpayError::MissingRelayerFeeAccount)?;
            require!(
                relayer_fee_ata.mint == ctx.accounts.mint.key(),
                VeilpayError::InvalidRelayerFeeAccount
            );
            let cpi_accounts = anchor_spl::token::Transfer {
                from: ctx.accounts.vault_ata.to_account_info(),
                to: relayer_fee_ata.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            anchor_spl::token::transfer(cpi_ctx, fee_amount)?;
        }

        let cpi_accounts = anchor_spl::token::Transfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.recipient_ata.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        anchor_spl::token::transfer(cpi_ctx, net_amount)?;

        let vault = &mut ctx.accounts.vault;
        vault.total_withdrawn = vault
            .total_withdrawn
            .checked_add(args.amount)
            .ok_or(VeilpayError::MathOverflow)?;
        vault.nonce = vault.nonce.saturating_add(1);

        if parsed.output_enabled[1] == 1 {
            let new_root = to_fixed_32(&args.new_root)?;
            let shielded = &mut ctx.accounts.shielded_state;
            shielded.commitment_count = shielded.commitment_count.saturating_add(1);
            append_root(shielded, new_root);
        }
        Ok(())
    }

    pub fn internal_transfer<'info>(
        ctx: Context<'_, '_, 'info, 'info, InternalTransfer<'info>>,
        args: InternalTransferArgs,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, VeilpayError::ProtocolPaused);
        require!(
            ctx.accounts.config.mint_allowlist.contains(&ctx.accounts.mint.key()),
            VeilpayError::MintNotAllowed
        );
        verify_groth16(
            &ctx.accounts.verifier_program,
            &ctx.accounts.verifier_key,
            args.proof.clone(),
            args.public_inputs.clone(),
        )?;
        let parsed = parse_public_inputs(&args.public_inputs)?;
        require!(parsed.amount_out == 0, VeilpayError::InvalidOutputFlags);
        require!(parsed.fee_amount == 0, VeilpayError::InvalidOutputFlags);
        require!(
            parsed.output_enabled[0] == 1,
            VeilpayError::InvalidOutputFlags
        );
        require!(
            ctx.accounts.config.circuit_ids.contains(&parsed.circuit_id),
            VeilpayError::CircuitNotAllowed
        );
        require!(
            parsed.identity_root == ctx.accounts.identity_registry.merkle_root,
            VeilpayError::IdentityRootMismatch
        );
        require!(
            root_known(&ctx.accounts.shielded_state, parsed.root),
            VeilpayError::UnknownRoot
        );
        mark_nullifiers(
            &mut ctx.accounts.nullifier_set,
            ctx.remaining_accounts,
            &parsed.nullifiers,
        )?;
        let shielded = &mut ctx.accounts.shielded_state;
        let new_root = to_fixed_32(&args.new_root)?;
        let output_count = (parsed.output_enabled[0] + parsed.output_enabled[1]) as u64;
        require!(output_count > 0, VeilpayError::InvalidOutputFlags);
        shielded.commitment_count = shielded.commitment_count.saturating_add(output_count);
        append_root(shielded, new_root);
        Ok(())
    }

    pub fn external_transfer<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExternalTransfer<'info>>,
        args: ExternalTransferArgs,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, VeilpayError::ProtocolPaused);
        require!(
            args.relayer_fee_bps <= ctx.accounts.config.relayer_fee_bps_max,
            VeilpayError::RelayerFeeTooHigh
        );
        require!(
            ctx.accounts.config.mint_allowlist.contains(&ctx.accounts.mint.key()),
            VeilpayError::MintNotAllowed
        );
        require!(
            ctx.accounts.vault_ata.owner == ctx.accounts.vault.key(),
            VeilpayError::InvalidVaultAuthority
        );
        verify_groth16(
            &ctx.accounts.verifier_program,
            &ctx.accounts.verifier_key,
            args.proof.clone(),
            args.public_inputs.clone(),
        )?;
        let parsed = parse_public_inputs(&args.public_inputs)?;
        require!(
            parsed.amount_out == args.amount,
            VeilpayError::AmountMismatch
        );
        require!(
            parsed.output_enabled[0] == 0,
            VeilpayError::InvalidOutputFlags
        );
        require!(
            ctx.accounts.config.circuit_ids.contains(&parsed.circuit_id),
            VeilpayError::CircuitNotAllowed
        );
        require!(
            parsed.identity_root == ctx.accounts.identity_registry.merkle_root,
            VeilpayError::IdentityRootMismatch
        );
        require!(
            root_known(&ctx.accounts.shielded_state, parsed.root),
            VeilpayError::UnknownRoot
        );
        let (net_amount, fee_amount) = split_relayer_fee(args.amount, args.relayer_fee_bps)?;
        require!(fee_amount == parsed.fee_amount, VeilpayError::FeeMismatch);
        mark_nullifiers(
            &mut ctx.accounts.nullifier_set,
            ctx.remaining_accounts,
            &parsed.nullifiers,
        )?;

        let bump_seed = [ctx.accounts.vault.bump];
        let mint_key = ctx.accounts.mint.key();
        let vault_seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &bump_seed];
        let signer_seeds: &[&[&[u8]]] = &[vault_seeds];

        if fee_amount > 0 {
            let relayer_fee_ata = ctx
                .accounts
                .relayer_fee_ata
                .as_ref()
                .ok_or(VeilpayError::MissingRelayerFeeAccount)?;
            require!(
                relayer_fee_ata.mint == ctx.accounts.mint.key(),
                VeilpayError::InvalidRelayerFeeAccount
            );
            let cpi_accounts = anchor_spl::token::Transfer {
                from: ctx.accounts.vault_ata.to_account_info(),
                to: relayer_fee_ata.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            anchor_spl::token::transfer(cpi_ctx, fee_amount)?;
        }

        let cpi_accounts = anchor_spl::token::Transfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.destination_ata.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        anchor_spl::token::transfer(cpi_ctx, net_amount)?;

        let vault = &mut ctx.accounts.vault;
        vault.total_withdrawn = vault
            .total_withdrawn
            .checked_add(args.amount)
            .ok_or(VeilpayError::MathOverflow)?;
        vault.nonce = vault.nonce.saturating_add(1);

        if parsed.output_enabled[1] == 1 {
            let new_root = to_fixed_32(&args.new_root)?;
            let shielded = &mut ctx.accounts.shielded_state;
            shielded.commitment_count = shielded.commitment_count.saturating_add(1);
            append_root(shielded, new_root);
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config", crate::ID.as_ref()],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterMint<'info> {
    #[account(mut, seeds = [b"config", crate::ID.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeVkRegistry<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + VkRegistry::INIT_SPACE,
        seeds = [b"vk_registry"],
        bump
    )]
    pub vk_registry: Account<'info, VkRegistry>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeIdentityRegistry<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + IdentityRegistry::INIT_SPACE,
        seeds = [b"identity_registry"],
        bump
    )]
    pub identity_registry: Account<'info, IdentityRegistry>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterIdentity<'info> {
    #[account(mut, seeds = [b"identity_registry"], bump = identity_registry.bump)]
    pub identity_registry: Account<'info, IdentityRegistry>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(chunk_index: u32)]
pub struct InitializeMintState<'info> {
    #[account(seeds = [b"config", crate::ID.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + VaultPool::INIT_SPACE,
        seeds = [b"vault", mint.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, VaultPool>>,
    #[account(mut)]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        space = 8 + ShieldedState::INIT_SPACE,
        seeds = [b"shielded", mint.key().as_ref()],
        bump
    )]
    pub shielded_state: Box<Account<'info, ShieldedState>>,
    #[account(
        init,
        payer = admin,
        space = 8 + NullifierSet::INIT_SPACE,
        seeds = [b"nullifier_set", mint.key().as_ref(), chunk_index.to_le_bytes().as_ref()],
        bump
    )]
    pub nullifier_set: Box<Account<'info, NullifierSet>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(chunk_index: u32)]
pub struct InitializeNullifierChunk<'info> {
    #[account(seeds = [b"config", crate::ID.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + NullifierSet::INIT_SPACE,
        seeds = [b"nullifier_set", mint.key().as_ref(), chunk_index.to_le_bytes().as_ref()],
        bump
    )]
    pub nullifier_set: Box<Account<'info, NullifierSet>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ConfigureFees<'info> {
    #[account(mut, seeds = [b"config", crate::ID.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(seeds = [b"config", crate::ID.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, VaultPool>,
    #[account(mut)]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"shielded", mint.key().as_ref()], bump = shielded_state.bump)]
    pub shielded_state: Box<Account<'info, ShieldedState>>,
    pub user: Signer<'info>,
    #[account(mut)]
    pub user_ata: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [b"config", crate::ID.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, VaultPool>,
    #[account(mut)]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [b"shielded", mint.key().as_ref()], bump = shielded_state.bump)]
    pub shielded_state: Box<Account<'info, ShieldedState>>,
    #[account(seeds = [b"identity_registry"], bump = identity_registry.bump)]
    pub identity_registry: Box<Account<'info, IdentityRegistry>>,
    #[account(mut)]
    pub nullifier_set: Box<Account<'info, NullifierSet>>,
    #[account(mut)]
    pub recipient_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub relayer_fee_ata: Option<Box<Account<'info, TokenAccount>>>,
    pub verifier_program: Program<'info, verifier::program::Verifier>,
    pub verifier_key: Account<'info, verifier::VerifierKey>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InternalTransfer<'info> {
    #[account(seeds = [b"config", crate::ID.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"shielded", mint.key().as_ref()], bump = shielded_state.bump)]
    pub shielded_state: Box<Account<'info, ShieldedState>>,
    #[account(seeds = [b"identity_registry"], bump = identity_registry.bump)]
    pub identity_registry: Box<Account<'info, IdentityRegistry>>,
    #[account(mut)]
    pub nullifier_set: Box<Account<'info, NullifierSet>>,
    pub verifier_program: Program<'info, verifier::program::Verifier>,
    pub verifier_key: Account<'info, verifier::VerifierKey>,
    pub mint: Account<'info, Mint>,
}

#[derive(Accounts)]
pub struct ExternalTransfer<'info> {
    #[account(seeds = [b"config", crate::ID.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, VaultPool>,
    #[account(mut)]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [b"shielded", mint.key().as_ref()], bump = shielded_state.bump)]
    pub shielded_state: Box<Account<'info, ShieldedState>>,
    #[account(seeds = [b"identity_registry"], bump = identity_registry.bump)]
    pub identity_registry: Box<Account<'info, IdentityRegistry>>,
    #[account(mut)]
    pub nullifier_set: Box<Account<'info, NullifierSet>>,
    #[account(mut)]
    pub destination_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub relayer_fee_ata: Option<Box<Account<'info, TokenAccount>>>,
    pub verifier_program: Program<'info, verifier::program::Verifier>,
    pub verifier_key: Account<'info, verifier::VerifierKey>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeConfigArgs {
    pub fee_bps: u16,
    pub relayer_fee_bps_max: u16,
    pub vk_registry: Pubkey,
    pub mint_allowlist: Vec<Pubkey>,
    pub circuit_ids: Vec<u32>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DepositArgs {
    pub amount: u64,
    pub ciphertext: Vec<u8>,
    pub commitment: Vec<u8>,
    pub new_root: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawArgs {
    pub amount: u64,
    pub proof: Vec<u8>,
    pub public_inputs: Vec<u8>,
    pub relayer_fee_bps: u16,
    pub new_root: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InternalTransferArgs {
    pub proof: Vec<u8>,
    pub public_inputs: Vec<u8>,
    pub new_root: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExternalTransferArgs {
    pub amount: u64,
    pub proof: Vec<u8>,
    pub public_inputs: Vec<u8>,
    pub relayer_fee_bps: u16,
    pub new_root: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterIdentityArgs {
    pub commitment: Vec<u8>,
    pub new_root: Vec<u8>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub fee_bps: u16,
    pub relayer_fee_bps_max: u16,
    pub vk_registry: Pubkey,
    #[max_len(MAX_ALLOWLIST)]
    pub mint_allowlist: Vec<Pubkey>,
    #[max_len(MAX_CIRCUITS)]
    pub circuit_ids: Vec<u32>,
    pub paused: bool,
    pub version: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VaultPool {
    pub vault_pda: Pubkey,
    pub vault_ata: Pubkey,
    pub mint: Pubkey,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
    pub nonce: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ShieldedState {
    pub mint: Pubkey,
    pub merkle_root: [u8; 32],
    #[max_len(MAX_ROOT_HISTORY)]
    pub root_history: Vec<[u8; 32]>,
    pub root_history_index: u32,
    pub commitment_count: u64,
    pub circuit_id: u32,
    pub version: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct IdentityRegistry {
    pub merkle_root: [u8; 32],
    pub commitment_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct NullifierSet {
    pub mint: Pubkey,
    pub chunk_index: u32,
    pub bitset: [u8; NULLIFIER_BYTES],
    pub count: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VkRegistry {
    #[max_len(MAX_VK_ENTRIES)]
    pub entries: Vec<VkEntry>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct VkEntry {
    pub circuit_id: u32,
    pub vk_account: Pubkey,
    pub vk_hash: [u8; 32],
    pub status: u8,
}

fn append_root(state: &mut ShieldedState, new_root: [u8; 32]) {
    if state.root_history.len() < MAX_ROOT_HISTORY {
        state.root_history.push(new_root);
    } else {
        let idx = (state.root_history_index as usize) % MAX_ROOT_HISTORY;
        state.root_history[idx] = new_root;
        state.root_history_index = state.root_history_index.wrapping_add(1);
    }
    state.merkle_root = new_root;
}

fn to_fixed_32(bytes: &[u8]) -> Result<[u8; 32]> {
    require!(bytes.len() == 32, VeilpayError::InvalidByteLength);
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn to_fixed_128(bytes: &[u8]) -> Result<[u8; 128]> {
    require!(bytes.len() == 128, VeilpayError::InvalidByteLength);
    let mut out = [0u8; 128];
    out.copy_from_slice(bytes);
    Ok(out)
}

#[derive(Clone)]
struct ParsedPublicInputs {
    root: [u8; 32],
    identity_root: [u8; 32],
    nullifiers: [[u8; 32]; MAX_INPUTS],
    output_commitments: [[u8; 32]; MAX_OUTPUTS],
    output_enabled: [u8; MAX_OUTPUTS],
    amount_out: u64,
    fee_amount: u64,
    circuit_id: u32,
}

fn parse_public_inputs(bytes: &[u8]) -> Result<ParsedPublicInputs> {
    require!(
        bytes.len() == PUBLIC_INPUTS_LEN * 32,
        VeilpayError::InvalidPublicInputs
    );
    let chunks: Vec<[u8; 32]> = bytes
        .chunks(32)
        .map(|chunk| {
            let mut out = [0u8; 32];
            out.copy_from_slice(chunk);
            out
        })
        .collect();
    let root = chunks[0];
    let identity_root = chunks[1];
    let mut nullifiers = [[0u8; 32]; MAX_INPUTS];
    for i in 0..MAX_INPUTS {
        nullifiers[i] = chunks[2 + i];
    }
    let mut output_commitments = [[0u8; 32]; MAX_OUTPUTS];
    for i in 0..MAX_OUTPUTS {
        output_commitments[i] = chunks[2 + MAX_INPUTS + i];
    }
    let mut output_enabled = [0u8; MAX_OUTPUTS];
    for i in 0..MAX_OUTPUTS {
        output_enabled[i] = parse_u8(&chunks[2 + MAX_INPUTS + MAX_OUTPUTS + i])?;
    }
    let amount_out = parse_u64(&chunks[2 + MAX_INPUTS + MAX_OUTPUTS + MAX_OUTPUTS])?;
    let fee_amount = parse_u64(&chunks[2 + MAX_INPUTS + MAX_OUTPUTS + MAX_OUTPUTS + 1])?;
    let circuit_id = parse_u32(&chunks[2 + MAX_INPUTS + MAX_OUTPUTS + MAX_OUTPUTS + 2])?;
    Ok(ParsedPublicInputs {
        root,
        identity_root,
        nullifiers,
        output_commitments,
        output_enabled,
        amount_out,
        fee_amount,
        circuit_id,
    })
}

fn parse_u64(bytes: &[u8; 32]) -> Result<u64> {
    if bytes[..24].iter().any(|b| *b != 0) {
        return Err(error!(VeilpayError::InvalidPublicInputs));
    }
    Ok(u64::from_be_bytes(bytes[24..].try_into().unwrap()))
}

fn parse_u32(bytes: &[u8; 32]) -> Result<u32> {
    if bytes[..28].iter().any(|b| *b != 0) {
        return Err(error!(VeilpayError::InvalidPublicInputs));
    }
    Ok(u32::from_be_bytes(bytes[28..].try_into().unwrap()))
}

fn parse_u8(bytes: &[u8; 32]) -> Result<u8> {
    let value = parse_u64(bytes)?;
    require!(value <= 1, VeilpayError::InvalidPublicInputs);
    Ok(value as u8)
}

fn mark_nullifiers<'info>(
    primary: &mut Account<'info, NullifierSet>,
    remaining: &'info [AccountInfo<'info>],
    nullifiers: &[[u8; 32]; MAX_INPUTS],
) -> Result<()> {
    for nullifier in nullifiers {
        if is_zero_32(nullifier) {
            continue;
        }
        let (chunk_index, _) = nullifier_position(nullifier);
        if primary.chunk_index == chunk_index {
            mark_nullifier(primary, *nullifier)?;
            continue;
        }
        let mut matched: Option<Account<NullifierSet>> = None;
        for info in remaining {
            if !info.is_writable {
                continue;
            }
            let set = Account::<NullifierSet>::try_from(info)?;
            if set.chunk_index == chunk_index {
                matched = Some(set);
                break;
            }
        }
        let mut set = matched.ok_or(VeilpayError::MissingNullifierAccount)?;
        mark_nullifier(&mut set, *nullifier)?;
    }
    Ok(())
}

fn is_zero_32(value: &[u8; 32]) -> bool {
    value.iter().all(|b| *b == 0)
}

fn root_known(state: &ShieldedState, root: [u8; 32]) -> bool {
    if state.merkle_root == root {
        return true;
    }
    state.root_history.iter().any(|r| *r == root)
}

fn verify_groth16<'info>(
    verifier_program: &Program<'info, verifier::program::Verifier>,
    verifier_key: &Account<'info, verifier::VerifierKey>,
    proof: Vec<u8>,
    public_inputs: Vec<u8>,
) -> Result<()> {
    let cpi_accounts = VerifyGroth16Cpi {
        verifier_key: verifier_key.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(verifier_program.to_account_info(), cpi_accounts);
    verifier::cpi::verify_groth16(cpi_ctx, proof, public_inputs)
        .map_err(|_| error!(VeilpayError::InvalidProof))?;
    Ok(())
}

fn mark_nullifier(set: &mut NullifierSet, nullifier: [u8; 32]) -> Result<()> {
    let (chunk_index, bit_index) = nullifier_position(&nullifier);
    require!(
        chunk_index == set.chunk_index,
        VeilpayError::NullifierChunkMismatch
    );
    let byte_index = (bit_index / 8) as usize;
    let bit_mask = 1u8 << (bit_index % 8);
    require!(
        (set.bitset[byte_index] & bit_mask) == 0,
        VeilpayError::NullifierAlreadyUsed
    );
    set.bitset[byte_index] |= bit_mask;
    set.count = set.count.saturating_add(1);
    Ok(())
}

fn nullifier_position(nullifier: &[u8; 32]) -> (u32, u16) {
    let chunk_index = u32::from_le_bytes([nullifier[0], nullifier[1], nullifier[2], nullifier[3]]);
    let bit_index = u16::from_le_bytes([nullifier[4], nullifier[5]]) % (NULLIFIER_BITS as u16);
    (chunk_index, bit_index)
}

fn split_relayer_fee(amount: u64, fee_bps: u16) -> Result<(u64, u64)> {
    if fee_bps == 0 {
        return Ok((amount, 0));
    }
    let fee = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(VeilpayError::MathOverflow)?
        / 10_000u128;
    let fee_u64 = u64::try_from(fee).map_err(|_| VeilpayError::MathOverflow)?;
    require!(fee_u64 < amount, VeilpayError::RelayerFeeExceedsAmount);
    let net = amount.checked_sub(fee_u64).ok_or(VeilpayError::MathOverflow)?;
    Ok((net, fee_u64))
}

#[error_code]
pub enum VeilpayError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Allowlist exceeds max length")]
    AllowlistTooLarge,
    #[msg("Circuit list exceeds max length")]
    CircuitListTooLarge,
    #[msg("Protocol is paused")]
    ProtocolPaused,
    #[msg("Relayer fee too high")]
    RelayerFeeTooHigh,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Nullifier already used")]
    NullifierAlreadyUsed,
    #[msg("Nullifier chunk mismatch")]
    NullifierChunkMismatch,
    #[msg("Mint not allowed")]
    MintNotAllowed,
    #[msg("Invalid vault authority")]
    InvalidVaultAuthority,
    #[msg("Unknown root")]
    UnknownRoot,
    #[msg("Identity root mismatch")]
    IdentityRootMismatch,
    #[msg("Invalid byte length")]
    InvalidByteLength,
    #[msg("Invalid proof")]
    InvalidProof,
    #[msg("Missing relayer fee account")]
    MissingRelayerFeeAccount,
    #[msg("Invalid relayer fee account")]
    InvalidRelayerFeeAccount,
    #[msg("Relayer fee exceeds amount")]
    RelayerFeeExceedsAmount,
    #[msg("Invalid public inputs")]
    InvalidPublicInputs,
    #[msg("Circuit not allowed")]
    CircuitNotAllowed,
    #[msg("Amount mismatch")]
    AmountMismatch,
    #[msg("Fee mismatch")]
    FeeMismatch,
    #[msg("Invalid output flags")]
    InvalidOutputFlags,
    #[msg("Missing nullifier account")]
    MissingNullifierAccount,
}
