use super::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions;

const HOLD_SEED: &[u8] = b"capital-hold";
const RECEIPT_SEED: &[u8] = b"buyback-receipt";

// This account is initialized in the same transaction as the full quote spend
// and final custody/burn. Its proposal-scoped address is the replay guard.
// For a time-lock, the receipt PDA itself owns the proposal-specific ATA.
#[account]
pub struct BuybackExecutionReceipt {
    pub schema_version: u8,
    pub proposal: Pubkey,
    pub config: Pubkey,
    pub capital_mint: Pubkey,
    pub reserve_vault: Pubkey,
    pub trader: Pubkey,
    pub venue_program: Pubkey,
    pub venue_account: Pubkey,
    /// Hold ATA, proposal lock ATA, or default pubkey for a burn.
    pub destination: Pubkey,
    pub action: ReserveAction,
    pub quote_spent_raw: u64,
    pub voted_min_output_raw: u64,
    pub base_acquired_raw: u64,
    pub base_supply_before: u64,
    pub base_supply_after: u64,
    pub executed_at: i64,
    pub lock_release_at: i64,
    pub lock_released_at: i64,
    pub lock_duration_seconds: u32,
    pub bump: u8,
}

impl BuybackExecutionReceipt {
    // Borsh has no padding: discriminator + schema + 8 keys + action enum +
    // five u64 + three i64 + one u32 + bump.
    pub const SPACE: usize = 8 + 1 + 8 * 32 + 1 + 5 * 8 + 3 * 8 + 4 + 1;
}

#[derive(Accounts)]
pub struct ExecuteBuyback<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump,
        constraint = config.schema_version == SCHEMA_VERSION @ GovernanceError::SchemaMismatch)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"proposal", &proposal.id.to_le_bytes()], bump = proposal.bump,
        has_one = config, has_one = reserve_vault)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(address = MSTRX_MINT,
        constraint = *reserve_mint.to_account_info().owner == spl_token_2022::ID
            @ GovernanceError::InvalidReserveMint)]
    pub reserve_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = config.reserve_vault,
        associated_token::mint = reserve_mint,
        associated_token::authority = config,
        associated_token::token_program = quote_token_program)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.capital_mint,
        constraint = *capital_mint.to_account_info().owner == config.capital_token_program
            @ GovernanceError::InvalidCapitalMint)]
    pub capital_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: seed, System owner, empty data and non-executable state checked in execute.
    #[account(mut, seeds = [TRADER_SEED], bump)]
    pub trader: UncheckedAccount<'info>,
    /// CHECK: exact ATA address and Token Account state checked in execute.
    #[account(mut, address = venue_ata(&trader.key(), &MSTRX_MINT, &spl_token_2022::ID))]
    pub trader_quote_ata: UncheckedAccount<'info>,
    /// CHECK: exact ATA address and Token Account state checked in execute.
    #[account(mut, address = venue_ata(&trader.key(), &capital_mint.key(),
        &config.capital_token_program))]
    pub trader_base_ata: UncheckedAccount<'info>,
    /// CHECK: canonical authority PDA cannot sign except through this program.
    #[account(seeds = [HOLD_SEED], bump)]
    pub hold_authority: UncheckedAccount<'info>,
    /// CHECK: exact ATA address and Token Account state checked before use.
    #[account(mut, address = venue_ata(&hold_authority.key(), &capital_mint.key(),
        &config.capital_token_program))]
    pub hold_ata: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = BuybackExecutionReceipt::SPACE,
        seeds = [RECEIPT_SEED, proposal.key().as_ref()], bump)]
    pub receipt: Account<'info, BuybackExecutionReceipt>,
    /// CHECK: exact proposal-specific ATA address and state checked before use.
    #[account(mut, address = venue_ata(&receipt.key(), &capital_mint.key(),
        &config.capital_token_program))]
    pub lock_ata: UncheckedAccount<'info>,
    /// CHECK: canonical Pump curve PDA and owned state decoded by venue guard.
    pub curve: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = spl_token_2022::ID)]
    pub quote_token_program: Interface<'info, TokenInterface>,
    #[account(address = config.capital_token_program)]
    pub base_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseCapitalLock<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"proposal", &proposal.id.to_le_bytes()], bump = proposal.bump,
        has_one = config)]
    pub proposal: Account<'info, Proposal>,
    #[account(mut, seeds = [RECEIPT_SEED, proposal.key().as_ref()], bump = receipt.bump,
        has_one = proposal, has_one = config, has_one = capital_mint)]
    pub receipt: Account<'info, BuybackExecutionReceipt>,
    #[account(address = config.capital_mint,
        constraint = *capital_mint.to_account_info().owner == config.capital_token_program
            @ GovernanceError::InvalidCapitalMint)]
    pub capital_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: canonical Token Account and authority verified before transfer.
    #[account(mut, address = venue_ata(&receipt.key(), &capital_mint.key(),
        &config.capital_token_program))]
    pub lock_ata: UncheckedAccount<'info>,
    /// CHECK: canonical authority PDA checked by seeds.
    #[account(seeds = [HOLD_SEED], bump)]
    pub hold_authority: UncheckedAccount<'info>,
    /// CHECK: canonical ATA and Token Account verified after idempotent creation.
    #[account(mut, address = venue_ata(&hold_authority.key(), &capital_mint.key(),
        &config.capital_token_program))]
    pub hold_ata: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = config.capital_token_program)]
    pub base_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

