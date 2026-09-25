//! Fail-closed executor for the fixed Raydium CLMM MSTRx -> SOL marketing route.
//!
//! The instruction is present but its independent release flag is false. Host
//! tests validate the pinned ABI, account identity and balance conservation;
//! they do not prove live Raydium CPI behavior. A disposable onchain canary,
//! receipt verification and review are required before ever opening the gate.
//!
//! Layout, PDA seeds and swap semantics are from official Raydium source:
//! https://github.com/raydium-io/raydium-clmm/tree/master/programs/amm/src

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    bpf_loader_upgradeable,
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_pack::Pack,
    pubkey,
};
use anchor_lang::system_program;
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token::{self, Token},
    token_2022::{self, Token2022},
    token_interface::{Mint, TokenAccount},
};

use crate::{
    Config, GovernanceError, Proposal, ReserveAction, MSTRX_MINT, SCHEMA_VERSION, STATUS_EXECUTED,
    STATUS_PASSED_NOT_EXECUTED,
};

const CLMM: Pubkey = pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const POOL: Pubkey = pubkey!("2ngTuP7xA581dqX9uJkGRqxmKuehY3k4SDfPebeoRG2J");
const AMM_CONFIG: Pubkey = pubkey!("E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp");
const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const WSOL_VAULT: Pubkey = pubkey!("8bGP3uD7vzGbdWhFxFs8ycQ5gSWUZsRCUGAHD3HxFaBT");
const MSTRX_VAULT: Pubkey = pubkey!("6arQLB45rbMe8hHr5XaUvN9Qd38sArY4aevFohmyVeT9");
const OBSERVATION: Pubkey = pubkey!("EKZFB3t9DyayQFUpPJz8FSaxmx7dgE31Q354DMLrxCxH");
const MEMO: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const TRADER_SEED: &[u8] = b"proposal-trader";
const POOL_LEN: usize = 1544;
const CONFIG_LEN: usize = 117;
const OBSERVATION_LEN: usize = 4483;
const BITMAP_LEN: usize = 1832;
// TickState::LEN=168, TickArrayState::LEN=8+32+4+60*168+1+115.
const TICK_ARRAY_LEN: usize = 10240;
const TICK_SPACING: u16 = 60;
const TICKS_PER_ARRAY: i32 = 60;
const MAX_TICK_ARRAYS: usize = 8;
const MIN_TICK: i32 = -443636;
const MAX_TICK: i32 = 443636;

#[account]
pub struct MarketingSaleReceipt {
    pub schema_version: u8,
    pub action: u8, // ReserveAction::MarketingSale = 5
    pub proposal: Pubkey,
    pub config: Pubkey,
    pub reserve_mint: Pubkey,
    pub reserve_vault: Pubkey,
    pub recipient: Pubkey,
    pub pool: Pubkey,
    pub input_mstrx_raw: u64,
    pub voted_min_sol_lamports: u64,
    pub execution_min_sol_lamports: u64,
    pub actual_sol_forwarded_lamports: u64,
    pub wsol_ata_rent_returned_lamports: u64,
    pub executed_at: i64,
    pub bump: u8,
}

impl MarketingSaleReceipt {
    pub const SPACE: usize = 8 + 3 + 6 * 32 + 5 * 8 + 8;
}

#[error_code]
pub enum MarketingSaleError {
    #[msg("Marketing sale executor is not released")]
    NotReleased,
    #[msg("Winning marketing sale or immutable minimum is invalid")]
    InvalidDecision,
    #[msg("The pinned Raydium market or tick-array route is invalid")]
    InvalidRoute,
    #[msg("The trader PDA, its canonical token accounts or recipient are invalid")]
    InvalidTraderOrRecipient,
    #[msg("Full reserve input, WSOL output or SOL forwarding did not conserve")]
    ConservationMismatch,
    #[msg("Rent or trader SOL balance is insufficient")]
    TraderBelowRentFloor,
}

// Kept closed independently of the global proposal release. A code build and
// passing host tests do not prove Raydium CPI behavior on the target cluster.
pub const MARKETING_SALE_EXECUTOR_RELEASED: bool = false;

#[derive(Accounts)]
pub struct ExecuteMarketingSale<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"proposal", &proposal.id.to_le_bytes()], bump = proposal.bump,
        has_one = config, has_one = reserve_vault)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(init, payer = payer, space = MarketingSaleReceipt::SPACE,
        seeds = [b"marketing-sale-receipt", proposal.key().as_ref()], bump)]
    pub receipt: Account<'info, MarketingSaleReceipt>,
    #[account(address = MSTRX_MINT,
        constraint = *reserve_mint.to_account_info().owner == token_2022::ID
            @ GovernanceError::InvalidReserveMint)]
    pub reserve_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = config.reserve_vault,
        associated_token::mint = reserve_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: exact PDA, System ownership and empty data checked by route guard
    #[account(mut, seeds = [TRADER_SEED], bump)]
    pub trader: UncheckedAccount<'info>,
    /// CHECK: created idempotently, then checked against exact ATA/mint/owner
    #[account(mut, address = associated_token::get_associated_token_address_with_program_id(
        &trader.key(), &MSTRX_MINT, &token_2022::ID))]
    pub trader_mstrx: UncheckedAccount<'info>,
    /// CHECK: created idempotently, then checked against exact native WSOL ATA
    #[account(mut, address = associated_token::get_associated_token_address_with_program_id(
        &trader.key(), &WSOL, &token::ID))]
    pub trader_wsol: UncheckedAccount<'info>,
    /// CHECK: exact immutable recipient and empty System account checked by guard
    #[account(mut, address = config.marketing_wallet)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: pinned program identity and executable bit checked by route guard
    #[account(address = CLMM)]
    pub raydium_program: UncheckedAccount<'info>,
    /// CHECK: pinned state identity, owner, discriminator and layout checked
    #[account(mut, address = POOL)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: pinned config identity, owner, discriminator and layout checked
    #[account(address = AMM_CONFIG)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: pinned observation identity, owner, discriminator and layout checked
    #[account(mut, address = OBSERVATION)]
    pub observation: UncheckedAccount<'info>,
    #[account(address = WSOL)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: exact pool-owned Token-2022 vault checked by route guard
    #[account(mut, address = MSTRX_VAULT)]
    pub mstrx_vault: UncheckedAccount<'info>,
    /// CHECK: exact pool-owned classic SPL vault checked by route guard
    #[account(mut, address = WSOL_VAULT)]
    pub wsol_vault: UncheckedAccount<'info>,
    /// CHECK: canonical Raydium pool bitmap PDA, owner and bytes checked
    #[account(mut, seeds = [b"pool_tick_array_bitmap_extension", POOL.as_ref()], bump,
        seeds::program = CLMM)]
    pub bitmap: UncheckedAccount<'info>,
    /// CHECK: exact immutable Memo program key checked by route guard
    #[account(address = MEMO)]
    pub memo_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MarketingGuardError {
    UnfinalizedDecision,
    CommitmentMismatch,
    InvalidVotedFloor,
    InvalidRecipient,
    InvalidTrader,
    WrongMarketAccount,
    WrongMarketLayout,
    WrongTickArray,
    BalanceMismatch,
}