fn token_balance(
    info: &AccountInfo,
    mint: &Pubkey,
    authority: &Pubkey,
    token_program: &Pubkey,
) -> Result<u64> {
    require_keys_eq!(
        *info.owner,
        *token_program,
        GovernanceError::BuybackBalanceMismatch
    );
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data)
        .map_err(|_| GovernanceError::BuybackBalanceMismatch)?;
    require!(
        state.base.mint == *mint
            && state.base.owner == *authority
            && state.base.state == spl_token_2022::state::AccountState::Initialized
            && state.base.delegate == COption::None
            && state.base.delegated_amount == 0
            && state.base.close_authority == COption::None
            && state.base.is_native == COption::None,
        GovernanceError::BuybackBalanceMismatch
    );
    Ok(state.base.amount)
}

fn create_ata<'info>(
    associated_program: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    ata: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
) -> Result<()> {
    associated_token::create_idempotent(CpiContext::new(
        associated_program,
        associated_token::Create {
            payer,
            associated_token: ata,
            authority,
            mint,
            system_program,
            token_program,
        },
    ))
}

fn validate_trader(info: &AccountInfo, expected: Pubkey) -> Result<()> {
    require!(
        *info.key == expected
            && *info.owner == System::id()
            && info.data_is_empty()
            && !info.executable,
        GovernanceError::InvalidTraderAccount
    );
    Ok(())
}

pub(crate) fn execute<'info>(
    mut ctx: Context<'_, '_, '_, 'info, ExecuteBuyback<'info>>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    validate_mstrx_mint(&ctx.accounts.reserve_mint)?;
    validate_capital_mint_policy(&ctx.accounts.capital_mint)?;
    require!(
        ctx.accounts.config.capital_mint != MSTRX_MINT
            && matches!(
                ctx.accounts.config.capital_token_program,
                anchor_spl::token::ID | spl_token_2022::ID
            ),
        GovernanceError::InvalidCapitalMint
    );
    let trader = ctx.accounts.trader.key();
    validate_trader(&ctx.accounts.trader.to_account_info(), trader)?;
    require!(
        ctx.accounts.trader.lamports() >= Rent::get()?.minimum_balance(0),
        GovernanceError::TraderBelowRentFloor
    );

    // No keeper-supplied program bytes or loose account vector is accepted.
    // The helper checks the phase, canonical curve/pool, every IDL account and
    // the voted full quote input and minimum output before any custody move.
    let (buy_instruction, terms) = pinned_buyback_instruction(
        &ctx.accounts.config,
        &ctx.accounts.config.key(),
        &ctx.accounts.proposal,
        ctx.accounts.reserve_vault.amount,
        now,
        &ctx.accounts.curve.to_account_info(),
        ctx.remaining_accounts,
    )?;
    let venue_account = if buy_instruction.program_id == PUMP_PROGRAM {
        ctx.accounts.curve.key()
    } else {
        *ctx.remaining_accounts[0].key
    };
    let trader_bump = [ctx.bumps.trader];
    let trader_seeds: &[&[&[u8]]] = &[&[TRADER_SEED, &trader_bump]];

    create_ata(
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.trader_quote_ata.to_account_info(),
        ctx.accounts.trader.to_account_info(),
        ctx.accounts.reserve_mint.to_account_info(),
        ctx.accounts.quote_token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
    )?;
    create_ata(
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.trader_base_ata.to_account_info(),
        ctx.accounts.trader.to_account_info(),
        ctx.accounts.capital_mint.to_account_info(),
        ctx.accounts.base_token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
    )?;
    let quote_before = token_balance(
        &ctx.accounts.trader_quote_ata.to_account_info(),
        &MSTRX_MINT,
        &trader,
        &spl_token_2022::ID,
    )?;
    let base_before = token_balance(
        &ctx.accounts.trader_base_ata.to_account_info(),
        &ctx.accounts.capital_mint.key(),
        &trader,
        &ctx.accounts.config.capital_token_program,
    )?;
    let reserve_before = ctx.accounts.reserve_vault.amount;
    let supply_before = ctx.accounts.capital_mint.supply;
    let expected_reserve_after = reserve_before
        .checked_sub(terms.committed_quote_raw)
        .ok_or(GovernanceError::BuybackBalanceMismatch)?;
    let expected_quote_funded = quote_before
        .checked_add(terms.committed_quote_raw)
        .ok_or(GovernanceError::Overflow)?;

    let config_bump = [ctx.accounts.config.bump];
    let config_seeds: &[&[&[u8]]] = &[&[b"config", &config_bump]];
    checked_token_transfer(
        &spl_token_2022::ID,
        ctx.accounts.reserve_vault.to_account_info(),
        ctx.accounts.reserve_mint.to_account_info(),
        ctx.accounts.trader_quote_ata.to_account_info(),
        ctx.accounts.config.to_account_info(),
        terms.committed_quote_raw,
        ctx.accounts.reserve_mint.decimals,
        config_seeds,
    )?;
    ctx.accounts.reserve_vault.reload()?;
    require!(
        ctx.accounts.reserve_vault.amount == expected_reserve_after
            && token_balance(
                &ctx.accounts.trader_quote_ata.to_account_info(),
                &MSTRX_MINT,
                &trader,
                &spl_token_2022::ID,
            )? == expected_quote_funded,
        GovernanceError::BuybackBalanceMismatch
    );

    invoke_signed(&buy_instruction, ctx.remaining_accounts, trader_seeds)?;
    require!(
        ctx.accounts.trader.lamports() >= Rent::get()?.minimum_balance(0),
        GovernanceError::TraderBelowRentFloor
    );
    let quote_after_buy = token_balance(
        &ctx.accounts.trader_quote_ata.to_account_info(),
        &MSTRX_MINT,
        &trader,
        &spl_token_2022::ID,
    )?;
    let base_after_buy = token_balance(
        &ctx.accounts.trader_base_ata.to_account_info(),
        &ctx.accounts.capital_mint.key(),
        &trader,
        &ctx.accounts.config.capital_token_program,
    )?;
    let acquired = base_after_buy
        .checked_sub(base_before)
        .ok_or(GovernanceError::BuybackBalanceMismatch)?;
    ctx.accounts.capital_mint.reload()?;
    require!(
        quote_after_buy == quote_before
            && acquired >= terms.voted_min_base_out_raw
            && acquired > 0
            && ctx.accounts.capital_mint.supply == supply_before,
        GovernanceError::BuybackBalanceMismatch
    );

    let mut destination = Pubkey::default();
    let mut destination_before = 0;
    let mut destination_after = 0;
    let duration = ctx
        .accounts
        .proposal
        .options
        .get(usize::from(ctx.accounts.proposal.winning_option))
        .ok_or(GovernanceError::InvalidOption)?
        .lock_duration_seconds;
    match terms.action {
        ReserveAction::BuybackHold | ReserveAction::BuybackLock => {
            let (authority, target) = if terms.action == ReserveAction::BuybackHold {
                (
                    ctx.accounts.hold_authority.to_account_info(),
                    ctx.accounts.hold_ata.to_account_info(),
                )
            } else {
                (
                    ctx.accounts.receipt.to_account_info(),
                    ctx.accounts.lock_ata.to_account_info(),
                )
            };
            create_ata(
                ctx.accounts.associated_token_program.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                target.clone(),
                authority.clone(),
                ctx.accounts.capital_mint.to_account_info(),
                ctx.accounts.base_token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            )?;
            destination = *target.key;
            destination_before = token_balance(
                &target,
                &ctx.accounts.capital_mint.key(),
                authority.key,
                &ctx.accounts.config.capital_token_program,
            )?;
            checked_token_transfer(
                &ctx.accounts.config.capital_token_program,
                ctx.accounts.trader_base_ata.to_account_info(),
                ctx.accounts.capital_mint.to_account_info(),
                target.clone(),
                ctx.accounts.trader.to_account_info(),
                acquired,
                ctx.accounts.capital_mint.decimals,
                trader_seeds,
            )?;
            destination_after = token_balance(
                &target,
                &ctx.accounts.capital_mint.key(),
                authority.key,
                &ctx.accounts.config.capital_token_program,
            )?;
        }
        ReserveAction::BuybackBurn => {
            let burn = spl_token_2022::instruction::burn_checked(
                &ctx.accounts.config.capital_token_program,
                &ctx.accounts.trader_base_ata.key(),
                &ctx.accounts.capital_mint.key(),
                &trader,
                &[],
                acquired,
                ctx.accounts.capital_mint.decimals,
            )?;
            invoke_signed(
                &burn,
                &[
                    ctx.accounts.trader_base_ata.to_account_info(),
                    ctx.accounts.capital_mint.to_account_info(),
                    ctx.accounts.trader.to_account_info(),
                ],
                trader_seeds,
            )?;
        }
        _ => return err!(GovernanceError::WrongWinningAction),
    }
    ctx.accounts.capital_mint.reload()?;
    let after = BuybackBalances {
        reserve_before,
        reserve_after: ctx.accounts.reserve_vault.amount,
        trader_quote_before: quote_before,
        trader_quote_after_funding: expected_quote_funded,
        trader_quote_after_buy: quote_after_buy,
        trader_base_before: base_before,
        trader_base_after_buy: base_after_buy,
        trader_base_after_action: token_balance(
            &ctx.accounts.trader_base_ata.to_account_info(),
            &ctx.accounts.capital_mint.key(),
            &trader,
            &ctx.accounts.config.capital_token_program,
        )?,
        destination_before,
        destination_after,
        base_supply_before: supply_before,
        base_supply_after: ctx.accounts.capital_mint.supply,
    };
    require!(
        validate_buyback_balance_conservation(&terms, after)? == acquired,
        GovernanceError::BuybackBalanceMismatch
    );

    let receipt = &mut ctx.accounts.receipt;
    receipt.schema_version = SCHEMA_VERSION;
    receipt.proposal = ctx.accounts.proposal.key();
    receipt.config = ctx.accounts.config.key();
    receipt.capital_mint = ctx.accounts.capital_mint.key();
    receipt.reserve_vault = ctx.accounts.reserve_vault.key();
    receipt.trader = trader;
    receipt.venue_program = buy_instruction.program_id;
    receipt.venue_account = venue_account;
    receipt.destination = destination;
    receipt.action = terms.action;
    receipt.quote_spent_raw = terms.committed_quote_raw;
    receipt.voted_min_output_raw = terms.voted_min_base_out_raw;
    receipt.base_acquired_raw = acquired;
    receipt.base_supply_before = supply_before;
    receipt.base_supply_after = ctx.accounts.capital_mint.supply;
    receipt.executed_at = now;
    receipt.lock_release_at = terms.lock_release_at;
    receipt.lock_released_at = 0;
    receipt.lock_duration_seconds = duration;
    receipt.bump = ctx.bumps.receipt;
    ctx.accounts.proposal.status = STATUS_EXECUTED;
    ctx.accounts.config.committed_reserve_raw_mstrx = 0;
    ctx.accounts.config.active_proposal_id = 0;
    emit!(BuybackExecuted {
        proposal: receipt.proposal,
        receipt: receipt.key(),
        venue_program: receipt.venue_program,
        quote_spent_raw: receipt.quote_spent_raw,
        base_acquired_raw: receipt.base_acquired_raw,
        action: receipt.action,
    });
    Ok(())
}