type GuardResult<T> = core::result::Result<T, MarketingGuardError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MarketingSaleTerms {
    pub committed_mstrx_raw: u64,
    pub reserve_vault_raw_mstrx: u64,
    pub voted_min_sol_lamports: u64,
    pub execution_min_sol_lamports: u64,
    pub recipient: Pubkey,
}

/// The caller must pass the actual account key and freshly reloaded Token-2022
/// reserve-vault amount, not caller-chosen values.
/// A keeper may raise the voted floor but cannot lower it or spend less than
/// the exact still-committed reserve amount.
pub(crate) fn validate_marketing_sale_terms(
    config_key: Pubkey,
    config: &Config,
    proposal: &Proposal,
    now: i64,
    reserve_vault_raw_mstrx: u64,
    execution_min_sol_lamports: u64,
) -> GuardResult<MarketingSaleTerms> {
    if config.schema_version != SCHEMA_VERSION
        || proposal.schema_version != SCHEMA_VERSION
        || proposal.config != config_key
        || config.active_proposal_id != proposal.id
        || proposal.status != STATUS_PASSED_NOT_EXECUTED
        || now < proposal.executable_at
        || proposal.capital_mint != config.capital_mint
        || proposal.reserve_vault != config.reserve_vault
        || config.reserve_mint != MSTRX_MINT
    {
        return Err(MarketingGuardError::UnfinalizedDecision);
    }
    let option = proposal
        .options
        .get(usize::from(proposal.winning_option))
        .ok_or(MarketingGuardError::UnfinalizedDecision)?;
    if option.action != ReserveAction::MarketingSale || option.lock_duration_seconds != 0 {
        return Err(MarketingGuardError::UnfinalizedDecision);
    }
    if proposal.frozen_reserve_raw_mstrx == 0
        || config.committed_reserve_raw_mstrx != proposal.frozen_reserve_raw_mstrx
        || option.reserve_raw_mstrx != proposal.frozen_reserve_raw_mstrx
        || reserve_vault_raw_mstrx < proposal.frozen_reserve_raw_mstrx
    {
        return Err(MarketingGuardError::CommitmentMismatch);
    }
    if option.min_output_raw == 0 || execution_min_sol_lamports < option.min_output_raw {
        return Err(MarketingGuardError::InvalidVotedFloor);
    }
    if config.marketing_wallet == Pubkey::default() || option.recipient != config.marketing_wallet {
        return Err(MarketingGuardError::InvalidRecipient);
    }
    Ok(MarketingSaleTerms {
        committed_mstrx_raw: option.reserve_raw_mstrx,
        reserve_vault_raw_mstrx,
        voted_min_sol_lamports: option.min_output_raw,
        execution_min_sol_lamports,
        recipient: option.recipient,
    })
}

/// Synthetic account view so the account-byte parser is testable without an RPC
/// or a CPI. Integration must construct it from the *actual* AccountInfo fields.
pub(crate) struct AccountView<'a> {
    pub key: Pubkey,
    pub owner: Pubkey,
    pub writable: bool,
    pub executable: bool,
    pub data: &'a [u8],
}

pub(crate) struct MarketingClmmViews<'a> {
    pub program: AccountView<'a>,
    pub pool: AccountView<'a>,
    pub config: AccountView<'a>,
    pub observation: AccountView<'a>,
    pub wsol_mint: AccountView<'a>,
    pub mstrx_mint: AccountView<'a>,
    pub wsol_vault: AccountView<'a>,
    pub mstrx_vault: AccountView<'a>,
    pub bitmap: AccountView<'a>,
    pub ticks: &'a [AccountView<'a>],
    pub trader: AccountView<'a>,
    pub trader_mstrx: AccountView<'a>,
    pub trader_wsol: AccountView<'a>,
    pub recipient: AccountView<'a>,
}

fn discriminator(name: &str) -> [u8; 8] {
    let digest = hashv(&[b"account:", name.as_bytes()]).to_bytes();
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

fn swap_v2_discriminator() -> [u8; 8] {
    let digest = hashv(&[b"global:swap_v2"]).to_bytes();
    digest[..8].try_into().expect("SHA256 is 32 bytes")
}

fn key_at(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(
        data[offset..offset + 32]
            .try_into()
            .expect("checked layout length"),
    )
}

fn account_layout(
    account: &AccountView,
    key: Pubkey,
    owner: Pubkey,
    len: usize,
    name: &str,
    writable: bool,
) -> bool {
    account.key == key
        && account.owner == owner
        && account.data.len() == len
        && !account.executable
        && (!writable || account.writable)
        && account.data[..8] == discriminator(name)
}

fn token_account(
    account: &AccountView,
    key: Pubkey,
    program: Pubkey,
    mint: Pubkey,
    authority: Pubkey,
    writable: bool,
) -> bool {
    account.key == key
        && account.owner == program
        && !account.executable
        && (!writable || account.writable)
        && account.data.len() >= 165
        && key_at(account.data, 0) == mint
        && key_at(account.data, 32) == authority
        && account.data[108] == 1 // Initialized, not Frozen
        && account.data[72..76] == [0; 4] // No delegate
}

fn mint_account(account: &AccountView, key: Pubkey, program: Pubkey, decimals: u8) -> bool {
    account.key == key
        && account.owner == program
        && !account.executable
        && account.data.len() >= 82
        && account.data[44] == decimals
        && account.data[45] == 1 // Initialized SPL base mint state
}

fn trader_ata(trader: Pubkey, mint: Pubkey, token_program: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[trader.as_ref(), token_program.as_ref(), mint.as_ref()],
        &associated_token::ID,
    )
    .0
}

/// Exact-input Raydium `swap_v2` ABI. The caller must first run the complete
/// route guard against actual accounts, and must include exactly the bitmap
/// followed by the inspected, ordered tick arrays in the CPI account infos.
/// A zero price limit makes Raydium reject a partial input fill; the executor
/// must additionally compare the real before/after Token-2022 balances.
pub(crate) fn pinned_marketing_swap_instruction(
    trader: Pubkey,
    amount_mstrx_raw: u64,
    min_wsol_raw: u64,
    tick_arrays: &[Pubkey],
) -> GuardResult<Instruction> {
    if trader != Pubkey::find_program_address(&[TRADER_SEED], &crate::ID).0
        || amount_mstrx_raw == 0
        || min_wsol_raw == 0
    {
        return Err(MarketingGuardError::InvalidTrader);
    }
    if tick_arrays.is_empty() || tick_arrays.len() > MAX_TICK_ARRAYS {
        return Err(MarketingGuardError::WrongTickArray);
    }
    let mut accounts = vec![
        AccountMeta::new_readonly(trader, true),
        AccountMeta::new_readonly(AMM_CONFIG, false),
        AccountMeta::new(POOL, false),
        AccountMeta::new(trader_ata(trader, MSTRX_MINT, token_2022::ID), false),
        AccountMeta::new(trader_ata(trader, WSOL, token::ID), false),
        AccountMeta::new(MSTRX_VAULT, false),
        AccountMeta::new(WSOL_VAULT, false),
        AccountMeta::new(OBSERVATION, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(token_2022::ID, false),
        AccountMeta::new_readonly(MEMO, false),
        AccountMeta::new_readonly(MSTRX_MINT, false),
        AccountMeta::new_readonly(WSOL, false),
        AccountMeta::new(
            Pubkey::find_program_address(
                &[b"pool_tick_array_bitmap_extension", POOL.as_ref()],
                &CLMM,
            )
            .0,
            false,
        ),
    ];
    for key in tick_arrays {
        accounts.push(AccountMeta::new(*key, false));
    }
    let mut data = Vec::with_capacity(41);
    data.extend_from_slice(&swap_v2_discriminator());
    data.extend_from_slice(&amount_mstrx_raw.to_le_bytes());
    data.extend_from_slice(&min_wsol_raw.to_le_bytes());
    data.extend_from_slice(&0u128.to_le_bytes());
    data.push(1); // is_base_input=true
    Ok(Instruction {
        program_id: CLMM,
        accounts,
        data,
    })
}

/// Structural allowlist only. In particular, these checks do not establish
/// tick bitmap initialization, full trade depth, extension compatibility or a
/// quote. Raydium's own swap must consume its pinned exact-input amount and a
/// post-CPI balance check must still prove full conservation.
pub(crate) fn validate_pinned_marketing_clmm(
    views: &MarketingClmmViews,
    fixed_recipient: Pubkey,
) -> GuardResult<()> {
    if views.program.key != CLMM
        || views.program.owner != bpf_loader_upgradeable::ID
        || !views.program.executable
        || views.program.data.len() != 36
        || views.program.data[..4] != 2u32.to_le_bytes()
        || views.program.data[4..36] == [0; 32]
        || !account_layout(&views.pool, POOL, CLMM, POOL_LEN, "PoolState", true)
        || !account_layout(
            &views.config,
            AMM_CONFIG,
            CLMM,
            CONFIG_LEN,
            "AmmConfig",
            false,
        )
        || !account_layout(
            &views.observation,
            OBSERVATION,
            CLMM,
            OBSERVATION_LEN,
            "ObservationState",
            true,
        )
    {
        return Err(MarketingGuardError::WrongMarketAccount);
    }
    let pool = views.pool.data;
    let (derived, bump) = Pubkey::find_program_address(
        &[
            b"pool",
            AMM_CONFIG.as_ref(),
            WSOL.as_ref(),
            MSTRX_MINT.as_ref(),
        ],
        &CLMM,
    );
    if derived != POOL || pool[8] != bump || key_at(pool, 9) != AMM_CONFIG
        || key_at(pool, 73) != WSOL || key_at(pool, 105) != MSTRX_MINT
        || key_at(pool, 137) != WSOL_VAULT || key_at(pool, 169) != MSTRX_VAULT
        || key_at(pool, 201) != OBSERVATION || pool[233] != 9 || pool[234] != 8
        || u16::from_le_bytes(pool[235..237].try_into().unwrap()) != TICK_SPACING
        || pool[389] & (1 << 4) != 0 // Raydium swap-disabled bit
        || pool[391..393] != [0, 0] // Pinned legacy pool PDA, no indexed seed
        || pool[237..253] == [0; 16] // No active liquidity
        || views.config.data[51..53] != TICK_SPACING.to_le_bytes()
        || key_at(views.observation.data, 19) != POOL
    {
        return Err(MarketingGuardError::WrongMarketLayout);
    }
    if !mint_account(&views.wsol_mint, WSOL, token::ID, 9)
        || !mint_account(&views.mstrx_mint, MSTRX_MINT, token_2022::ID, 8)
        || !token_account(&views.wsol_vault, WSOL_VAULT, token::ID, WSOL, POOL, true)
        || views.wsol_vault.data[64..72] == [0; 8]
        || !token_account(
            &views.mstrx_vault,
            MSTRX_VAULT,
            token_2022::ID,
            MSTRX_MINT,
            POOL,
            true,
        )
        || views.mstrx_vault.data[64..72] == [0; 8]
    {
        return Err(MarketingGuardError::WrongMarketAccount);
    }
    let trader = Pubkey::find_program_address(&[TRADER_SEED], &crate::ID).0;
    if views.trader.key != trader
        || views.trader.owner != system_program::ID
        || !views.trader.data.is_empty()
        || views.trader.executable
        || !views.trader.writable
        || !token_account(
            &views.trader_mstrx,
            trader_ata(trader, MSTRX_MINT, token_2022::ID),
            token_2022::ID,
            MSTRX_MINT,
            trader,
            true,
        )
        || !token_account(
            &views.trader_wsol,
            trader_ata(trader, WSOL, token::ID),
            token::ID,
            WSOL,
            trader,
            true,
        )
        || views.trader_wsol.data[109..113] != 1u32.to_le_bytes()
    // Native WSOL
    {
        return Err(MarketingGuardError::InvalidTrader);
    }
    if fixed_recipient == Pubkey::default()
        || views.recipient.key != fixed_recipient
        || views.recipient.owner != system_program::ID
        || !views.recipient.data.is_empty()
        || views.recipient.executable
        || !views.recipient.writable
        || views.recipient.key == trader
    {
        return Err(MarketingGuardError::InvalidRecipient);
    }
    if !account_layout(
        &views.bitmap,
        Pubkey::find_program_address(&[b"pool_tick_array_bitmap_extension", POOL.as_ref()], &CLMM)
            .0,
        CLMM,
        BITMAP_LEN,
        "TickArrayBitmapExtension",
        true,
    ) || key_at(views.bitmap.data, 8) != POOL
    {
        return Err(MarketingGuardError::WrongTickArray);
    }
    if views.ticks.is_empty() || views.ticks.len() > MAX_TICK_ARRAYS {
        return Err(MarketingGuardError::WrongTickArray);
    }
    let current_tick = i32::from_le_bytes(pool[269..273].try_into().unwrap());
    let tick_count = TICK_SPACING as i32 * TICKS_PER_ARRAY;
    let current_array_start = current_tick.div_euclid(tick_count) * tick_count;
    let mut previous = None;
    for tick in views.ticks {
        if tick.owner != CLMM
            || !tick.writable
            || tick.executable
            || tick.data.len() != TICK_ARRAY_LEN
            || tick.data[..8] != discriminator("TickArrayState")
            || key_at(tick.data, 8) != POOL
        {
            return Err(MarketingGuardError::WrongTickArray);
        }
        let start = i32::from_le_bytes(tick.data[40..44].try_into().unwrap());
        let derived = Pubkey::find_program_address(
            &[b"tick_array", POOL.as_ref(), &start.to_be_bytes()],
            &CLMM,
        )
        .0;
        if start < MIN_TICK
            || start > MAX_TICK
            || start % tick_count != 0
            || start < current_array_start
            || previous.is_some_and(|last| start <= last)
            || tick.key != derived
        {
            return Err(MarketingGuardError::WrongTickArray);
        }
        previous = Some(start);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct MarketingSaleBalances {
    pub reserve_before: u64,
    pub reserve_after_funding: u64,
    pub trader_mstrx_before: u64,
    pub trader_mstrx_after_funding: u64,
    pub trader_mstrx_after_swap: u64,
    pub trader_wsol_before: u64,
    pub trader_wsol_after_swap: u64,
    pub trader_wsol_after_close: u64,
    pub wsol_account_rent_lamports: u64,
    pub trader_sol_before_close: u64,
    pub trader_sol_after_close: u64,
    pub trader_sol_after_forward: u64,
    pub recipient_sol_before: u64,
    pub recipient_sol_after: u64,
}

/// Call only after the *same instruction* has funded, swapped, closed WSOL and
/// forwarded SOL. Pre-existing donated token balances and WSOL rent remain
/// with the trader PDA; only the fresh swap output reaches the recipient.
/// Every `checked_*` failure rejects rather than wrapping. A failed assertion
/// must abort the whole Solana transaction, preserving the vote commitment.
pub(crate) fn validate_marketing_sale_conservation(
    terms: MarketingSaleTerms,
    b: MarketingSaleBalances,
) -> GuardResult<u64> {
    let output = b
        .trader_wsol_after_swap
        .checked_sub(b.trader_wsol_before)
        .ok_or(MarketingGuardError::BalanceMismatch)?;
    let close_proceeds = b
        .trader_sol_after_close
        .checked_sub(b.trader_sol_before_close)
        .ok_or(MarketingGuardError::BalanceMismatch)?;
    let forwarded = b
        .trader_sol_after_close
        .checked_sub(b.trader_sol_after_forward)
        .ok_or(MarketingGuardError::BalanceMismatch)?;
    let received = b
        .recipient_sol_after
        .checked_sub(b.recipient_sol_before)
        .ok_or(MarketingGuardError::BalanceMismatch)?;
    if b.reserve_before != terms.reserve_vault_raw_mstrx
        || b.reserve_before.checked_sub(b.reserve_after_funding) != Some(terms.committed_mstrx_raw)
        || b.trader_mstrx_before.checked_add(terms.committed_mstrx_raw)
            != Some(b.trader_mstrx_after_funding)
        || b.trader_mstrx_after_swap != b.trader_mstrx_before
        || b.trader_wsol_after_close != 0
        || output < terms.execution_min_sol_lamports
        || close_proceeds
            != b.trader_wsol_after_swap
                .checked_add(b.wsol_account_rent_lamports)
                .ok_or(MarketingGuardError::BalanceMismatch)?
        || forwarded != output
        || received != output
        || b.trader_sol_after_forward
            != b.trader_sol_before_close
                .checked_add(b.trader_wsol_before)
                .and_then(|value| value.checked_add(b.wsol_account_rent_lamports))
                .ok_or(MarketingGuardError::BalanceMismatch)?
    {
        return Err(MarketingGuardError::BalanceMismatch);
    }
    Ok(output)
}

fn guard_error(error: MarketingGuardError) -> Error {
    match error {
        MarketingGuardError::UnfinalizedDecision
        | MarketingGuardError::CommitmentMismatch
        | MarketingGuardError::InvalidVotedFloor => error!(MarketingSaleError::InvalidDecision),
        MarketingGuardError::InvalidRecipient | MarketingGuardError::InvalidTrader => {
            error!(MarketingSaleError::InvalidTraderOrRecipient)
        }
        MarketingGuardError::BalanceMismatch => error!(MarketingSaleError::ConservationMismatch),
        MarketingGuardError::WrongMarketAccount
        | MarketingGuardError::WrongMarketLayout
        | MarketingGuardError::WrongTickArray => error!(MarketingSaleError::InvalidRoute),
    }
}

fn checked_mstrx_balance(account: &AccountInfo, authority: Pubkey) -> Result<u64> {
    let data = account.try_borrow_data()?;
    let state = token_2022::spl_token_2022::extension::StateWithExtensions::<
        token_2022::spl_token_2022::state::Account,
    >::unpack(&data)
    .map_err(|_| MarketingSaleError::InvalidTraderOrRecipient)?;
    require_keys_eq!(
        state.base.mint,
        MSTRX_MINT,
        MarketingSaleError::InvalidTraderOrRecipient
    );
    require_keys_eq!(
        state.base.owner,
        authority,
        MarketingSaleError::InvalidTraderOrRecipient
    );
    Ok(state.base.amount)
}

fn checked_wsol_state(account: &AccountInfo, authority: Pubkey) -> Result<(u64, u64)> {
    let data = account.try_borrow_data()?;
    let state = token::spl_token::state::Account::unpack(&data)
        .map_err(|_| MarketingSaleError::InvalidTraderOrRecipient)?;
    require_keys_eq!(
        state.mint,
        WSOL,
        MarketingSaleError::InvalidTraderOrRecipient
    );
    require_keys_eq!(
        state.owner,
        authority,
        MarketingSaleError::InvalidTraderOrRecipient
    );
    let rent = match state.is_native {
        anchor_lang::solana_program::program_option::COption::Some(value) => value,
        _ => return err!(MarketingSaleError::InvalidTraderOrRecipient),
    };
    require!(
        account.lamports()
            == state
                .amount
                .checked_add(rent)
                .ok_or(GovernanceError::Overflow)?,
        MarketingSaleError::ConservationMismatch
    );
    Ok((state.amount, rent))
}

fn view<'a>(account: &AccountInfo, data: &'a [u8]) -> AccountView<'a> {
    AccountView {
        key: *account.key,
        owner: *account.owner,
        writable: account.is_writable,
        executable: account.executable,
        data,
    }
}

/// The only intended onchain marketing executor. It is wired to the program
/// only after the route passes a disposable canary and review. Until then its
/// independent release flag is false, so no reserve can leave through it.
pub(crate) fn execute_marketing_sale<'info>(
    ctx: Context<'_, '_, '_, 'info, ExecuteMarketingSale<'info>>,
    execution_min_sol_lamports: u64,
) -> Result<()> {
    require!(
        MARKETING_SALE_EXECUTOR_RELEASED,
        MarketingSaleError::NotReleased
    );
    super::validate_mstrx_mint(&ctx.accounts.reserve_mint)?;
    require!(
        ctx.remaining_accounts.len() > 0 && ctx.remaining_accounts.len() <= MAX_TICK_ARRAYS,
        MarketingSaleError::InvalidRoute
    );
    let now = Clock::get()?.unix_timestamp;
    let config_key = ctx.accounts.config.key();
    let proposal_key = ctx.accounts.proposal.key();
    let terms = validate_marketing_sale_terms(
        config_key,
        &ctx.accounts.config,
        &ctx.accounts.proposal,
        now,
        ctx.accounts.reserve_vault.amount,
        execution_min_sol_lamports,
    )
    .map_err(guard_error)?;
    let trader_key = ctx.accounts.trader.key();
    require!(
        ctx.accounts.trader.lamports() >= Rent::get()?.minimum_balance(0),
        MarketingSaleError::TraderBelowRentFloor
    );

    // Associated Token creates are idempotent. Permissionless donations to
    // these predictable PDA ATAs must not permanently block execution.
    associated_token::create_idempotent(CpiContext::new(
        ctx.accounts.associated_token_program.to_account_info(),
        associated_token::Create {
            payer: ctx.accounts.payer.to_account_info(),
            associated_token: ctx.accounts.trader_mstrx.to_account_info(),
            authority: ctx.accounts.trader.to_account_info(),
            mint: ctx.accounts.reserve_mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_2022_program.to_account_info(),
        },
    ))?;

    associated_token::create_idempotent(CpiContext::new(
        ctx.accounts.associated_token_program.to_account_info(),
        associated_token::Create {
            payer: ctx.accounts.payer.to_account_info(),
            associated_token: ctx.accounts.trader_wsol.to_account_info(),
            authority: ctx.accounts.trader.to_account_info(),
            mint: ctx.accounts.wsol_mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
    ))?;

    // An outsider can transfer lamports directly to the predictable WSOL ATA
    // without updating its native token amount. Sync them before taking the
    // baseline, so the invariant is valid even for a pre-funded account.
    token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        token::SyncNative {
            account: ctx.accounts.trader_wsol.to_account_info(),
        },
    ))?;

    let fixed = [
        ctx.accounts.raydium_program.to_account_info(),
        ctx.accounts.pool.to_account_info(),
        ctx.accounts.amm_config.to_account_info(),
        ctx.accounts.observation.to_account_info(),
        ctx.accounts.wsol_mint.to_account_info(),
        ctx.accounts.reserve_mint.to_account_info(),
        ctx.accounts.wsol_vault.to_account_info(),
        ctx.accounts.mstrx_vault.to_account_info(),
        ctx.accounts.bitmap.to_account_info(),
        ctx.accounts.trader.to_account_info(),
        ctx.accounts.trader_mstrx.to_account_info(),
        ctx.accounts.trader_wsol.to_account_info(),
        ctx.accounts.recipient.to_account_info(),
    ];
    let tick_keys = {
        let fixed_data = fixed
            .iter()
            .map(|account| account.try_borrow_data())
            .collect::<core::result::Result<Vec<_>, _>>()?;
        let tick_data = ctx
            .remaining_accounts
            .iter()
            .map(|account| account.try_borrow_data())
            .collect::<core::result::Result<Vec<_>, _>>()?;
        let ticks: Vec<AccountView<'_>> = ctx
            .remaining_accounts
            .iter()
            .zip(tick_data.iter())
            .map(|(account, data)| view(account, data))
            .collect();
        let route = MarketingClmmViews {
            program: view(&fixed[0], &fixed_data[0]),
            pool: view(&fixed[1], &fixed_data[1]),
            config: view(&fixed[2], &fixed_data[2]),
            observation: view(&fixed[3], &fixed_data[3]),
            wsol_mint: view(&fixed[4], &fixed_data[4]),
            mstrx_mint: view(&fixed[5], &fixed_data[5]),
            wsol_vault: view(&fixed[6], &fixed_data[6]),
            mstrx_vault: view(&fixed[7], &fixed_data[7]),
            bitmap: view(&fixed[8], &fixed_data[8]),
            trader: view(&fixed[9], &fixed_data[9]),
            trader_mstrx: view(&fixed[10], &fixed_data[10]),
            trader_wsol: view(&fixed[11], &fixed_data[11]),
            recipient: view(&fixed[12], &fixed_data[12]),
            ticks: &ticks,
        };
        validate_pinned_marketing_clmm(&route, terms.recipient).map_err(guard_error)?;
        ticks.iter().map(|tick| tick.key).collect::<Vec<_>>()
    };
    let reserve_before = ctx.accounts.reserve_vault.amount;
    let trader_mstrx_before = checked_mstrx_balance(&fixed[10], trader_key)?;
    let trader_wsol_before = checked_wsol_state(&fixed[11], trader_key)?.0;
    let recipient_sol_before = fixed[12].lamports();
    let config_bump = ctx.accounts.config.bump;
    let config_seeds: &[&[&[u8]]] = &[&[b"config", &[config_bump]]];
    token_2022::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            token_2022::TransferChecked {
                from: ctx.accounts.reserve_vault.to_account_info(),
                mint: ctx.accounts.reserve_mint.to_account_info(),
                to: ctx.accounts.trader_mstrx.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            config_seeds,
        ),
        terms.committed_mstrx_raw,
        8,
    )?;
    ctx.accounts.reserve_vault.reload()?;
    let reserve_after_funding = ctx.accounts.reserve_vault.amount;
    let trader_mstrx_after_funding = checked_mstrx_balance(&fixed[10], trader_key)?;

    let swap = pinned_marketing_swap_instruction(
        trader_key,
        terms.committed_mstrx_raw,
        terms.execution_min_sol_lamports,
        &tick_keys,
    )
    .map_err(guard_error)?;
    let mut swap_infos = vec![
        fixed[9].clone(),
        fixed[2].clone(),
        fixed[1].clone(),
        fixed[10].clone(),
        fixed[11].clone(),
        fixed[7].clone(),
        fixed[6].clone(),
        fixed[3].clone(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.memo_program.to_account_info(),
        fixed[5].clone(),
        fixed[4].clone(),
        fixed[8].clone(),
    ];
    swap_infos.extend(ctx.remaining_accounts.iter().cloned());
    swap_infos.push(fixed[0].clone());
    let trader_bump = ctx.bumps.trader;
    let trader_seeds: &[&[&[u8]]] = &[&[TRADER_SEED, &[trader_bump]]];
    invoke_signed(&swap, &swap_infos, trader_seeds)?;
    let trader_mstrx_after_swap = checked_mstrx_balance(&fixed[10], trader_key)?;
    let (trader_wsol_after_swap, wsol_rent) = checked_wsol_state(&fixed[11], trader_key)?;
    let trader_sol_before_close = fixed[9].lamports();

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        token::CloseAccount {
            account: fixed[11].clone(),
            destination: fixed[9].clone(),
            authority: fixed[9].clone(),
        },
        trader_seeds,
    ))?;
    let trader_sol_after_close = fixed[9].lamports();
    let trader_wsol_after_close = checked_wsol_state_after_close(&fixed[11])?;
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: fixed[9].clone(),
                to: fixed[12].clone(),
            },
            trader_seeds,
        ),
        trader_wsol_after_swap
            .checked_sub(trader_wsol_before)
            .ok_or(MarketingSaleError::ConservationMismatch)?,
    )?;
    let trader_sol_after_forward = fixed[9].lamports();
    let recipient_sol_after = fixed[12].lamports();
    let actual_forwarded = validate_marketing_sale_conservation(
        terms,
        MarketingSaleBalances {
            reserve_before,
            reserve_after_funding,
            trader_mstrx_before,
            trader_mstrx_after_funding,
            trader_mstrx_after_swap,
            trader_wsol_before,
            trader_wsol_after_swap,
            trader_wsol_after_close,
            wsol_account_rent_lamports: wsol_rent,
            trader_sol_before_close,
            trader_sol_after_close,
            trader_sol_after_forward,
            recipient_sol_before,
            recipient_sol_after,
        },
    )
    .map_err(guard_error)?;
    require!(
        trader_sol_after_forward >= Rent::get()?.minimum_balance(0),
        MarketingSaleError::TraderBelowRentFloor
    );
    let receipt = &mut ctx.accounts.receipt;
    receipt.schema_version = SCHEMA_VERSION;
    receipt.action = ReserveAction::MarketingSale as u8;
    receipt.proposal = proposal_key;
    receipt.config = config_key;
    receipt.reserve_mint = MSTRX_MINT;
    receipt.reserve_vault = ctx.accounts.reserve_vault.key();
    receipt.recipient = terms.recipient;
    receipt.pool = POOL;
    receipt.input_mstrx_raw = terms.committed_mstrx_raw;
    receipt.voted_min_sol_lamports = terms.voted_min_sol_lamports;
    receipt.execution_min_sol_lamports = terms.execution_min_sol_lamports;
    receipt.actual_sol_forwarded_lamports = actual_forwarded;
    receipt.wsol_ata_rent_returned_lamports = wsol_rent;
    receipt.executed_at = now;
    receipt.bump = ctx.bumps.receipt;
    ctx.accounts.proposal.status = STATUS_EXECUTED;
    ctx.accounts.config.committed_reserve_raw_mstrx = 0;
    ctx.accounts.config.active_proposal_id = 0;
    Ok(())
}