#[event]
pub struct BuybackExecuted {
    pub proposal: Pubkey,
    pub receipt: Pubkey,
    pub venue_program: Pubkey,
    pub quote_spent_raw: u64,
    pub base_acquired_raw: u64,
    pub action: ReserveAction,
}

pub(crate) fn release(ctx: Context<ReleaseCapitalLock>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let receipt = &ctx.accounts.receipt;
    let option = ctx
        .accounts
        .proposal
        .options
        .get(usize::from(ctx.accounts.proposal.winning_option))
        .ok_or(GovernanceError::InvalidOption)?;
    require!(
        receipt.schema_version == SCHEMA_VERSION
            && receipt.action == ReserveAction::BuybackLock
            && ctx.accounts.proposal.status == STATUS_EXECUTED
            && option.action == ReserveAction::BuybackLock
            && receipt.quote_spent_raw == ctx.accounts.proposal.frozen_reserve_raw_mstrx
            && receipt.voted_min_output_raw == option.min_output_raw
            && receipt.base_acquired_raw >= option.min_output_raw
            && receipt.lock_duration_seconds == option.lock_duration_seconds
            && receipt.destination == ctx.accounts.lock_ata.key()
            && receipt.lock_released_at == 0,
        GovernanceError::LockAlreadyReleased
    );
    require!(
        receipt.lock_duration_seconds != PERMANENT_LOCK_SECONDS
            && receipt.lock_release_at > receipt.executed_at,
        GovernanceError::PermanentLock
    );
    require!(
        now >= receipt.lock_release_at,
        GovernanceError::LockNotMature
    );
    validate_capital_mint_policy(&ctx.accounts.capital_mint)?;
    require!(
        ctx.accounts.config.capital_mint == receipt.capital_mint
            && ctx.accounts.config.capital_token_program == ctx.accounts.base_token_program.key(),
        GovernanceError::BuybackIdentityMismatch
    );
    create_ata(
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.hold_ata.to_account_info(),
        ctx.accounts.hold_authority.to_account_info(),
        ctx.accounts.capital_mint.to_account_info(),
        ctx.accounts.base_token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
    )?;
    let lock_before = token_balance(
        &ctx.accounts.lock_ata.to_account_info(),
        &receipt.capital_mint,
        &receipt.key(),
        &ctx.accounts.config.capital_token_program,
    )?;
    require!(
        lock_before >= receipt.base_acquired_raw,
        GovernanceError::LockBalanceChanged
    );
    let hold_before = token_balance(
        &ctx.accounts.hold_ata.to_account_info(),
        &receipt.capital_mint,
        &ctx.accounts.hold_authority.key(),
        &ctx.accounts.config.capital_token_program,
    )?;
    let proposal_key = receipt.proposal;
    let receipt_bump = [receipt.bump];
    let seeds: &[&[&[u8]]] = &[&[RECEIPT_SEED, proposal_key.as_ref(), &receipt_bump]];
    checked_token_transfer(
        &ctx.accounts.config.capital_token_program,
        ctx.accounts.lock_ata.to_account_info(),
        ctx.accounts.capital_mint.to_account_info(),
        ctx.accounts.hold_ata.to_account_info(),
        receipt.to_account_info(),
        lock_before,
        ctx.accounts.capital_mint.decimals,
        seeds,
    )?;
    let lock_after = token_balance(
        &ctx.accounts.lock_ata.to_account_info(),
        &receipt.capital_mint,
        &receipt.key(),
        &ctx.accounts.config.capital_token_program,
    )?;
    let hold_after = token_balance(
        &ctx.accounts.hold_ata.to_account_info(),
        &receipt.capital_mint,
        &ctx.accounts.hold_authority.key(),
        &ctx.accounts.config.capital_token_program,
    )?;
    require!(
        lock_after == 0
            && hold_after
                == hold_before
                    .checked_add(lock_before)
                    .ok_or(GovernanceError::Overflow)?,
        GovernanceError::LockTransferMismatch
    );
    ctx.accounts.receipt.lock_released_at = now;
    emit!(CapitalLockReleased {
        proposal: ctx.accounts.proposal.key(),
        receipt: ctx.accounts.receipt.key(),
        held_raw: lock_before,
        released_at: now,
    });
    Ok(())
}

#[event]
pub struct CapitalLockReleased {
    pub proposal: Pubkey,
    pub receipt: Pubkey,
    pub held_raw: u64,
    pub released_at: i64,
}