fn checked_wsol_state_after_close(account: &AccountInfo) -> Result<u64> {
    require!(
        account.lamports() == 0 && *account.owner == system_program::ID && account.data_is_empty(),
        MarketingSaleError::ConservationMismatch
    );
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FrozenOption, NO_WINNING_OPTION};

    fn fixture() -> (Pubkey, Config, Proposal) {
        let config_key = Pubkey::new_unique();
        let reserve_vault = Pubkey::new_unique();
        let capital = Pubkey::new_unique();
        let marketing = Pubkey::new_unique();
        let config = Config {
            schema_version: SCHEMA_VERSION,
            admin: Pubkey::new_unique(),
            capital_mint: capital,
            capital_token_program: token::ID,
            reserve_mint: MSTRX_MINT,
            reserve_vault,
            marketing_wallet: marketing,
            launched_at: 1,
            launch_slot: 1,
            launch_signature: [0; 64],
            last_proposal_id: 4,
            active_proposal_id: 4,
            committed_reserve_raw_mstrx: 100,
            bump: 1,
        };
        let proposal = Proposal {
            schema_version: SCHEMA_VERSION,
            config: config_key,
            capital_mint: capital,
            reserve_vault,
            id: 4,
            starts_at: 1,
            ends_at: 2,
            executable_at: 302,
            window_start: 0,
            window_end: 1,
            finalized_through_slot: 1,
            finalized_blockhash: [1; 32],
            exclusions_hash: [1; 32],
            merkle_root: [1; 32],
            leaf_count: 1,
            total_available_weight: 1,
            frozen_reserve_raw_mstrx: 100,
            options: vec![FrozenOption {
                action: ReserveAction::MarketingSale,
                lock_duration_seconds: 0,
                recipient: marketing,
                reserve_raw_mstrx: 100,
                min_output_raw: 50,
            }],
            option_weights: [0; 6],
            total_cast: 1,
            status: STATUS_PASSED_NOT_EXECUTED,
            winning_option: 0,
            bump: 1,
        };
        (config_key, config, proposal)
    }

    #[test]
    fn marketing_terms_bind_winner_commitment_floor_and_recipient() {
        let (key, mut c, mut p) = fixture();
        let terms = validate_marketing_sale_terms(key, &c, &p, 302, 120, 51).unwrap();
        assert_eq!(terms.committed_mstrx_raw, 100);
        assert_eq!(terms.voted_min_sol_lamports, 50);
        assert_eq!(terms.recipient, c.marketing_wallet);
        assert_eq!(
            validate_marketing_sale_terms(key, &c, &p, 301, 120, 51),
            Err(MarketingGuardError::UnfinalizedDecision)
        );
        assert_eq!(
            validate_marketing_sale_terms(key, &c, &p, 302, 120, 49),
            Err(MarketingGuardError::InvalidVotedFloor)
        );
        p.options[0].recipient = Pubkey::new_unique();
        assert_eq!(
            validate_marketing_sale_terms(key, &c, &p, 302, 120, 50),
            Err(MarketingGuardError::InvalidRecipient)
        );
        p.options[0].recipient = c.marketing_wallet;
        c.committed_reserve_raw_mstrx = 99;
        assert_eq!(
            validate_marketing_sale_terms(key, &c, &p, 302, 120, 50),
            Err(MarketingGuardError::CommitmentMismatch)
        );
        c.committed_reserve_raw_mstrx = 100;
        p.winning_option = NO_WINNING_OPTION;
        assert_eq!(
            validate_marketing_sale_terms(key, &c, &p, 302, 120, 50),
            Err(MarketingGuardError::UnfinalizedDecision)
        );
    }

    fn balances() -> MarketingSaleBalances {
        MarketingSaleBalances {
            reserve_before: 120,
            reserve_after_funding: 20,
            trader_mstrx_before: 0,
            trader_mstrx_after_funding: 100,
            trader_mstrx_after_swap: 0,
            trader_wsol_before: 0,
            trader_wsol_after_swap: 60,
            trader_wsol_after_close: 0,
            wsol_account_rent_lamports: 5,
            trader_sol_before_close: 10,
            trader_sol_after_close: 75,
            trader_sol_after_forward: 15,
            recipient_sol_before: 20,
            recipient_sol_after: 80,
        }
    }

    #[test]
    fn full_sale_preserves_late_deposits_and_keeps_rent_out_of_proceeds() {
        let (key, c, p) = fixture();
        assert_eq!(
            validate_marketing_sale_terms(key, &c, &p, 302, 99, 50),
            Err(MarketingGuardError::CommitmentMismatch)
        );
        let terms = validate_marketing_sale_terms(key, &c, &p, 302, 120, 50).unwrap();
        assert_eq!(
            validate_marketing_sale_conservation(terms, balances()),
            Ok(60)
        );
        let mut b = balances();
        b.trader_mstrx_after_swap = 1;
        assert_eq!(
            validate_marketing_sale_conservation(terms, b),
            Err(MarketingGuardError::BalanceMismatch)
        );
        let mut b = balances();
        b.trader_sol_after_forward = 10;
        assert_eq!(
            validate_marketing_sale_conservation(terms, b),
            Err(MarketingGuardError::BalanceMismatch)
        );
        let mut b = balances();
        b.recipient_sol_after = 79;
        assert_eq!(
            validate_marketing_sale_conservation(terms, b),
            Err(MarketingGuardError::BalanceMismatch)
        );
        let mut b = balances();
        b.trader_wsol_after_swap = 49;
        assert_eq!(
            validate_marketing_sale_conservation(terms, b),
            Err(MarketingGuardError::BalanceMismatch)
        );
        let mut b = balances();
        b.reserve_after_funding = 21;
        assert_eq!(
            validate_marketing_sale_conservation(terms, b),
            Err(MarketingGuardError::BalanceMismatch)
        );
    }

    #[test]
    fn donated_trader_ata_balances_cannot_block_sale_or_be_counted_as_proceeds() {
        let (key, c, p) = fixture();
        let terms = validate_marketing_sale_terms(key, &c, &p, 302, 120, 50).unwrap();
        let mut b = balances();
        b.trader_mstrx_before = 3;
        b.trader_mstrx_after_funding = 103;
        b.trader_mstrx_after_swap = 3;
        b.trader_wsol_before = 2;
        b.trader_wsol_after_swap = 62;
        b.trader_sol_after_close = 77;
        b.trader_sol_after_forward = 17;
        assert_eq!(validate_marketing_sale_conservation(terms, b), Ok(60));

        // A swap that spends a donor's MSTRx or forwards pre-existing WSOL
        // must fail, even if the minimum output would otherwise be met.
        b.trader_mstrx_after_swap = 2;
        assert_eq!(
            validate_marketing_sale_conservation(terms, b),
            Err(MarketingGuardError::BalanceMismatch)
        );
        b.trader_mstrx_after_swap = 3;
        b.trader_sol_after_forward = 16;
        assert_eq!(
            validate_marketing_sale_conservation(terms, b),
            Err(MarketingGuardError::BalanceMismatch)
        );
    }

    #[test]
    fn exact_market_pdas_and_tick_array_direction_are_pinned() {
        assert_eq!(
            Pubkey::find_program_address(
                &[
                    b"pool",
                    AMM_CONFIG.as_ref(),
                    WSOL.as_ref(),
                    MSTRX_MINT.as_ref()
                ],
                &CLMM
            )
            .0,
            POOL,
        );
        let trader = Pubkey::find_program_address(&[TRADER_SEED], &crate::ID).0;
        assert_ne!(trader, crate::ID);
        assert_ne!(
            trader_ata(trader, WSOL, token::ID),
            trader_ata(trader, MSTRX_MINT, token_2022::ID)
        );
        let negative_start = (-1i32).div_euclid(3600) * 3600;
        assert_eq!(negative_start, -3600);
    }

    #[test]
    fn swap_v2_cpi_is_fixed_exact_input_and_can_only_raise_voted_floor() {
        let trader = Pubkey::find_program_address(&[TRADER_SEED], &crate::ID).0;
        let start = -28_800i32;
        let tick = Pubkey::find_program_address(
            &[b"tick_array", POOL.as_ref(), &start.to_be_bytes()],
            &CLMM,
        )
        .0;
        let ix = pinned_marketing_swap_instruction(trader, 123, 57, &[tick]).unwrap();
        assert_eq!(ix.program_id, CLMM);
        assert_eq!(ix.accounts.len(), 15);
        assert_eq!(ix.accounts[0], AccountMeta::new_readonly(trader, true));
        assert_eq!(
            ix.accounts[3].pubkey,
            trader_ata(trader, MSTRX_MINT, token_2022::ID)
        );
        assert_eq!(ix.accounts[4].pubkey, trader_ata(trader, WSOL, token::ID));
        assert_eq!(
            ix.accounts[13].pubkey,
            Pubkey::find_program_address(
                &[b"pool_tick_array_bitmap_extension", POOL.as_ref()],
                &CLMM
            )
            .0
        );
        assert_eq!(ix.accounts[14].pubkey, tick);
        assert_eq!(&ix.data[..8], &swap_v2_discriminator());
        assert_eq!(&ix.data[8..16], &123u64.to_le_bytes());
        assert_eq!(&ix.data[16..24], &57u64.to_le_bytes());
        assert_eq!(&ix.data[24..40], &[0u8; 16]);
        assert_eq!(ix.data[40], 1);
        assert!(pinned_marketing_swap_instruction(trader, 0, 57, &[tick]).is_err());
        assert!(pinned_marketing_swap_instruction(trader, 123, 0, &[tick]).is_err());
        assert!(pinned_marketing_swap_instruction(trader, 123, 57, &[]).is_err());
        assert!(pinned_marketing_swap_instruction(Pubkey::new_unique(), 123, 57, &[tick]).is_err());
    }

    #[test]
    fn receipt_layout_and_independent_release_gate_are_explicit() {
        assert!(!MARKETING_SALE_EXECUTOR_RELEASED);
        let receipt = MarketingSaleReceipt {
            schema_version: SCHEMA_VERSION,
            action: ReserveAction::MarketingSale as u8,
            proposal: Pubkey::new_unique(),
            config: Pubkey::new_unique(),
            reserve_mint: MSTRX_MINT,
            reserve_vault: Pubkey::new_unique(),
            recipient: Pubkey::new_unique(),
            pool: POOL,
            input_mstrx_raw: 123,
            voted_min_sol_lamports: 45,
            execution_min_sol_lamports: 56,
            actual_sol_forwarded_lamports: 67,
            wsol_ata_rent_returned_lamports: 78,
            executed_at: 90,
            bump: 9,
        };
        let mut bytes = Vec::new();
        receipt.try_serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), MarketingSaleReceipt::SPACE);
        assert_eq!(bytes[8], SCHEMA_VERSION);
        assert_eq!(bytes[9], 5);
        assert_eq!(&bytes[74..106], MSTRX_MINT.as_ref());
        assert_eq!(&bytes[170..202], POOL.as_ref());
        assert_eq!(&bytes[202..210], &123u64.to_le_bytes());
        assert_eq!(&bytes[210..218], &45u64.to_le_bytes());
        assert_eq!(&bytes[218..226], &56u64.to_le_bytes());
        assert_eq!(&bytes[226..234], &67u64.to_le_bytes());
        assert_eq!(&bytes[234..242], &78u64.to_le_bytes());
        assert_eq!(&bytes[242..250], &90i64.to_le_bytes());
        assert_eq!(bytes[250], 9);
    }

    fn view(
        key: Pubkey,
        owner: Pubkey,
        writable: bool,
        executable: bool,
        data: Vec<u8>,
    ) -> AccountView<'static> {
        AccountView {
            key,
            owner,
            writable,
            executable,
            data: Box::leak(data.into_boxed_slice()),
        }
    }

    fn layout_data(len: usize, name: &str) -> Vec<u8> {
        let mut data = vec![0; len];
        data[..8].copy_from_slice(&discriminator(name));
        data
    }

    fn token_data(mint: Pubkey, owner: Pubkey, amount: u64, native: bool) -> Vec<u8> {
        let mut data = vec![0; 165];
        data[..32].copy_from_slice(mint.as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data[108] = 1;
        if native {
            data[109..113].copy_from_slice(&1u32.to_le_bytes());
        }
        data
    }

    fn mint_data(decimals: u8) -> Vec<u8> {
        let mut data = vec![0; 82];
        data[44] = decimals;
        data[45] = 1;
        data
    }

    fn route_fixture(recipient: Pubkey) -> MarketingClmmViews<'static> {
        let trader = Pubkey::find_program_address(&[TRADER_SEED], &crate::ID).0;
        let mut pool = layout_data(POOL_LEN, "PoolState");
        let bump = Pubkey::find_program_address(
            &[
                b"pool",
                AMM_CONFIG.as_ref(),
                WSOL.as_ref(),
                MSTRX_MINT.as_ref(),
            ],
            &CLMM,
        )
        .1;
        pool[8] = bump;
        for (offset, key) in [
            (9, AMM_CONFIG),
            (73, WSOL),
            (105, MSTRX_MINT),
            (137, WSOL_VAULT),
            (169, MSTRX_VAULT),
            (201, OBSERVATION),
        ] {
            pool[offset..offset + 32].copy_from_slice(key.as_ref());
        }
        pool[233] = 9;
        pool[234] = 8;
        pool[235..237].copy_from_slice(&TICK_SPACING.to_le_bytes());
        pool[237] = 1;

        let mut config = layout_data(CONFIG_LEN, "AmmConfig");
        config[51..53].copy_from_slice(&TICK_SPACING.to_le_bytes());
        let mut observation = layout_data(OBSERVATION_LEN, "ObservationState");
        observation[19..51].copy_from_slice(POOL.as_ref());
        let mut bitmap = layout_data(BITMAP_LEN, "TickArrayBitmapExtension");
        bitmap[8..40].copy_from_slice(POOL.as_ref());
        let mut tick = layout_data(TICK_ARRAY_LEN, "TickArrayState");
        tick[8..40].copy_from_slice(POOL.as_ref());
        tick[40..44].copy_from_slice(&0i32.to_le_bytes());
        let tick_address = Pubkey::find_program_address(
            &[b"tick_array", POOL.as_ref(), &0i32.to_be_bytes()],
            &CLMM,
        )
        .0;
        let ticks = Box::leak(vec![view(tick_address, CLMM, true, false, tick)].into_boxed_slice());
        MarketingClmmViews {
            program: view(CLMM, bpf_loader_upgradeable::ID, false, true, {
                let mut data = vec![0; 36];
                data[..4].copy_from_slice(&2u32.to_le_bytes());
                data[4] = 1;
                data
            }),
            pool: view(POOL, CLMM, true, false, pool),
            config: view(AMM_CONFIG, CLMM, false, false, config),
            observation: view(OBSERVATION, CLMM, true, false, observation),
            wsol_mint: view(WSOL, token::ID, false, false, mint_data(9)),
            mstrx_mint: view(MSTRX_MINT, token_2022::ID, false, false, mint_data(8)),
            wsol_vault: view(
                WSOL_VAULT,
                token::ID,
                true,
                false,
                token_data(WSOL, POOL, 1, true),
            ),
            mstrx_vault: view(
                MSTRX_VAULT,
                token_2022::ID,
                true,
                false,
                token_data(MSTRX_MINT, POOL, 1, false),
            ),
            bitmap: view(
                Pubkey::find_program_address(
                    &[b"pool_tick_array_bitmap_extension", POOL.as_ref()],
                    &CLMM,
                )
                .0,
                CLMM,
                true,
                false,
                bitmap,
            ),
            ticks,
            trader: view(trader, system_program::ID, true, false, vec![]),
            trader_mstrx: view(
                trader_ata(trader, MSTRX_MINT, token_2022::ID),
                token_2022::ID,
                true,
                false,
                token_data(MSTRX_MINT, trader, 0, false),
            ),
            trader_wsol: view(
                trader_ata(trader, WSOL, token::ID),
                token::ID,
                true,
                false,
                token_data(WSOL, trader, 0, true),
            ),
            recipient: view(recipient, system_program::ID, true, false, vec![]),
        }
    }

    #[test]
    fn marketing_route_rejects_substituted_pool_trader_recipient_or_tick() {
        let recipient = Pubkey::new_unique();
        let mut route = route_fixture(recipient);
        assert_eq!(validate_pinned_marketing_clmm(&route, recipient), Ok(()));
        route.program.owner = Pubkey::new_unique();
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketAccount)
        );
        route.program.owner = bpf_loader_upgradeable::ID;
        flip(&mut route.program, 4);
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketAccount)
        );
        flip(&mut route.program, 4);
        route.pool.key = Pubkey::new_unique();
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketAccount)
        );
        route.pool.key = POOL;
        route.trader.owner = crate::ID;
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::InvalidTrader)
        );
        route.trader.owner = system_program::ID;
        route.recipient.key = Pubkey::new_unique();
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::InvalidRecipient)
        );
        route.recipient.key = recipient;
        route.bitmap.key = Pubkey::new_unique();
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongTickArray)
        );
        route.bitmap.key = Pubkey::find_program_address(
            &[b"pool_tick_array_bitmap_extension", POOL.as_ref()],
            &CLMM,
        )
        .0;
        route.ticks = Box::leak(
            vec![view(
                Pubkey::new_unique(),
                CLMM,
                true,
                false,
                route.ticks[0].data.to_vec(),
            )]
            .into_boxed_slice(),
        );
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongTickArray)
        );
    }

    fn flip(account: &mut AccountView<'static>, offset: usize) {
        let mut data = account.data.to_vec();
        data[offset] ^= 1;
        account.data = Box::leak(data.into_boxed_slice());
    }

    #[test]
    fn pool_identity_status_liquidity_and_fee_config_fail_closed() {
        let recipient = Pubkey::new_unique();
        for offset in [8, 9, 73, 105, 137, 169, 201, 233, 234, 235, 237, 389, 391] {
            let mut route = route_fixture(recipient);
            if offset == 389 {
                let mut data = route.pool.data.to_vec();
                data[389] = 1 << 4;
                route.pool.data = Box::leak(data.into_boxed_slice());
            } else {
                flip(&mut route.pool, offset);
            }
            assert_eq!(
                validate_pinned_marketing_clmm(&route, recipient),
                Err(MarketingGuardError::WrongMarketLayout),
                "pool offset {offset}"
            );
        }
        let mut route = route_fixture(recipient);
        flip(&mut route.config, 51);
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketLayout)
        );
        let mut route = route_fixture(recipient);
        flip(&mut route.observation, 19);
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketLayout)
        );
    }

    #[test]
    fn vault_mint_trader_ata_and_bitmap_fields_fail_closed() {
        let recipient = Pubkey::new_unique();
        let mut route = route_fixture(recipient);
        route.wsol_mint.owner = token_2022::ID;
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketAccount)
        );
        let mut route = route_fixture(recipient);
        route.mstrx_mint.owner = token::ID;
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketAccount)
        );
        let mut route = route_fixture(recipient);
        flip(&mut route.mstrx_mint, 44);
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketAccount)
        );
        let mut route = route_fixture(recipient);
        flip(&mut route.wsol_mint, 45);
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketAccount)
        );
        let mut route = route_fixture(recipient);
        flip(&mut route.wsol_vault, 0);
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketAccount)
        );
        let mut route = route_fixture(recipient);
        flip(&mut route.mstrx_vault, 32);
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongMarketAccount)
        );
        let mut route = route_fixture(recipient);
        flip(&mut route.trader_mstrx, 64);
        assert_eq!(validate_pinned_marketing_clmm(&route, recipient), Ok(()));
        let mut route = route_fixture(recipient);
        flip(&mut route.trader_wsol, 64);
        assert_eq!(validate_pinned_marketing_clmm(&route, recipient), Ok(()));
        let mut route = route_fixture(recipient);
        flip(&mut route.trader_mstrx, 0);
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::InvalidTrader)
        );
        let mut route = route_fixture(recipient);
        flip(&mut route.trader_wsol, 109);
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::InvalidTrader)
        );
        let mut route = route_fixture(recipient);
        flip(&mut route.bitmap, 8);
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongTickArray)
        );
        let mut route = route_fixture(recipient);
        let mut tick = route.ticks[0].data.to_vec();
        tick[40] = 1; // Wrong alignment and canonical PDA
        route.ticks =
            Box::leak(vec![view(route.ticks[0].key, CLMM, true, false, tick)].into_boxed_slice());
        assert_eq!(
            validate_pinned_marketing_clmm(&route, recipient),
            Err(MarketingGuardError::WrongTickArray)
        );
    }
}
