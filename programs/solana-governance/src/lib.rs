use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::pubkey;
use anchor_lang::system_program;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

mod buyback_execution;
pub(crate) use buyback_execution::{
    __client_accounts_execute_buyback, __client_accounts_release_capital_lock,
};
pub use buyback_execution::{BuybackExecutionReceipt, ExecuteBuyback, ReleaseCapitalLock};

mod marketing_sale;
pub(crate) use marketing_sale::__client_accounts_execute_marketing_sale;
pub use marketing_sale::{ExecuteMarketingSale, MarketingSaleReceipt};

// TEST-ONLY PLACEHOLDER: bytes [0x2a; 32]. There is no matching deployment key.
// Replace before building a deployable artifact. See README.md.
declare_id!("3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh");

const LEAF_DOMAIN: &[u8] = b"flywheel-solana-governance-leaf-v1\0";
const NODE_DOMAIN: &[u8] = b"flywheel-solana-governance-node-v1\0";
const ROOT_DOMAIN: &[u8] = b"flywheel-solana-governance-root-v1\0";
const NETWORK_DOMAIN: &[u8] = b"solana-mainnet-beta\0";
const MIN_DURATION_SECONDS: i64 = 3_600;
const MAX_DURATION_SECONDS: i64 = 43_200;
const EXECUTION_DELAY_SECONDS: i64 = 300;
// An initial proposal publishes the ballot commitment before voting.
const SNAPSHOT_REVIEW_SECONDS: i64 = 86_400;
const MAX_SNAPSHOT_AGE_SECONDS: i64 = 25 * 60;
const LOOKBACK_SECONDS: i64 = 86_400;
const QUORUM_BPS: u128 = 700;
const PERMANENT_LOCK_SECONDS: u32 = 0xffff_ffff;
const MAX_OPTIONS: usize = 6;
const MAX_PROOF_HASHES: usize = 32;
// Distinct from the program-owned config and the Token-2022 MSTRx reserve.
// Pump's buyer must be able to sign a System-account CPI in a future executor.
const TRADER_SEED: &[u8] = b"proposal-trader";
pub const SCHEMA_VERSION: u8 = 3;
// Do not open binding votes until every ballot action has an audited executor.
// A passed but unexecutable action would otherwise freeze the commitment forever.
pub const GOVERNANCE_PROPOSALS_RELEASED: bool = false;
// Executable only after SBF/canary tests and review. Host tests alone do not
// establish Pump CPI, account-rent or Token-2022 compatibility.
pub const BUYBACK_EXECUTOR_RELEASED: bool = false;
// This System PDA can receive admin SOL, but there is not yet an audited
// buyback executor or refund instruction. Do not strand funds there.
pub const BUYBACK_TRADER_FUNDING_RELEASED: bool = false;
pub const MSTRX_MINT: Pubkey = pubkey!("XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ");
const PUMP_PROGRAM: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_SWAP_PROGRAM: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP_FEE_PROGRAM: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const PUMP_CURVE_DISCRIMINATOR: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
const PUMP_GLOBAL_DISCRIMINATOR: [u8; 8] = [167, 232, 232, 177, 200, 108, 114, 127];
const PUMP_SWAP_POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
const PUMP_SWAP_GLOBAL_DISCRIMINATOR: [u8; 8] = [149, 8, 156, 202, 160, 252, 176, 217];
const PUMP_EXACT_QUOTE_BUY_DISCRIMINATOR: [u8; 8] = [194, 171, 28, 70, 104, 77, 91, 47];
const PUMP_SWAP_EXACT_QUOTE_BUY_DISCRIMINATOR: [u8; 8] = [198, 46, 21, 82, 180, 217, 232, 112];
const PUMP_CURVE_WRITABLE: [bool; 27] = [
    false, false, false, false, false, false, true, true, true, true, true, true, true, true, true,
    true, true, true, false, false, true, true, false, false, false, false, false,
];
const PUMP_SWAP_WRITABLE: [bool; 23] = [
    true, true, false, false, false, true, true, true, true, false, true, false, false, false,
    false, false, false, true, false, false, true, false, false,
];

pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_PASSED_NOT_EXECUTED: u8 = 1;
pub const STATUS_REJECTED_NO_QUORUM: u8 = 2;
pub const STATUS_REJECTED_TIE: u8 = 3;
pub const STATUS_EXECUTED: u8 = 4;
pub const STATUS_SUPERSEDED: u8 = 5;
pub const STATUS_ACTIVE_REVOTE: u8 = 6;
pub const STATUS_REVOTE_NO_QUORUM: u8 = 7;
pub const STATUS_REVOTE_TIE: u8 = 8;
pub const NO_WINNING_OPTION: u8 = u8::MAX;
pub const LOCK_ACTIVE: u8 = 0;
pub const LOCK_RELEASED: u8 = 1;

#[program]
pub mod flywheel_solana_governance {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        require!(
            GOVERNANCE_PROPOSALS_RELEASED,
            GovernanceError::ProposalsNotReleased
        );
        require!(
            args.marketing_wallet != Pubkey::default(),
            GovernanceError::InvalidConfig
        );
        validate_mstrx_mint(&ctx.accounts.reserve_mint)?;

        let config = &mut ctx.accounts.config;
        config.schema_version = SCHEMA_VERSION;
        config.admin = ctx.accounts.admin.key();
        config.capital_mint = Pubkey::default();
        config.capital_token_program = Pubkey::default();
        config.reserve_mint = MSTRX_MINT;
        config.reserve_vault = ctx.accounts.reserve_vault.key();
        config.marketing_wallet = args.marketing_wallet;
        config.launched_at = 0;
        config.launch_slot = 0;
        config.launch_signature = [0; 64];
        config.last_proposal_id = 0;
        config.active_proposal_id = 0;
        config.committed_reserve_raw_mstrx = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Add the configured admin's own SOL to the separate buyback trader PDA.
    /// Hard-disabled until the complete buyback and refund routes are verified.
    pub fn fund_trader(ctx: Context<FundTrader>, lamports: u64) -> Result<()> {
        require!(
            BUYBACK_TRADER_FUNDING_RELEASED && BUYBACK_EXECUTOR_RELEASED,
            GovernanceError::TraderFundingNotReleased
        );
        let admin_info = ctx.accounts.admin.to_account_info();
        let trader_info = ctx.accounts.trader.to_account_info();
        let balance_before = trader_info.lamports();
        let balance_after = validate_trader_funding(
            ctx.accounts.config.admin,
            &admin_info,
            &trader_info,
            lamports,
            Rent::get()?.minimum_balance(0),
        )?;

        if balance_before == 0 {
            let bump = [ctx.bumps.trader];
            let seeds: &[&[u8]] = &[TRADER_SEED, &bump];
            let signer_seeds: &[&[&[u8]]] = &[seeds];
            system_program::create_account(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::CreateAccount {
                        from: admin_info,
                        to: trader_info.clone(),
                    },
                    signer_seeds,
                ),
                lamports,
                0,
                &System::id(),
            )?;
        } else {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: admin_info,
                        to: trader_info.clone(),
                    },
                ),
                lamports,
            )?;
        }

        require!(
            trader_info.lamports() == balance_after
                && *trader_info.owner == System::id()
                && trader_info.data_is_empty()
                && !trader_info.executable,
            GovernanceError::InvalidTraderAccount
        );
        emit!(TraderFunded {
            admin: ctx.accounts.admin.key(),
            trader: ctx.accounts.trader.key(),
            deposited_lamports: lamports,
            balance_lamports: balance_after,
        });
        Ok(())
    }

    /// Return only uncommitted, above-rent SOL from the trader PDA to the
    /// configured admin. This route cannot touch MSTRx or an active vote.
    pub fn refund_trader(ctx: Context<RefundTrader>, lamports: u64) -> Result<()> {
        let admin_info = ctx.accounts.admin.to_account_info();
        let trader_info = ctx.accounts.trader.to_account_info();
        let balance_after = validate_trader_refund(
            &ctx.accounts.config,
            &admin_info,
            &trader_info,
            lamports,
            Rent::get()?.minimum_balance(0),
        )?;
        let trader_bump = [ctx.bumps.trader];
        let trader_seeds: &[&[&[u8]]] = &[&[TRADER_SEED, &trader_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: trader_info.clone(),
                    to: admin_info,
                },
                trader_seeds,
            ),
            lamports,
        )?;
        require!(
            trader_info.lamports() == balance_after,
            GovernanceError::InvalidTraderRefund
        );
        emit!(TraderRefunded {
            admin: ctx.accounts.admin.key(),
            trader: ctx.accounts.trader.key(),
            withdrawn_lamports: lamports,
            balance_lamports: balance_after,
        });
        Ok(())
    }

    /// Atomic exact-quote-in buyback. Disabled until both Pump phases, token
    /// custody, rollback and canonical receipt have been proven on a canary.
    pub fn execute_buyback<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteBuyback<'info>>,
    ) -> Result<()> {
        require!(
            BUYBACK_EXECUTOR_RELEASED,
            GovernanceError::BuybackNotReleased
        );
        buyback_execution::execute(ctx)
    }

    /// A matured CAPITAL time lock moves to permanent public custody only.
    pub fn release_capital_lock(ctx: Context<ReleaseCapitalLock>) -> Result<()> {
        require!(
            BUYBACK_EXECUTOR_RELEASED,
            GovernanceError::BuybackNotReleased
        );
        buyback_execution::release(ctx)
    }

    /// Atomic sale of the voted MSTRx reserve into the fixed marketing SOL
    /// receiver. The Raydium route stays independently closed until canary
    /// proof of the exact pool, tick accounts and Token-2022 behavior.
    pub fn execute_marketing_sale<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteMarketingSale<'info>>,
        execution_min_sol_lamports: u64,
    ) -> Result<()> {
        require!(
            marketing_sale::MARKETING_SALE_EXECUTOR_RELEASED,
            marketing_sale::MarketingSaleError::NotReleased
        );
        marketing_sale::execute_marketing_sale(ctx, execution_min_sol_lamports)
    }

    /// Single-use binding. The admin's offchain runner MUST first verify the
    /// exact finalized Pump creation event against two independent RPCs.
    /// A Solana program cannot inspect historical transaction logs here.
    pub fn bind_capital_mint(ctx: Context<BindCapitalMint>, args: BindCapitalArgs) -> Result<()> {
        let clock = Clock::get()?;
        let config = &mut ctx.accounts.config;
        require!(
            config.schema_version == SCHEMA_VERSION,
            GovernanceError::SchemaMismatch
        );
        require_keys_eq!(
            config.admin,
            ctx.accounts.admin.key(),
            GovernanceError::Unauthorized
        );
        require!(
            config.capital_mint == Pubkey::default() && config.launch_slot == 0,
            GovernanceError::AlreadyBound
        );
        require!(
            ctx.accounts.capital_mint.key() != MSTRX_MINT,
            GovernanceError::InvalidCapitalMint
        );
        // The bound token must preserve the advertised buyback hold and lock.
        // Token-2022 issuer powers that can move, pause or reroute custody are
        // not acceptable for CAPITAL, even when currently configured inactive.
        validate_capital_mint_policy(&ctx.accounts.capital_mint)?;
        require!(
            args.launched_at > 0
                && args.launched_at <= clock.unix_timestamp
                && args.launch_slot > 0
                && args.launch_slot <= clock.slot
                && args.launch_signature != [0; 64],
            GovernanceError::InvalidLaunchEvidence
        );

        config.capital_mint = ctx.accounts.capital_mint.key();
        config.capital_token_program = *ctx.accounts.capital_mint.to_account_info().owner;
        config.launched_at = args.launched_at;
        config.launch_slot = args.launch_slot;
        config.launch_signature = args.launch_signature;
        emit!(CapitalMintBound {
            capital_mint: config.capital_mint,
            capital_token_program: config.capital_token_program,
            launch_slot: args.launch_slot,
            launch_signature: args.launch_signature
        });
        Ok(())
    }

    pub fn create_proposal(ctx: Context<CreateProposal>, args: CreateProposalArgs) -> Result<()> {
        require!(
            GOVERNANCE_PROPOSALS_RELEASED,
            GovernanceError::ProposalsNotReleased
        );
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let config = &mut ctx.accounts.config;
        require!(
            config.schema_version == SCHEMA_VERSION,
            GovernanceError::SchemaMismatch
        );
        require!(
            config.capital_mint != Pubkey::default(),
            GovernanceError::CapitalNotBound
        );
        require_keys_eq!(
            config.admin,
            ctx.accounts.admin.key(),
            GovernanceError::Unauthorized
        );
        require!(
            config.active_proposal_id == 0,
            GovernanceError::ProposalAlreadyActive
        );
        require!(
            args.id
                == config
                    .last_proposal_id
                    .checked_add(1)
                    .ok_or(GovernanceError::Overflow)?,
            GovernanceError::ProposalOutOfOrder
        );
        require!(
            (MIN_DURATION_SECONDS..=MAX_DURATION_SECONDS).contains(&args.voting_duration_seconds),
            GovernanceError::InvalidDuration
        );
        require!(
            config.committed_reserve_raw_mstrx == 0,
            GovernanceError::ReserveAlreadyCommitted
        );
        let actual_free = free_reserve_raw(
            ctx.accounts.reserve_vault.amount,
            config.committed_reserve_raw_mstrx,
        )?;
        require!(actual_free > 0, GovernanceError::EmptyReserve);
        require!(
            args.frozen_reserve_raw_mstrx == actual_free,
            GovernanceError::ReserveBalanceChanged
        );
        require!(
            args.total_available_weight > 0 && args.leaf_count > 0,
            GovernanceError::InvalidSnapshot
        );
        require!(
            args.merkle_root != [0; 32],
            GovernanceError::InvalidSnapshot
        );
        require!(
            args.finalized_through_slot > 0
                && args.finalized_through_slot <= clock.slot
                && args.finalized_blockhash != [0; 32],
            GovernanceError::InvalidSnapshot
        );
        validate_snapshot_window(config.launched_at, args.window_start, args.window_end, now)?;

        require_ballot_executors_released(&args.options)?;
        let options = freeze_options(
            &args.options,
            args.frozen_reserve_raw_mstrx,
            &config.marketing_wallet,
        )?;
        let (starts_at, ends_at, executable_at) =
            proposal_schedule(now, args.voting_duration_seconds, SNAPSHOT_REVIEW_SECONDS)?;
        let proposal = &mut ctx.accounts.proposal;
        proposal.schema_version = SCHEMA_VERSION;
        proposal.config = config.key();
        proposal.capital_mint = config.capital_mint;
        proposal.reserve_vault = config.reserve_vault;
        proposal.id = args.id;
        proposal.starts_at = starts_at;
        proposal.ends_at = ends_at;
        proposal.executable_at = executable_at;
        proposal.window_start = args.window_start;
        proposal.window_end = args.window_end;
        proposal.finalized_through_slot = args.finalized_through_slot;
        proposal.finalized_blockhash = args.finalized_blockhash;
        proposal.exclusions_hash = args.exclusions_hash;
        proposal.merkle_root = args.merkle_root;
        proposal.leaf_count = args.leaf_count;
        proposal.total_available_weight = args.total_available_weight;
        proposal.frozen_reserve_raw_mstrx = actual_free;
        proposal.options = options;
        proposal.option_weights = [0; MAX_OPTIONS];
        proposal.total_cast = 0;
        proposal.status = STATUS_ACTIVE;
        proposal.winning_option = NO_WINNING_OPTION;
        proposal.bump = ctx.bumps.proposal;

        config.last_proposal_id = args.id;
        config.active_proposal_id = args.id;
        config.committed_reserve_raw_mstrx = actual_free;
        emit!(ProposalCreated {
            id: args.id,
            proposal: proposal.key(),
            snapshot_root: args.merkle_root,
            committed_reserve_raw_mstrx: actual_free,
            starts_at,
            ends_at,
        });
        Ok(())
    }

    /// Reopens only the exact still-committed amount once a spending winner
    /// can be executed but remains unexecuted. New deposits stay free. The
    /// admin can publish a fresh snapshot/ballot that opens immediately, but
    /// cannot release or spend the commitment without the new holder result.
    pub fn create_revote(ctx: Context<CreateRevote>, args: CreateProposalArgs) -> Result<()> {
        require!(
            GOVERNANCE_PROPOSALS_RELEASED,
            GovernanceError::ProposalsNotReleased
        );
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let config = &mut ctx.accounts.config;
        require!(
            config.schema_version == SCHEMA_VERSION,
            GovernanceError::SchemaMismatch
        );
        require_keys_eq!(
            config.admin,
            ctx.accounts.admin.key(),
            GovernanceError::Unauthorized
        );
        require!(
            args.id
                == config
                    .last_proposal_id
                    .checked_add(1)
                    .ok_or(GovernanceError::Overflow)?,
            GovernanceError::ProposalOutOfOrder
        );
        let previous = &mut ctx.accounts.previous_proposal;
        let committed = revote_terms(
            config,
            &config.key(),
            previous,
            ctx.accounts.reserve_vault.amount,
            now,
        )?;
        require!(
            args.frozen_reserve_raw_mstrx == committed,
            GovernanceError::CommitmentMismatch
        );
        require!(
            (MIN_DURATION_SECONDS..=MAX_DURATION_SECONDS).contains(&args.voting_duration_seconds),
            GovernanceError::InvalidDuration
        );
        require!(
            args.total_available_weight > 0
                && args.leaf_count > 0
                && args.merkle_root != [0; 32]
                && args.finalized_through_slot > 0
                && args.finalized_through_slot <= clock.slot
                && args.finalized_blockhash != [0; 32],
            GovernanceError::InvalidSnapshot
        );
        validate_snapshot_window(config.launched_at, args.window_start, args.window_end, now)?;
        require_ballot_executors_released(&args.options)?;
        let options = freeze_options(&args.options, committed, &config.marketing_wallet)?;
        let (starts_at, ends_at, executable_at) =
            proposal_schedule(now, args.voting_duration_seconds, 0)?;

        let proposal = &mut ctx.accounts.proposal;
        proposal.schema_version = SCHEMA_VERSION;
        proposal.config = config.key();
        proposal.capital_mint = config.capital_mint;
        proposal.reserve_vault = config.reserve_vault;
        proposal.id = args.id;
        proposal.starts_at = starts_at;
        proposal.ends_at = ends_at;
        proposal.executable_at = executable_at;
        proposal.window_start = args.window_start;
        proposal.window_end = args.window_end;
        proposal.finalized_through_slot = args.finalized_through_slot;
        proposal.finalized_blockhash = args.finalized_blockhash;
        proposal.exclusions_hash = args.exclusions_hash;
        proposal.merkle_root = args.merkle_root;
        proposal.leaf_count = args.leaf_count;
        proposal.total_available_weight = args.total_available_weight;
        proposal.frozen_reserve_raw_mstrx = committed;
        proposal.options = options;
        proposal.option_weights = [0; MAX_OPTIONS];
        proposal.total_cast = 0;
        proposal.status = STATUS_ACTIVE_REVOTE;
        proposal.winning_option = NO_WINNING_OPTION;
        proposal.bump = ctx.bumps.proposal;

        let previous_id = previous.id;
        previous.status = STATUS_SUPERSEDED;
        config.last_proposal_id = args.id;
        config.active_proposal_id = args.id;
        // Critically, committed_reserve_raw_mstrx is unchanged here.
        emit!(ProposalRevoteCreated {
            previous_id,
            id: args.id,
            proposal: proposal.key(),
            snapshot_root: args.merkle_root,
            committed_reserve_raw_mstrx: committed,
            starts_at,
            ends_at,
        });
        Ok(())
    }

    /// Admin may withdraw only balance received after a commitment, or all
    /// inventory when no proposal is committed. Destination is the admin ATA.
    pub fn withdraw_free<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawFree<'info>>,
        amount: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        validate_mstrx_mint(&ctx.accounts.reserve_mint)?;
        require!(
            config.schema_version == SCHEMA_VERSION,
            GovernanceError::SchemaMismatch
        );
        require_keys_eq!(
            config.admin,
            ctx.accounts.admin.key(),
            GovernanceError::Unauthorized
        );
        require!(amount > 0, GovernanceError::InvalidWithdrawal);
        require!(
            ctx.remaining_accounts.is_empty(),
            GovernanceError::UnexpectedRemainingAccounts
        );
        let before = ctx.accounts.reserve_vault.amount;
        let free = free_reserve_raw(before, config.committed_reserve_raw_mstrx)?;
        require!(amount <= free, GovernanceError::CommittedReserveProtected);
        let expected_after = before
            .checked_sub(amount)
            .ok_or(GovernanceError::Overflow)?;
        let signer_seeds: &[&[&[u8]]] = &[&[b"config", &[config.bump]]];
        checked_token_transfer(
            &spl_token_2022::ID,
            ctx.accounts.reserve_vault.to_account_info(),
            ctx.accounts.reserve_mint.to_account_info(),
            ctx.accounts.admin_ata.to_account_info(),
            config.to_account_info(),
            amount,
            ctx.accounts.reserve_mint.decimals,
            signer_seeds,
        )?;
        ctx.accounts.reserve_vault.reload()?;
        require!(
            ctx.accounts.reserve_vault.amount == expected_after,
            GovernanceError::ReserveDebitMismatch
        );
        free_reserve_raw(
            ctx.accounts.reserve_vault.amount,
            config.committed_reserve_raw_mstrx,
        )?;
        emit!(FreeReserveWithdrawn {
            admin: config.admin,
            amount,
            vault_balance_after: ctx.accounts.reserve_vault.amount,
            committed_reserve_raw_mstrx: config.committed_reserve_raw_mstrx
        });
        Ok(())
    }

    pub fn cast_vote(ctx: Context<CastVote>, args: CastVoteArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let proposal = &mut ctx.accounts.proposal;
        require!(
            proposal.schema_version == SCHEMA_VERSION,
            GovernanceError::SchemaMismatch
        );
        require!(
            proposal.status == STATUS_ACTIVE || proposal.status == STATUS_ACTIVE_REVOTE,
            GovernanceError::ProposalClosed
        );
        require!(
            now >= proposal.starts_at && now < proposal.ends_at,
            GovernanceError::VotingClosed
        );
        let option_index = usize::from(args.option_index);
        require!(
            option_index < proposal.options.len(),
            GovernanceError::InvalidOption
        );
        require!(args.weight > 0, GovernanceError::InvalidWeight);
        require!(
            args.proof.len() <= MAX_PROOF_HASHES,
            GovernanceError::ProofTooLong
        );
        require!(
            verify_snapshot_proof(
                proposal,
                &ctx.accounts.voter.key(),
                args.weight,
                &args.proof
            ),
            GovernanceError::InvalidProof
        );

        let next_cast = proposal
            .total_cast
            .checked_add(args.weight)
            .ok_or(GovernanceError::Overflow)?;
        require!(
            next_cast <= proposal.total_available_weight,
            GovernanceError::WeightExceeded
        );
        proposal.option_weights[option_index] = proposal.option_weights[option_index]
            .checked_add(args.weight)
            .ok_or(GovernanceError::Overflow)?;
        proposal.total_cast = next_cast;

        let record = &mut ctx.accounts.vote_record;
        record.proposal = proposal.key();
        record.voter = ctx.accounts.voter.key();
        record.option_index = args.option_index;
        record.weight = args.weight;
        record.bump = ctx.bumps.vote_record;
        emit!(VoteRecorded {
            proposal: proposal.key(),
            voter: record.voter,
            option_index: args.option_index,
            weight: args.weight,
        });
        Ok(())
    }

    /// Finalizes the vote count only. No reserve asset is spent or moved.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let proposal = &mut ctx.accounts.proposal;
        require!(
            proposal.schema_version == SCHEMA_VERSION,
            GovernanceError::SchemaMismatch
        );
        require!(
            proposal.status == STATUS_ACTIVE || proposal.status == STATUS_ACTIVE_REVOTE,
            GovernanceError::ProposalClosed
        );
        require!(
            now >= proposal.executable_at,
            GovernanceError::ExecutionDelay
        );
        require!(
            ctx.accounts.config.active_proposal_id == proposal.id,
            GovernanceError::ProposalNotActive
        );

        let (vote_status, winner) = settle_vote(
            &proposal.option_weights[..proposal.options.len()],
            proposal.total_cast,
            proposal.total_available_weight,
        )?;
        let (status, next_committed, next_active) = ballot_finalization_transition(
            proposal.status,
            vote_status,
            winner,
            &proposal.options,
            ctx.accounts.config.committed_reserve_raw_mstrx,
            proposal.frozen_reserve_raw_mstrx,
            proposal.id,
        )?;
        proposal.status = status;
        proposal.winning_option = winner.unwrap_or(NO_WINNING_OPTION);
        ctx.accounts.config.committed_reserve_raw_mstrx = next_committed;
        ctx.accounts.config.active_proposal_id = next_active;
        emit!(ProposalFinalized {
            id: proposal.id,
            proposal: proposal.key(),
            status,
            winning_option: proposal.winning_option,
            total_cast: proposal.total_cast,
        });
        Ok(())
    }

    /// Anyone may execute a finalized LOCK_MSTRX decision. The exact amount
    /// committed when the proposal was created moves to a proposal-specific
    /// Token-2022 ATA; later reserve deposits remain in the main vault.
    pub fn execute_lock_mstrx<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteLockMstrx<'info>>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_mstrx_mint(&ctx.accounts.reserve_mint)?;
        require!(
            ctx.remaining_accounts.is_empty(),
            GovernanceError::UnexpectedRemainingAccounts
        );
        let config = &mut ctx.accounts.config;
        let proposal = &mut ctx.accounts.proposal;
        let (amount, duration_seconds, release_at) =
            lock_execution_terms(config, proposal, ctx.accounts.reserve_vault.amount, now)?;
        // An ATA can be pre-created or donated to by any wallet. Idempotent
        // creation prevents a third party from blocking proposal execution.
        associated_token::create_idempotent(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: ctx.accounts.payer.to_account_info(),
                associated_token: ctx.accounts.lock_vault.to_account_info(),
                authority: ctx.accounts.lock_record.to_account_info(),
                mint: ctx.accounts.reserve_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
        let lock_vault_info = ctx.accounts.lock_vault.to_account_info();
        let reserve_before = ctx.accounts.reserve_vault.amount;
        let escrow_before = token_2022_balance(
            &lock_vault_info,
            &MSTRX_MINT,
            &ctx.accounts.lock_record.key(),
        )?;
        free_reserve_raw(reserve_before, amount)?;
        let reserve_after = reserve_before
            .checked_sub(amount)
            .ok_or(GovernanceError::Overflow)?;
        let escrow_after = escrow_before
            .checked_add(amount)
            .ok_or(GovernanceError::Overflow)?;
        let config_bump = config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"config", &[config_bump]]];
        checked_token_transfer(
            &spl_token_2022::ID,
            ctx.accounts.reserve_vault.to_account_info(),
            ctx.accounts.reserve_mint.to_account_info(),
            lock_vault_info.clone(),
            config.to_account_info(),
            amount,
            ctx.accounts.reserve_mint.decimals,
            signer_seeds,
        )?;
        ctx.accounts.reserve_vault.reload()?;
        let actual_escrow_after = token_2022_balance(
            &lock_vault_info,
            &MSTRX_MINT,
            &ctx.accounts.lock_record.key(),
        )?;
        require!(
            ctx.accounts.reserve_vault.amount == reserve_after
                && actual_escrow_after == escrow_after,
            GovernanceError::LockTransferMismatch
        );
        let record = &mut ctx.accounts.lock_record;
        record.proposal = proposal.key();
        record.config = config.key();
        record.reserve_vault = config.reserve_vault;
        record.escrow_vault = ctx.accounts.lock_vault.key();
        record.amount = amount;
        record.locked_at = now;
        record.release_at = release_at;
        record.duration_seconds = duration_seconds;
        record.status = LOCK_ACTIVE;
        record.bump = ctx.bumps.lock_record;
        proposal.status = STATUS_EXECUTED;
        config.committed_reserve_raw_mstrx = 0;
        config.active_proposal_id = 0;
        emit!(ReserveMstrxLocked {
            proposal: proposal.key(),
            lock_record: record.key(),
            escrow_vault: record.escrow_vault,
            amount,
            escrow_balance_after: escrow_after,
            locked_at: now,
            release_at,
            duration_seconds: record.duration_seconds,
        });
        Ok(())
    }

    /// Timed locks return to the canonical reserve vault only after maturity.
    /// Permanent locks have no release path. Any payer may submit this call.
    pub fn release_lock_mstrx<'info>(
        ctx: Context<'_, '_, '_, 'info, ReleaseLockMstrx<'info>>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_mstrx_mint(&ctx.accounts.reserve_mint)?;
        require!(
            ctx.remaining_accounts.is_empty(),
            GovernanceError::UnexpectedRemainingAccounts
        );
        let record = &mut ctx.accounts.lock_record;
        let escrow_before = ctx.accounts.lock_vault.amount;
        let reserve_before = ctx.accounts.reserve_vault.amount;
        validate_lock_release(record, escrow_before, now)?;
        let reserve_after = reserve_before
            .checked_add(escrow_before)
            .ok_or(GovernanceError::Overflow)?;
        let proposal_key = record.proposal;
        let record_bump = record.bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"reserve-lock", proposal_key.as_ref(), &[record_bump]]];
        checked_token_transfer(
            &spl_token_2022::ID,
            ctx.accounts.lock_vault.to_account_info(),
            ctx.accounts.reserve_mint.to_account_info(),
            ctx.accounts.reserve_vault.to_account_info(),
            record.to_account_info(),
            escrow_before,
            ctx.accounts.reserve_mint.decimals,
            signer_seeds,
        )?;
        ctx.accounts.lock_vault.reload()?;
        ctx.accounts.reserve_vault.reload()?;
        require!(
            ctx.accounts.lock_vault.amount == 0
                && ctx.accounts.reserve_vault.amount == reserve_after,
            GovernanceError::LockTransferMismatch
        );
        let committed_amount = record.amount;
        let proposal = record.proposal;
        record.status = LOCK_RELEASED;
        emit!(ReserveMstrxLockReleased {
            proposal,
            lock_record: record.key(),
            committed_amount,
            released_amount: escrow_before,
            released_at: now,
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub marketing_wallet: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BindCapitalArgs {
    pub launched_at: i64,
    pub launch_slot: u64,
    pub launch_signature: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateProposalArgs {
    pub id: u64,
    pub voting_duration_seconds: i64,
    pub window_start: i64,
    pub window_end: i64,
    pub finalized_through_slot: u64,
    pub finalized_blockhash: [u8; 32],
    pub exclusions_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub leaf_count: u64,
    pub total_available_weight: u128,
    pub frozen_reserve_raw_mstrx: u64,
    pub options: Vec<ProposedOption>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CastVoteArgs {
    pub option_index: u8,
    pub weight: u128,
    pub proof: Vec<[u8; 32]>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReserveAction {
    Accumulate,
    BuybackHold,
    BuybackBurn,
    BuybackLock,
    LockMstrx,
    MarketingSale,
}

impl ReserveAction {
    fn index(self) -> usize {
        self as usize
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposedOption {
    pub action: ReserveAction,
    pub lock_duration_seconds: u32,
    pub recipient: Pubkey,
    /// CAPITAL raw units for buybacks; lamports for a marketing sale; otherwise zero.
    pub min_output_raw: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FrozenOption {
    pub action: ReserveAction,
    pub lock_duration_seconds: u32,
    pub recipient: Pubkey,
    pub reserve_raw_mstrx: u64,
    /// Immutable floor chosen before holders vote; execution may demand more, never less.
    pub min_output_raw: u64,
}

#[account]
pub struct Config {
    pub schema_version: u8,
    pub admin: Pubkey,
    pub capital_mint: Pubkey,
    pub capital_token_program: Pubkey,
    pub reserve_mint: Pubkey,
    pub reserve_vault: Pubkey,
    pub marketing_wallet: Pubkey,
    pub launched_at: i64,
    pub launch_slot: u64,
    pub launch_signature: [u8; 64],
    pub last_proposal_id: u64,
    pub active_proposal_id: u64,
    pub committed_reserve_raw_mstrx: u64,
    pub bump: u8,
}

impl Config {
    pub const SPACE: usize = 8 + 1 + 32 * 6 + 8 * 5 + 64 + 1;
}

#[account]
pub struct Proposal {
    pub schema_version: u8,
    pub config: Pubkey,
    pub capital_mint: Pubkey,
    pub reserve_vault: Pubkey,
    pub id: u64,
    pub starts_at: i64,
    pub ends_at: i64,
    pub executable_at: i64,
    pub window_start: i64,
    pub window_end: i64,
    pub finalized_through_slot: u64,
    pub finalized_blockhash: [u8; 32],
    pub exclusions_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub leaf_count: u64,
    pub total_available_weight: u128,
    pub frozen_reserve_raw_mstrx: u64,
    pub options: Vec<FrozenOption>,
    pub option_weights: [u128; MAX_OPTIONS],
    pub total_cast: u128,
    pub status: u8,
    pub winning_option: u8,
    pub bump: u8,
}

impl Proposal {
    // Borsh layout (no padding); six options at most, 53 bytes each.
    pub const SPACE: usize =
        8 + 1 + 32 * 3 + 8 * 8 + 32 * 3 + 8 + 16 + 4 + MAX_OPTIONS * 53 + MAX_OPTIONS * 16 + 16 + 3;
}

#[account]
pub struct VoteRecord {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub option_index: u8,
    pub weight: u128,
    pub bump: u8,
}

impl VoteRecord {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 16 + 1;
}

#[account]
pub struct LockRecord {
    pub proposal: Pubkey,
    pub config: Pubkey,
    pub reserve_vault: Pubkey,
    pub escrow_vault: Pubkey,
    pub amount: u64,
    pub locked_at: i64,
    /// Zero is the permanent-lock sentinel; a timed lock stores its maturity.
    pub release_at: i64,
    pub duration_seconds: u32,
    pub status: u8,
    pub bump: u8,
}

impl LockRecord {
    pub const SPACE: usize = 8 + 32 * 4 + 8 * 3 + 4 + 2;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = Config::SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(address = MSTRX_MINT, constraint = *reserve_mint.to_account_info().owner
        == spl_token_2022::ID @ GovernanceError::InvalidReserveMint)]
    pub reserve_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = admin, associated_token::mint = reserve_mint,
        associated_token::authority = config, associated_token::token_program = token_program)]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key())
        @ GovernanceError::Unauthorized)]
    pub program: Program<'info, crate::program::FlywheelSolanaGovernance>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key())
        @ GovernanceError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    #[account(address = spl_token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundTrader<'info> {
    #[account(seeds = [b"config"], bump = config.bump,
        constraint = config.schema_version == SCHEMA_VERSION @ GovernanceError::SchemaMismatch,
        has_one = admin @ GovernanceError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: canonical PDA, System ownership, zero data and non-executable state
    /// are all checked by validate_trader_funding before any SOL is transferred.
    #[account(mut, seeds = [TRADER_SEED], bump)]
    pub trader: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundTrader<'info> {
    #[account(seeds = [b"config"], bump = config.bump,
        constraint = config.schema_version == SCHEMA_VERSION @ GovernanceError::SchemaMismatch,
        has_one = admin @ GovernanceError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: canonical PDA and System state are checked before transfer.
    #[account(mut, seeds = [TRADER_SEED], bump)]
    pub trader: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BindCapitalMint<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub capital_mint: InterfaceAccount<'info, Mint>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: CreateProposalArgs)]
pub struct CreateProposal<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(address = config.reserve_vault,
        constraint = reserve_vault.mint == MSTRX_MINT @ GovernanceError::InvalidReserveVault,
        constraint = reserve_vault.owner == config.key() @ GovernanceError::InvalidReserveVault,
        constraint = *reserve_vault.to_account_info().owner == spl_token_2022::ID
            @ GovernanceError::InvalidReserveVault)]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = admin, space = Proposal::SPACE,
        seeds = [b"proposal", &args.id.to_le_bytes()], bump)]
    pub proposal: Account<'info, Proposal>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key())
        @ GovernanceError::InvalidProgramData)]
    pub program: Program<'info, crate::program::FlywheelSolanaGovernance>,
    #[account(constraint = program_data.upgrade_authority_address.is_none()
        @ GovernanceError::ProgramStillUpgradeable)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: CreateProposalArgs)]
pub struct CreateRevote<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(address = config.reserve_vault,
        constraint = reserve_vault.mint == MSTRX_MINT @ GovernanceError::InvalidReserveVault,
        constraint = reserve_vault.owner == config.key() @ GovernanceError::InvalidReserveVault,
        constraint = *reserve_vault.to_account_info().owner == spl_token_2022::ID
            @ GovernanceError::InvalidReserveVault)]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"proposal", &previous_proposal.id.to_le_bytes()],
        bump = previous_proposal.bump, has_one = config, has_one = reserve_vault)]
    pub previous_proposal: Account<'info, Proposal>,
    #[account(init, payer = admin, space = Proposal::SPACE,
        seeds = [b"proposal", &args.id.to_le_bytes()], bump)]
    pub proposal: Account<'info, Proposal>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key())
        @ GovernanceError::InvalidProgramData)]
    pub program: Program<'info, crate::program::FlywheelSolanaGovernance>,
    #[account(constraint = program_data.upgrade_authority_address.is_none()
        @ GovernanceError::ProgramStillUpgradeable)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut, seeds = [b"proposal", &proposal.id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Account<'info, Proposal>,
    #[account(init, payer = payer, space = VoteRecord::SPACE,
        seeds = [b"vote", proposal.key().as_ref(), voter.key().as_ref()], bump)]
    pub vote_record: Account<'info, VoteRecord>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub voter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"proposal", &proposal.id.to_le_bytes()], bump = proposal.bump,
        has_one = config)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct WithdrawFree<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(address = MSTRX_MINT,
        constraint = *reserve_mint.to_account_info().owner == spl_token_2022::ID
            @ GovernanceError::InvalidReserveMint)]
    pub reserve_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.reserve_vault,
        associated_token::mint = reserve_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program)]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = reserve_mint,
        associated_token::authority = admin,
        associated_token::token_program = token_program)]
    pub admin_ata: InterfaceAccount<'info, TokenAccount>,
    pub admin: Signer<'info>,
    #[account(address = spl_token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ExecuteLockMstrx<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"proposal", &proposal.id.to_le_bytes()], bump = proposal.bump,
        has_one = config, has_one = reserve_vault)]
    pub proposal: Account<'info, Proposal>,
    #[account(address = MSTRX_MINT,
        constraint = *reserve_mint.to_account_info().owner == spl_token_2022::ID
            @ GovernanceError::InvalidReserveMint)]
    pub reserve_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.reserve_vault,
        associated_token::mint = reserve_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program)]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = payer, space = LockRecord::SPACE,
        seeds = [b"reserve-lock", proposal.key().as_ref()], bump)]
    pub lock_record: Account<'info, LockRecord>,
    /// CHECK: canonical Token-2022 ATA is checked by its address here and by
    /// the idempotent ATA creation plus typed TokenAccount parsing in the ix.
    #[account(mut, address = associated_token::get_associated_token_address_with_program_id(
        &lock_record.key(), &MSTRX_MINT, &spl_token_2022::ID)
        @ GovernanceError::InvalidLockVault)]
    pub lock_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = spl_token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseLockMstrx<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"reserve-lock", lock_record.proposal.as_ref()],
        bump = lock_record.bump, has_one = config, has_one = reserve_vault,
        constraint = lock_record.escrow_vault == lock_vault.key()
            @ GovernanceError::InvalidLockVault)]
    pub lock_record: Account<'info, LockRecord>,
    #[account(address = MSTRX_MINT,
        constraint = *reserve_mint.to_account_info().owner == spl_token_2022::ID
            @ GovernanceError::InvalidReserveMint)]
    pub reserve_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.reserve_vault,
        associated_token::mint = reserve_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program)]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = lock_record.escrow_vault,
        associated_token::mint = reserve_mint,
        associated_token::authority = lock_record,
        associated_token::token_program = token_program)]
    pub lock_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(address = spl_token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct ProposalCreated {
    pub id: u64,
    pub proposal: Pubkey,
    pub snapshot_root: [u8; 32],
    pub committed_reserve_raw_mstrx: u64,
    pub starts_at: i64,
    pub ends_at: i64,
}

#[event]
pub struct ProposalRevoteCreated {
    pub previous_id: u64,
    pub id: u64,
    pub proposal: Pubkey,
    pub snapshot_root: [u8; 32],
    pub committed_reserve_raw_mstrx: u64,
    pub starts_at: i64,
    pub ends_at: i64,
}

#[event]
pub struct CapitalMintBound {
    pub capital_mint: Pubkey,
    pub capital_token_program: Pubkey,
    pub launch_slot: u64,
    pub launch_signature: [u8; 64],
}

#[event]
pub struct TraderFunded {
    pub admin: Pubkey,
    pub trader: Pubkey,
    pub deposited_lamports: u64,
    pub balance_lamports: u64,
}

#[event]
pub struct TraderRefunded {
    pub admin: Pubkey,
    pub trader: Pubkey,
    pub withdrawn_lamports: u64,
    pub balance_lamports: u64,
}

#[event]
pub struct FreeReserveWithdrawn {
    pub admin: Pubkey,
    pub amount: u64,
    pub vault_balance_after: u64,
    pub committed_reserve_raw_mstrx: u64,
}

#[event]
pub struct VoteRecorded {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub option_index: u8,
    pub weight: u128,
}

#[event]
pub struct ProposalFinalized {
    pub id: u64,
    pub proposal: Pubkey,
    pub status: u8,
    pub winning_option: u8,
    pub total_cast: u128,
}

#[event]
pub struct ReserveMstrxLocked {
    pub proposal: Pubkey,
    pub lock_record: Pubkey,
    pub escrow_vault: Pubkey,
    pub amount: u64,
    pub escrow_balance_after: u64,
    pub locked_at: i64,
    /// Zero denotes a permanent lock.
    pub release_at: i64,
    pub duration_seconds: u32,
}

#[event]
pub struct ReserveMstrxLockReleased {
    pub proposal: Pubkey,
    pub lock_record: Pubkey,
    pub committed_amount: u64,
    pub released_amount: u64,
    pub released_at: i64,
}

fn validate_trader_funding(
    configured_admin: Pubkey,
    admin: &AccountInfo,
    trader: &AccountInfo,
    lamports: u64,
    rent_floor: u64,
) -> Result<u64> {
    let (expected_trader, _) = Pubkey::find_program_address(&[TRADER_SEED], &crate::ID);
    require_keys_eq!(configured_admin, *admin.key, GovernanceError::Unauthorized);
    require!(admin.is_signer, GovernanceError::Unauthorized);
    require!(
        *admin.owner == System::id() && admin.data_is_empty() && !admin.executable,
        GovernanceError::InvalidTraderFundingSource
    );
    require_keys_eq!(
        *trader.key,
        expected_trader,
        GovernanceError::InvalidTraderAccount
    );
    require!(
        *trader.owner == System::id() && trader.data_is_empty() && !trader.executable,
        GovernanceError::InvalidTraderAccount
    );
    require!(lamports > 0, GovernanceError::InvalidTraderDeposit);
    let balance_after = trader
        .lamports()
        .checked_add(lamports)
        .ok_or(GovernanceError::Overflow)?;
    require!(
        balance_after >= rent_floor,
        GovernanceError::TraderBelowRentFloor
    );
    Ok(balance_after)
}

fn validate_trader_refund(
    config: &Config,
    admin: &AccountInfo,
    trader: &AccountInfo,
    lamports: u64,
    rent_floor: u64,
) -> Result<u64> {
    let (expected_trader, _) = Pubkey::find_program_address(&[TRADER_SEED], &crate::ID);
    require_keys_eq!(config.admin, *admin.key, GovernanceError::Unauthorized);
    require!(admin.is_signer, GovernanceError::Unauthorized);
    require!(
        *admin.owner == System::id() && admin.data_is_empty() && !admin.executable,
        GovernanceError::InvalidTraderFundingSource
    );
    require_keys_eq!(
        *trader.key,
        expected_trader,
        GovernanceError::InvalidTraderAccount
    );
    require!(
        *trader.owner == System::id() && trader.data_is_empty() && !trader.executable,
        GovernanceError::InvalidTraderAccount
    );
    require!(
        config.active_proposal_id == 0 && config.committed_reserve_raw_mstrx == 0,
        GovernanceError::TraderRefundCommitted
    );
    let balance_after = trader
        .lamports()
        .checked_sub(lamports)
        .ok_or(GovernanceError::InvalidTraderRefund)?;
    require!(
        lamports > 0 && balance_after >= rent_floor,
        GovernanceError::InvalidTraderRefund
    );
    Ok(balance_after)
}

fn token_2022_balance(info: &AccountInfo, mint: &Pubkey, authority: &Pubkey) -> Result<u64> {
    use spl_token_2022::extension::StateWithExtensions;
    require!(
        *info.owner == spl_token_2022::ID,
        GovernanceError::InvalidLockVault
    );
    let data = info.try_borrow_data()?;
    let parsed = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data)
        .map_err(|_| GovernanceError::InvalidLockVault)?;
    require_keys_eq!(parsed.base.mint, *mint, GovernanceError::InvalidLockVault);
    require_keys_eq!(
        parsed.base.owner,
        *authority,
        GovernanceError::InvalidLockVault
    );
    Ok(parsed.base.amount)
}

fn checked_token_transfer<'info>(
    program: &Pubkey,
    source: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let instruction = spl_token_2022::instruction::transfer_checked(
        program,
        source.key,
        mint.key,
        destination.key,
        authority.key,
        &[],
        amount,
        decimals,
    )?;
    invoke_signed(
        &instruction,
        &[source, mint, destination, authority],
        signer_seeds,
    )?;
    Ok(())
}

fn validate_mstrx_mint(mint: &InterfaceAccount<Mint>) -> Result<()> {
    require_keys_eq!(mint.key(), MSTRX_MINT, GovernanceError::InvalidReserveMint);
    require!(
        *mint.to_account_info().owner == spl_token_2022::ID && mint.decimals == 8,
        GovernanceError::InvalidReserveMint
    );
    validate_supported_mint_extensions(&mint.to_account_info())
}

fn validate_capital_mint_policy(mint: &InterfaceAccount<Mint>) -> Result<()> {
    require!(
        mint.freeze_authority == anchor_lang::solana_program::program_option::COption::None,
        GovernanceError::InvalidCapitalMint
    );
    validate_mint_extensions(&mint.to_account_info(), true)
}

// Anchor 0.31.2 embeds Token-2022 v6, which cannot enumerate the official
// MSTRx mint's later ScaledUiAmount (25) and Pausable (26) TLV variants.
// Walking raw TLV avoids the old enum while still rejecting any new, unsafe
// extension rather than assuming it has no economic effect. Active hooks are
// deliberately unsupported: all reserve CPIs below use the plain checked
// instruction and never omit required hook metas silently.
fn validate_supported_mint_extensions(mint: &AccountInfo) -> Result<()> {
    validate_mint_extensions(mint, false)
}

fn validate_mint_extensions(mint: &AccountInfo, capital: bool) -> Result<()> {
    if *mint.owner != spl_token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    if data.len() == 82 {
        return Ok(());
    }
    require!(
        data.len() >= 166 && data[82..165].iter().all(|byte| *byte == 0) && data[165] == 1,
        GovernanceError::UnsupportedMintExtension
    );
    let mut cursor = 166usize;
    let mut seen = [false; 27];
    while cursor < data.len() {
        require!(
            data.len() - cursor >= 4,
            GovernanceError::UnsupportedMintExtension
        );
        let kind = usize::from(u16::from_le_bytes([data[cursor], data[cursor + 1]]));
        let length = usize::from(u16::from_le_bytes([data[cursor + 2], data[cursor + 3]]));
        if kind == 0 {
            require!(
                data[cursor..].iter().all(|byte| *byte == 0),
                GovernanceError::UnsupportedMintExtension
            );
            break;
        }
        cursor += 4;
        let end = cursor
            .checked_add(length)
            .ok_or(GovernanceError::Overflow)?;
        require!(
            kind < seen.len() && !seen[kind] && end <= data.len(),
            GovernanceError::UnsupportedMintExtension
        );
        seen[kind] = true;
        let value = &data[cursor..end];
        // A permanent delegate can transfer or burn tokens from a PDA-owned
        // hold/lock ATA without the governance program's signature. A transfer
        // hook or pause authority can make a voted action or lock release
        // unexecutable later. MSTRx is an external asset and is checked by its
        // separate compatibility policy; CAPITAL must not carry these powers.
        if capital && matches!(kind, 12 | 14 | 26) {
            return err!(GovernanceError::InvalidCapitalMint);
        }
        match kind {
            1 => return err!(GovernanceError::UnsupportedTransferFee),
            // The observed MSTRx default is Initialized. Reject frozen new ATAs.
            6 => require!(
                length == 1 && value[0] == 1,
                GovernanceError::UnsupportedMintExtension
            ),
            14 => require!(
                length == 64 && value[32..64].iter().all(|byte| *byte == 0),
                GovernanceError::ActiveTransferHook
            ),
            26 => require!(length == 33 && value[32] == 0, GovernanceError::MintPaused),
            // These have no transfer fee, active hook or paused-state semantics.
            // Issuer delegate and metadata powers remain externally controlled.
            // ConfidentialMintBurn (24) is deliberately not in this set.
            3 | 4 | 10 | 12 | 18 | 19 | 21 | 22 | 23 | 25 => {}
            _ => return err!(GovernanceError::UnsupportedMintExtension),
        }
        cursor = end;
    }
    Ok(())
}

fn free_reserve_raw(vault_balance: u64, committed: u64) -> Result<u64> {
    vault_balance
        .checked_sub(committed)
        .ok_or_else(|| GovernanceError::ReserveInsolvent.into())
}

fn proposal_schedule(
    now: i64,
    duration_seconds: i64,
    review_seconds: i64,
) -> Result<(i64, i64, i64)> {
    require!(
        (MIN_DURATION_SECONDS..=MAX_DURATION_SECONDS).contains(&duration_seconds),
        GovernanceError::InvalidDuration
    );
    let starts_at = now
        .checked_add(review_seconds)
        .ok_or(GovernanceError::Overflow)?;
    let ends_at = starts_at
        .checked_add(duration_seconds)
        .ok_or(GovernanceError::Overflow)?;
    let executable_at = ends_at
        .checked_add(EXECUTION_DELAY_SECONDS)
        .ok_or(GovernanceError::Overflow)?;
    Ok((starts_at, ends_at, executable_at))
}

fn validate_snapshot_window(
    launched_at: i64,
    window_start: i64,
    window_end: i64,
    now: i64,
) -> Result<()> {
    let expected_start = std::cmp::max(
        launched_at,
        window_end
            .checked_sub(LOOKBACK_SECONDS)
            .ok_or(GovernanceError::Overflow)?,
    );
    require!(
        window_end > launched_at
            && window_end <= now
            && now - window_end <= MAX_SNAPSHOT_AGE_SECONDS
            && window_start == expected_start,
        GovernanceError::InvalidSnapshotWindow
    );
    Ok(())
}

fn revote_terms(
    config: &Config,
    config_key: &Pubkey,
    previous: &Proposal,
    vault_balance: u64,
    now: i64,
) -> Result<u64> {
    require!(
        previous.schema_version == SCHEMA_VERSION && previous.config == *config_key,
        GovernanceError::SchemaMismatch
    );
    require!(
        config.active_proposal_id == previous.id && config.last_proposal_id == previous.id,
        GovernanceError::ProposalNotActive
    );
    require!(
        matches!(
            previous.status,
            STATUS_PASSED_NOT_EXECUTED | STATUS_REVOTE_NO_QUORUM | STATUS_REVOTE_TIE
        ),
        GovernanceError::RevoteNotAllowed
    );
    if previous.status == STATUS_PASSED_NOT_EXECUTED {
        let winning = previous
            .options
            .get(usize::from(previous.winning_option))
            .ok_or(GovernanceError::InvalidOption)?;
        require!(
            winning.action != ReserveAction::Accumulate
                && winning.reserve_raw_mstrx == previous.frozen_reserve_raw_mstrx,
            GovernanceError::RevoteNotAllowed
        );
    } else {
        require!(
            previous.winning_option == NO_WINNING_OPTION,
            GovernanceError::RevoteNotAllowed
        );
    }
    require!(
        now >= previous.executable_at,
        GovernanceError::RevoteTooEarly
    );
    let amount = previous.frozen_reserve_raw_mstrx;
    require!(
        amount > 0 && config.committed_reserve_raw_mstrx == amount,
        GovernanceError::CommitmentMismatch
    );
    free_reserve_raw(vault_balance, amount)?;
    Ok(amount)
}

fn winning_lock_option(proposal: &Proposal) -> Result<&FrozenOption> {
    require!(
        proposal.status == STATUS_PASSED_NOT_EXECUTED,
        GovernanceError::ProposalNotExecutable
    );
    let option = proposal
        .options
        .get(usize::from(proposal.winning_option))
        .ok_or(GovernanceError::InvalidOption)?;
    require!(
        option.action == ReserveAction::LockMstrx,
        GovernanceError::WrongWinningAction
    );
    require!(
        allowed_lock_duration(option.lock_duration_seconds),
        GovernanceError::InvalidLockDuration
    );
    require!(
        option.recipient == Pubkey::default(),
        GovernanceError::InvalidRecipient
    );
    require!(
        option.min_output_raw == 0,
        GovernanceError::InvalidMinimumOutput
    );
    Ok(option)
}

fn lock_execution_terms(
    config: &Config,
    proposal: &Proposal,
    vault_balance: u64,
    now: i64,
) -> Result<(u64, u32, i64)> {
    require!(
        config.schema_version == SCHEMA_VERSION && proposal.schema_version == SCHEMA_VERSION,
        GovernanceError::SchemaMismatch
    );
    require!(
        config.active_proposal_id == proposal.id && proposal.status == STATUS_PASSED_NOT_EXECUTED,
        GovernanceError::ProposalNotExecutable
    );
    require!(
        now >= proposal.executable_at,
        GovernanceError::ExecutionDelay
    );
    let option = winning_lock_option(proposal)?;
    let amount = proposal.frozen_reserve_raw_mstrx;
    require!(
        amount > 0
            && option.reserve_raw_mstrx == amount
            && config.committed_reserve_raw_mstrx == amount,
        GovernanceError::CommitmentMismatch
    );
    free_reserve_raw(vault_balance, amount)?;
    let release_at = lock_release_at(now, option.lock_duration_seconds)?;
    Ok((amount, option.lock_duration_seconds, release_at))
}

// Shared pre/post-conditions for the gated atomic, venue-pinned buyback CPI.
// They do not by themselves authenticate an arbitrary trade route.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BuybackTerms {
    action: ReserveAction,
    committed_quote_raw: u64,
    voted_min_base_out_raw: u64,
    lock_release_at: i64,
}

#[allow(dead_code)]
fn buyback_execution_terms(
    config: &Config,
    config_key: &Pubkey,
    proposal: &Proposal,
    reserve_balance: u64,
    now: i64,
) -> Result<BuybackTerms> {
    require!(
        config.schema_version == SCHEMA_VERSION && proposal.schema_version == SCHEMA_VERSION,
        GovernanceError::SchemaMismatch
    );
    require!(
        proposal.config == *config_key
            && proposal.reserve_vault == config.reserve_vault
            && proposal.capital_mint == config.capital_mint
            && config.capital_mint != Pubkey::default()
            && config.reserve_mint == MSTRX_MINT,
        GovernanceError::BuybackIdentityMismatch
    );
    require!(
        config.active_proposal_id == proposal.id && proposal.status == STATUS_PASSED_NOT_EXECUTED,
        GovernanceError::ProposalNotExecutable
    );
    require!(
        now >= proposal.executable_at,
        GovernanceError::ExecutionDelay
    );
    let option = proposal
        .options
        .get(usize::from(proposal.winning_option))
        .ok_or(GovernanceError::InvalidOption)?;
    require!(
        matches!(
            option.action,
            ReserveAction::BuybackHold | ReserveAction::BuybackBurn | ReserveAction::BuybackLock
        ),
        GovernanceError::WrongWinningAction
    );
    require!(
        option.recipient == Pubkey::default() && option.min_output_raw > 0,
        GovernanceError::InvalidMinimumOutput
    );
    let lock_release_at = if option.action == ReserveAction::BuybackLock {
        lock_release_at(now, option.lock_duration_seconds)?
    } else {
        require!(
            option.lock_duration_seconds == 0,
            GovernanceError::InvalidLockDuration
        );
        0
    };
    let amount = proposal.frozen_reserve_raw_mstrx;
    require!(
        amount > 0
            && option.reserve_raw_mstrx == amount
            && config.committed_reserve_raw_mstrx == amount,
        GovernanceError::CommitmentMismatch
    );
    free_reserve_raw(reserve_balance, amount)?;
    Ok(BuybackTerms {
        action: option.action,
        committed_quote_raw: amount,
        voted_min_base_out_raw: option.min_output_raw,
        lock_release_at,
    })
}

#[allow(dead_code)]
#[derive(Clone, Copy)]
struct BuybackBalances {
    reserve_before: u64,
    reserve_after: u64,
    trader_quote_before: u64,
    trader_quote_after_funding: u64,
    trader_quote_after_buy: u64,
    trader_base_before: u64,
    trader_base_after_buy: u64,
    trader_base_after_action: u64,
    destination_before: u64,
    destination_after: u64,
    base_supply_before: u64,
    base_supply_after: u64,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BuybackVenue {
    PumpCurve,
    PumpSwap,
}

// Prefix decoders intentionally fail closed when a venue layout or owner does
// not match the reviewed IDL. A future venue CPI must still validate every
// token account's owner/mint/authority and build its own fixed AccountMetas.
#[allow(dead_code)]
#[derive(AnchorSerialize, AnchorDeserialize, Default)]
struct PumpCurveHeader {
    _virtual_token_reserves: u64,
    _virtual_quote_reserves: u64,
    _real_token_reserves: u64,
    _real_quote_reserves: u64,
    _token_total_supply: u64,
    complete: bool,
    creator: Pubkey,
    is_mayhem_mode: bool,
    _is_cashback_coin: bool,
    quote_mint: Pubkey,
}

#[allow(dead_code)]
#[derive(AnchorSerialize, AnchorDeserialize, Default)]
struct PumpGlobalHeader {
    _initialized: bool,
    _authority: Pubkey,
    fee_recipient: Pubkey,
    _initial_virtual_token_reserves: u64,
    _initial_virtual_sol_reserves: u64,
    _initial_real_token_reserves: u64,
    _token_total_supply: u64,
    _fee_basis_points: u64,
    _withdraw_authority: Pubkey,
    _enable_migrate: bool,
    _pool_migration_fee: u64,
    _creator_fee_basis_points: u64,
    fee_recipients: [Pubkey; 7],
    _set_creator_authority: Pubkey,
    _admin_set_creator_authority: Pubkey,
    _create_v2_enabled: bool,
    _whitelist_pda: Pubkey,
    reserved_fee_recipient: Pubkey,
    _mayhem_mode_enabled: bool,
    reserved_fee_recipients: [Pubkey; 7],
    _is_cashback_enabled: bool,
    buyback_fee_recipients: [Pubkey; 8],
}

#[allow(dead_code)]
#[derive(AnchorSerialize, AnchorDeserialize, Default)]
struct PumpSwapPoolHeader {
    _pool_bump: u8,
    index: u16,
    creator: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    _lp_mint: Pubkey,
    pool_base_token_account: Pubkey,
    pool_quote_token_account: Pubkey,
    _lp_supply: u64,
    coin_creator: Pubkey,
}

#[allow(dead_code)]
#[derive(AnchorSerialize, AnchorDeserialize, Default)]
struct PumpSwapGlobalHeader {
    _admin: Pubkey,
    _lp_fee_basis_points: u64,
    _protocol_fee_basis_points: u64,
    _disable_flags: u8,
    protocol_fee_recipients: [Pubkey; 8],
}

#[allow(dead_code)]
fn decode_venue_prefix<T: AnchorDeserialize>(
    account: &AccountInfo,
    owner: Pubkey,
    discriminator: [u8; 8],
) -> Result<T> {
    require_keys_eq!(*account.owner, owner, GovernanceError::InvalidBuybackVenue);
    let data = account.try_borrow_data()?;
    require!(
        data.len() >= 8 && data[..8] == discriminator,
        GovernanceError::InvalidBuybackVenue
    );
    T::deserialize(&mut &data[8..]).map_err(|_| GovernanceError::InvalidBuybackVenue.into())
}

#[allow(dead_code)]
fn venue_pda(program: &Pubkey, seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

#[allow(dead_code)]
fn venue_ata(authority: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    associated_token::get_associated_token_address_with_program_id(authority, mint, token_program)
}

#[allow(dead_code)]
fn validate_buyback_venue_accounts(
    config: &Config,
    curve: &AccountInfo,
    accounts: &[AccountInfo],
) -> Result<BuybackVenue> {
    require!(
        config.capital_mint != Pubkey::default()
            && matches!(
                config.capital_token_program,
                anchor_spl::token::ID | spl_token_2022::ID
            ),
        GovernanceError::InvalidCapitalMint
    );
    let capital = config.capital_mint;
    let base_token_program = config.capital_token_program;
    let quote_token_program = spl_token_2022::ID;
    let trader = venue_pda(&crate::ID, &[TRADER_SEED]);
    let expected_curve = venue_pda(&PUMP_PROGRAM, &[b"bonding-curve", capital.as_ref()]);
    require_keys_eq!(
        *curve.key,
        expected_curve,
        GovernanceError::InvalidBuybackVenue
    );
    let curve_state: PumpCurveHeader =
        decode_venue_prefix(curve, PUMP_PROGRAM, PUMP_CURVE_DISCRIMINATOR)?;
    require_keys_eq!(
        curve_state.quote_mint,
        MSTRX_MINT,
        GovernanceError::InvalidBuybackVenue
    );

    let (phase, expected) = if !curve_state.complete {
        require!(accounts.len() == 27, GovernanceError::InvalidBuybackVenue);
        let global: PumpGlobalHeader =
            decode_venue_prefix(&accounts[0], PUMP_PROGRAM, PUMP_GLOBAL_DISCRIMINATOR)?;
        let fee_recipient = *accounts[6].key;
        let buyback_fee_recipient = *accounts[8].key;
        let allowed_fee = if curve_state.is_mayhem_mode {
            fee_recipient == global.reserved_fee_recipient
                || global.reserved_fee_recipients.contains(&fee_recipient)
        } else {
            fee_recipient == global.fee_recipient || global.fee_recipients.contains(&fee_recipient)
        };
        require!(
            allowed_fee
                && fee_recipient != Pubkey::default()
                && global
                    .buyback_fee_recipients
                    .contains(&buyback_fee_recipient)
                && buyback_fee_recipient != Pubkey::default(),
            GovernanceError::InvalidBuybackVenue
        );
        let creator_vault = venue_pda(
            &PUMP_PROGRAM,
            &[b"creator-vault", curve_state.creator.as_ref()],
        );
        let global_volume = venue_pda(&PUMP_PROGRAM, &[b"global_volume_accumulator"]);
        let user_volume = venue_pda(
            &PUMP_PROGRAM,
            &[b"user_volume_accumulator", trader.as_ref()],
        );
        let expected = vec![
            venue_pda(&PUMP_PROGRAM, &[b"global"]),
            capital,
            MSTRX_MINT,
            base_token_program,
            quote_token_program,
            associated_token::ID,
            fee_recipient,
            venue_ata(&fee_recipient, &MSTRX_MINT, &quote_token_program),
            buyback_fee_recipient,
            venue_ata(&buyback_fee_recipient, &MSTRX_MINT, &quote_token_program),
            expected_curve,
            venue_ata(&expected_curve, &capital, &base_token_program),
            venue_ata(&expected_curve, &MSTRX_MINT, &quote_token_program),
            trader,
            venue_ata(&trader, &capital, &base_token_program),
            venue_ata(&trader, &MSTRX_MINT, &quote_token_program),
            creator_vault,
            venue_ata(&creator_vault, &MSTRX_MINT, &quote_token_program),
            venue_pda(&PUMP_FEE_PROGRAM, &[b"sharing-config", capital.as_ref()]),
            global_volume,
            user_volume,
            venue_ata(&user_volume, &MSTRX_MINT, &quote_token_program),
            venue_pda(&PUMP_FEE_PROGRAM, &[b"fee_config", PUMP_PROGRAM.as_ref()]),
            PUMP_FEE_PROGRAM,
            System::id(),
            venue_pda(&PUMP_PROGRAM, &[b"__event_authority"]),
            PUMP_PROGRAM,
        ];
        (BuybackVenue::PumpCurve, expected)
    } else {
        require!(accounts.len() == 23, GovernanceError::InvalidBuybackVenue);
        let pool: PumpSwapPoolHeader = decode_venue_prefix(
            &accounts[0],
            PUMP_SWAP_PROGRAM,
            PUMP_SWAP_POOL_DISCRIMINATOR,
        )?;
        let global: PumpSwapGlobalHeader = decode_venue_prefix(
            &accounts[2],
            PUMP_SWAP_PROGRAM,
            PUMP_SWAP_GLOBAL_DISCRIMINATOR,
        )?;
        let pool_authority = venue_pda(&PUMP_PROGRAM, &[b"pool-authority", capital.as_ref()]);
        let pool_index = 0u16.to_le_bytes();
        let expected_pool = venue_pda(
            &PUMP_SWAP_PROGRAM,
            &[
                b"pool",
                &pool_index,
                pool_authority.as_ref(),
                capital.as_ref(),
                MSTRX_MINT.as_ref(),
            ],
        );
        require!(
            pool.index == 0
                && pool.creator == pool_authority
                && pool.base_mint == capital
                && pool.quote_mint == MSTRX_MINT
                && pool.pool_base_token_account
                    == venue_ata(&expected_pool, &capital, &base_token_program)
                && pool.pool_quote_token_account
                    == venue_ata(&expected_pool, &MSTRX_MINT, &quote_token_program)
                && *accounts[0].key == expected_pool,
            GovernanceError::InvalidBuybackVenue
        );
        let protocol_recipient = *accounts[9].key;
        require!(
            protocol_recipient != Pubkey::default()
                && global.protocol_fee_recipients.contains(&protocol_recipient),
            GovernanceError::InvalidBuybackVenue
        );
        let creator_vault_authority = venue_pda(
            &PUMP_SWAP_PROGRAM,
            &[b"creator_vault", pool.coin_creator.as_ref()],
        );
        let expected = vec![
            expected_pool,
            trader,
            venue_pda(&PUMP_SWAP_PROGRAM, &[b"global_config"]),
            capital,
            MSTRX_MINT,
            venue_ata(&trader, &capital, &base_token_program),
            venue_ata(&trader, &MSTRX_MINT, &quote_token_program),
            pool.pool_base_token_account,
            pool.pool_quote_token_account,
            protocol_recipient,
            venue_ata(&protocol_recipient, &MSTRX_MINT, &quote_token_program),
            base_token_program,
            quote_token_program,
            System::id(),
            associated_token::ID,
            venue_pda(&PUMP_SWAP_PROGRAM, &[b"__event_authority"]),
            PUMP_SWAP_PROGRAM,
            venue_ata(&creator_vault_authority, &MSTRX_MINT, &quote_token_program),
            creator_vault_authority,
            venue_pda(&PUMP_SWAP_PROGRAM, &[b"global_volume_accumulator"]),
            venue_pda(
                &PUMP_SWAP_PROGRAM,
                &[b"user_volume_accumulator", trader.as_ref()],
            ),
            venue_pda(
                &PUMP_FEE_PROGRAM,
                &[b"fee_config", PUMP_SWAP_PROGRAM.as_ref()],
            ),
            PUMP_FEE_PROGRAM,
        ];
        (BuybackVenue::PumpSwap, expected)
    };
    for (account, key) in accounts.iter().zip(expected.iter()) {
        require_keys_eq!(*account.key, *key, GovernanceError::InvalidBuybackVenue);
    }
    let executable_programs = match phase {
        BuybackVenue::PumpCurve => accounts[23].executable && accounts[26].executable,
        BuybackVenue::PumpSwap => accounts[16].executable && accounts[22].executable,
    };
    require!(executable_programs, GovernanceError::InvalidBuybackVenue);
    Ok(phase)
}

#[allow(dead_code)]
fn pinned_buyback_instruction(
    config: &Config,
    config_key: &Pubkey,
    proposal: &Proposal,
    reserve_balance: u64,
    now: i64,
    curve: &AccountInfo,
    accounts: &[AccountInfo],
) -> Result<(Instruction, BuybackTerms)> {
    let terms = buyback_execution_terms(config, config_key, proposal, reserve_balance, now)?;
    let phase = validate_buyback_venue_accounts(config, curve, accounts)?;
    let (program_id, discriminator, writable, user_index) = match phase {
        BuybackVenue::PumpCurve => (
            PUMP_PROGRAM,
            PUMP_EXACT_QUOTE_BUY_DISCRIMINATOR,
            &PUMP_CURVE_WRITABLE[..],
            13,
        ),
        BuybackVenue::PumpSwap => (
            PUMP_SWAP_PROGRAM,
            PUMP_SWAP_EXACT_QUOTE_BUY_DISCRIMINATOR,
            &PUMP_SWAP_WRITABLE[..],
            1,
        ),
    };
    let metas = accounts
        .iter()
        .zip(writable.iter())
        .enumerate()
        .map(|(index, (account, is_writable))| {
            if *is_writable {
                AccountMeta::new(*account.key, index == user_index)
            } else {
                AccountMeta::new_readonly(*account.key, false)
            }
        })
        .collect();
    let mut data = Vec::with_capacity(if phase == BuybackVenue::PumpCurve {
        24
    } else {
        25
    });
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&terms.committed_quote_raw.to_le_bytes());
    data.extend_from_slice(&terms.voted_min_base_out_raw.to_le_bytes());
    if phase == BuybackVenue::PumpSwap {
        // Exact current IDL OptionBool false: no volume-tracking side effect.
        data.push(0);
    }
    Ok((
        Instruction {
            program_id,
            accounts: metas,
            data,
        },
        terms,
    ))
}

#[allow(dead_code)]
fn validate_buyback_balance_conservation(terms: &BuybackTerms, b: BuybackBalances) -> Result<u64> {
    let expected_reserve_after = b
        .reserve_before
        .checked_sub(terms.committed_quote_raw)
        .ok_or(GovernanceError::BuybackBalanceMismatch)?;
    let expected_quote_funded = b
        .trader_quote_before
        .checked_add(terms.committed_quote_raw)
        .ok_or(GovernanceError::Overflow)?;
    let acquired = b
        .trader_base_after_buy
        .checked_sub(b.trader_base_before)
        .ok_or(GovernanceError::BuybackBalanceMismatch)?;
    require!(
        b.reserve_after == expected_reserve_after
            && b.trader_quote_after_funding == expected_quote_funded
            && b.trader_quote_after_buy == b.trader_quote_before
            && acquired >= terms.voted_min_base_out_raw
            && acquired > 0
            && b.trader_base_after_action == b.trader_base_before,
        GovernanceError::BuybackBalanceMismatch
    );
    if terms.action == ReserveAction::BuybackBurn {
        let expected_supply_after = b
            .base_supply_before
            .checked_sub(acquired)
            .ok_or(GovernanceError::BuybackBalanceMismatch)?;
        require!(
            b.base_supply_after == expected_supply_after
                && b.destination_after == b.destination_before,
            GovernanceError::BuybackBalanceMismatch
        );
    } else {
        require!(
            matches!(
                terms.action,
                ReserveAction::BuybackHold | ReserveAction::BuybackLock
            ),
            GovernanceError::WrongWinningAction
        );
        let expected_destination_after = b
            .destination_before
            .checked_add(acquired)
            .ok_or(GovernanceError::Overflow)?;
        require!(
            b.destination_after == expected_destination_after
                && b.base_supply_after == b.base_supply_before,
            GovernanceError::BuybackBalanceMismatch
        );
    }
    Ok(acquired)
}

fn validate_lock_release(record: &LockRecord, escrow_balance: u64, now: i64) -> Result<()> {
    require!(
        record.status == LOCK_ACTIVE,
        GovernanceError::LockAlreadyReleased
    );
    require!(
        record.duration_seconds != PERMANENT_LOCK_SECONDS && record.release_at > 0,
        GovernanceError::PermanentLock
    );
    require!(now >= record.release_at, GovernanceError::LockNotMature);
    require!(
        escrow_balance >= record.amount && record.amount > 0,
        GovernanceError::LockBalanceChanged
    );
    Ok(())
}

fn lock_release_at(locked_at: i64, duration_seconds: u32) -> Result<i64> {
    require!(
        allowed_lock_duration(duration_seconds),
        GovernanceError::InvalidLockDuration
    );
    if duration_seconds == PERMANENT_LOCK_SECONDS {
        return Ok(0);
    }
    require!(locked_at > 0, GovernanceError::InvalidLaunchTime);
    locked_at
        .checked_add(i64::from(duration_seconds))
        .ok_or_else(|| GovernanceError::Overflow.into())
}

fn finalization_transition(
    vote_status: u8,
    winner: Option<u8>,
    options: &[FrozenOption],
    current: u64,
    frozen: u64,
    proposal_id: u64,
) -> Result<(u8, u64, u64)> {
    require!(
        current == frozen && frozen > 0,
        GovernanceError::CommitmentMismatch
    );
    match vote_status {
        STATUS_REJECTED_NO_QUORUM | STATUS_REJECTED_TIE => {
            require!(winner.is_none(), GovernanceError::InvalidOption);
            Ok((vote_status, 0, 0))
        }
        STATUS_PASSED_NOT_EXECUTED => {
            let winning_index = winner.ok_or(GovernanceError::InvalidOption)?;
            let option = options
                .get(usize::from(winning_index))
                .ok_or(GovernanceError::InvalidOption)?;
            if option.action == ReserveAction::Accumulate {
                require!(
                    option.reserve_raw_mstrx == 0
                        && option.lock_duration_seconds == 0
                        && option.recipient == Pubkey::default()
                        && option.min_output_raw == 0,
                    GovernanceError::InvalidOption
                );
                // This winning no-op is completely executed by finalization.
                // No token moves: the exact frozen inventory becomes free again.
                Ok((STATUS_EXECUTED, 0, 0))
            } else {
                require!(
                    option.reserve_raw_mstrx == frozen,
                    GovernanceError::CommitmentMismatch
                );
                Ok((STATUS_PASSED_NOT_EXECUTED, current, proposal_id))
            }
        }
        _ => err!(GovernanceError::ProposalClosed),
    }
}

fn ballot_finalization_transition(
    ballot_status: u8,
    vote_status: u8,
    winner: Option<u8>,
    options: &[FrozenOption],
    current: u64,
    frozen: u64,
    proposal_id: u64,
) -> Result<(u8, u64, u64)> {
    require!(
        ballot_status == STATUS_ACTIVE || ballot_status == STATUS_ACTIVE_REVOTE,
        GovernanceError::ProposalClosed
    );
    let ordinary =
        finalization_transition(vote_status, winner, options, current, frozen, proposal_id)?;
    if ballot_status == STATUS_ACTIVE_REVOTE
        && matches!(vote_status, STATUS_REJECTED_NO_QUORUM | STATUS_REJECTED_TIE)
    {
        // A failed re-vote never unfreezes the prior holder commitment.
        return Ok((
            if vote_status == STATUS_REJECTED_NO_QUORUM {
                STATUS_REVOTE_NO_QUORUM
            } else {
                STATUS_REVOTE_TIE
            },
            frozen,
            proposal_id,
        ));
    }
    Ok(ordinary)
}

// Check before either ballot is written or any reserve amount is committed.
// A winning action with a closed executor would otherwise strand the exact
// commitment until another holder vote succeeds.
fn require_ballot_executors_released(options: &[ProposedOption]) -> Result<()> {
    for option in options {
        match option.action {
            ReserveAction::BuybackHold
            | ReserveAction::BuybackBurn
            | ReserveAction::BuybackLock => require!(
                BUYBACK_EXECUTOR_RELEASED && BUYBACK_TRADER_FUNDING_RELEASED,
                GovernanceError::BuybackNotReleased
            ),
            ReserveAction::MarketingSale => require!(
                marketing_sale_ready(
                    marketing_sale::MARKETING_SALE_EXECUTOR_RELEASED,
                    BUYBACK_EXECUTOR_RELEASED,
                    BUYBACK_TRADER_FUNDING_RELEASED,
                ),
                marketing_sale::MarketingSaleError::NotReleased
            ),
            ReserveAction::Accumulate | ReserveAction::LockMstrx => {}
        }
    }
    Ok(())
}

// The marketing sale uses the same System-owned trader PDA as buybacks. Until
// its own funded trader path exists, it depends on the verified fund_trader ix.
fn marketing_sale_ready(marketing: bool, buyback: bool, trader_funding: bool) -> bool {
    marketing && buyback && trader_funding
}

fn freeze_options(
    options: &[ProposedOption],
    amount: u64,
    marketing_wallet: &Pubkey,
) -> Result<Vec<FrozenOption>> {
    require!(
        (2..=MAX_OPTIONS).contains(&options.len()),
        GovernanceError::InvalidOptions
    );
    let mut seen = [false; MAX_OPTIONS];
    let mut frozen = Vec::with_capacity(options.len());
    for option in options {
        let index = option.action.index();
        require!(!seen[index], GovernanceError::DuplicateAction);
        seen[index] = true;
        let is_lock = matches!(
            option.action,
            ReserveAction::BuybackLock | ReserveAction::LockMstrx
        );
        require!(
            if is_lock {
                allowed_lock_duration(option.lock_duration_seconds)
            } else {
                option.lock_duration_seconds == 0
            },
            GovernanceError::InvalidLockDuration
        );
        require!(
            if option.action == ReserveAction::MarketingSale {
                option.recipient == *marketing_wallet
            } else {
                option.recipient == Pubkey::default()
            },
            GovernanceError::InvalidRecipient
        );
        require!(
            if matches!(
                option.action,
                ReserveAction::BuybackHold
                    | ReserveAction::BuybackBurn
                    | ReserveAction::BuybackLock
                    | ReserveAction::MarketingSale
            ) {
                option.min_output_raw > 0
            } else {
                option.min_output_raw == 0
            },
            GovernanceError::InvalidMinimumOutput
        );
        frozen.push(FrozenOption {
            action: option.action,
            lock_duration_seconds: option.lock_duration_seconds,
            recipient: option.recipient,
            reserve_raw_mstrx: if option.action == ReserveAction::Accumulate {
                0
            } else {
                amount
            },
            min_output_raw: option.min_output_raw,
        });
    }
    require!(
        seen[ReserveAction::Accumulate.index()],
        GovernanceError::AccumulateRequired
    );
    Ok(frozen)
}

fn allowed_lock_duration(value: u32) -> bool {
    value == PERMANENT_LOCK_SECONDS
        || [30_u32, 90, 180, 365, 730, 1095, 1825]
            .iter()
            .any(|days| days.checked_mul(86_400) == Some(value))
}

fn digest(parts: &[&[u8]]) -> [u8; 32] {
    hashv(parts).to_bytes()
}

fn leaf_hash(proposal: &Proposal, voter: &Pubkey, weight: u128) -> [u8; 32] {
    digest(&[
        LEAF_DOMAIN,
        NETWORK_DOMAIN,
        crate::ID.as_ref(),
        // Captured from the admin-configured mint when the proposal is created.
        proposal.capital_mint.as_ref(),
        &proposal.id.to_le_bytes(),
        &proposal.window_start.to_le_bytes(),
        &proposal.window_end.to_le_bytes(),
        &proposal.finalized_through_slot.to_le_bytes(),
        &proposal.finalized_blockhash,
        &proposal.exclusions_hash,
        voter.as_ref(),
        &weight.to_le_bytes(),
    ])
}

fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    if a <= b {
        digest(&[NODE_DOMAIN, a, b])
    } else {
        digest(&[NODE_DOMAIN, b, a])
    }
}

fn verify_snapshot_proof(
    proposal: &Proposal,
    voter: &Pubkey,
    weight: u128,
    proof: &[[u8; 32]],
) -> bool {
    let mut top = leaf_hash(proposal, voter, weight);
    for sibling in proof {
        top = node_hash(&top, sibling);
    }
    digest(&[
        ROOT_DOMAIN,
        &proposal.leaf_count.to_le_bytes(),
        &proposal.total_available_weight.to_le_bytes(),
        &top,
    ]) == proposal.merkle_root
}

fn quorum_threshold(total_available: u128) -> Result<u128> {
    let whole = total_available / 10_000;
    let remainder = total_available % 10_000;
    whole
        .checked_mul(QUORUM_BPS)
        .and_then(|base| base.checked_add((remainder * QUORUM_BPS + 9_999) / 10_000))
        .ok_or_else(|| GovernanceError::Overflow.into())
}

fn settle_vote(
    weights: &[u128],
    total_cast: u128,
    total_available: u128,
) -> Result<(u8, Option<u8>)> {
    require!(
        (2..=MAX_OPTIONS).contains(&weights.len()),
        GovernanceError::InvalidOptions
    );
    let recomputed = weights.iter().try_fold(0_u128, |sum, weight| {
        sum.checked_add(*weight).ok_or(GovernanceError::Overflow)
    })?;
    require!(recomputed == total_cast, GovernanceError::WeightExceeded);
    require!(
        total_cast <= total_available,
        GovernanceError::WeightExceeded
    );
    if total_cast < quorum_threshold(total_available)? {
        return Ok((STATUS_REJECTED_NO_QUORUM, None));
    }
    let highest = *weights
        .iter()
        .max()
        .ok_or(GovernanceError::InvalidOptions)?;
    let winners: Vec<usize> = weights
        .iter()
        .enumerate()
        .filter_map(|(i, w)| (*w == highest).then_some(i))
        .collect();
    if winners.len() != 1 {
        return Ok((STATUS_REJECTED_TIE, None));
    }
    Ok((STATUS_PASSED_NOT_EXECUTED, Some(winners[0] as u8)))
}

#[error_code]
pub enum GovernanceError {
    #[msg("Governance proposals remain disabled until every ballot action is executable")]
    ProposalsNotReleased,
    #[msg("Trader funding remains disabled until buyback and refund are verified")]
    TraderFundingNotReleased,
    #[msg("Buyback execution remains disabled until canary validation and review")]
    BuybackNotReleased,
    #[msg("Only the configured admin may propose")]
    Unauthorized,
    #[msg("Trader funding source must be the admin's empty System account")]
    InvalidTraderFundingSource,
    #[msg("Trader must be the canonical empty System-owned PDA")]
    InvalidTraderAccount,
    #[msg("Trader deposit must be positive")]
    InvalidTraderDeposit,
    #[msg("Trader balance must meet the System account rent floor")]
    TraderBelowRentFloor,
    #[msg("Configuration is invalid")]
    InvalidConfig,
    #[msg("Governance account schema does not match")]
    SchemaMismatch,
    #[msg("ProgramData is not associated with this governance program")]
    InvalidProgramData,
    #[msg("Program must be immutable before any binding proposal")]
    ProgramStillUpgradeable,
    #[msg("Official Token-2022 MSTRx mint is required")]
    InvalidReserveMint,
    #[msg("MSTRx transfer-fee extension is unsupported")]
    UnsupportedTransferFee,
    #[msg("Mint extension layout or feature is unsupported")]
    UnsupportedMintExtension,
    #[msg("An active transfer hook is not supported by this executor")]
    ActiveTransferHook,
    #[msg("Mint transfers are paused")]
    MintPaused,
    #[msg("Reserve vault must be the canonical program-owned MSTRx ATA")]
    InvalidReserveVault,
    #[msg("CAPITAL mint may only be bound once")]
    AlreadyBound,
    #[msg("CAPITAL mint is not a valid distinct mint")]
    InvalidCapitalMint,
    #[msg("Launch evidence metadata is invalid")]
    InvalidLaunchEvidence,
    #[msg("CAPITAL mint has not been bound")]
    CapitalNotBound,
    #[msg("Launch time is invalid")]
    InvalidLaunchTime,
    #[msg("Another proposal remains active")]
    ProposalAlreadyActive,
    #[msg("Proposal id must advance by one")]
    ProposalOutOfOrder,
    #[msg("Voting duration must be between one and twelve hours")]
    InvalidDuration,
    #[msg("Declared reserve amount must be positive")]
    EmptyReserve,
    #[msg("Reserve is already committed")]
    ReserveAlreadyCommitted,
    #[msg("Vault balance changed before proposal creation")]
    ReserveBalanceChanged,
    #[msg("Reserve vault is below committed amount")]
    ReserveInsolvent,
    #[msg("Withdrawal amount must be positive")]
    InvalidWithdrawal,
    #[msg("Committed reserve is protected from withdrawal")]
    CommittedReserveProtected,
    #[msg("Extra accounts are not accepted while transfer hooks are disabled")]
    UnexpectedRemainingAccounts,
    #[msg("Reserve vault debit did not equal requested withdrawal")]
    ReserveDebitMismatch,
    #[msg("Frozen commitment does not match proposal")]
    CommitmentMismatch,
    #[msg("Snapshot metadata is invalid")]
    InvalidSnapshot,
    #[msg("Snapshot window must be the configured lookback")]
    InvalidSnapshotWindow,
    #[msg("Two to six options are required")]
    InvalidOptions,
    #[msg("Each action may appear only once")]
    DuplicateAction,
    #[msg("Accumulate must be an option")]
    AccumulateRequired,
    #[msg("Lock duration is not allowlisted")]
    InvalidLockDuration,
    #[msg("Recipient must be the fixed marketing wallet or empty")]
    InvalidRecipient,
    #[msg("Buyback and sale minimum output must be positive; other actions require zero")]
    InvalidMinimumOutput,
    #[msg("Proposal is already finalized")]
    ProposalClosed,
    #[msg("Voting window is closed")]
    VotingClosed,
    #[msg("Option is not in this proposal")]
    InvalidOption,
    #[msg("Voting weight must be positive")]
    InvalidWeight,
    #[msg("Merkle proof has too many nodes")]
    ProofTooLong,
    #[msg("Vote-weight proof does not match snapshot commitment")]
    InvalidProof,
    #[msg("Cast weight exceeds all available weight")]
    WeightExceeded,
    #[msg("Voting result cannot finalize until delay elapses")]
    ExecutionDelay,
    #[msg("Proposal is not the configured active proposal")]
    ProposalNotActive,
    #[msg("Proposal has no executable winning MSTRx lock")]
    ProposalNotExecutable,
    #[msg("Only a committed spending winner or unresolved re-vote can be re-voted")]
    RevoteNotAllowed,
    #[msg("The prior ballot has not reached its execution time")]
    RevoteTooEarly,
    #[msg("The winning action is not LOCK_MSTRX")]
    WrongWinningAction,
    #[msg("Lock vault is not the canonical account stored in the lock record")]
    InvalidLockVault,
    #[msg("Committed MSTRx debit and escrow credit did not match exactly")]
    LockTransferMismatch,
    #[msg("This lock has already been released")]
    LockAlreadyReleased,
    #[msg("Buyback proposal identity does not match the bound config")]
    BuybackIdentityMismatch,
    #[msg("Buyback reserve, trader or destination balances do not conserve the full vote")]
    BuybackBalanceMismatch,
    #[msg("Buyback venue phase, state or ordered accounts are not canonical")]
    InvalidBuybackVenue,
    #[msg("A permanent lock has no release instruction")]
    PermanentLock,
    #[msg("The lock term has not matured")]
    LockNotMature,
    #[msg("The escrow balance changed unexpectedly")]
    LockBalanceChanged,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Trader SOL refund exceeds the above-rent uncommitted balance")]
    InvalidTraderRefund,
    #[msg("Trader SOL cannot be refunded while a reserve vote is active or committed")]
    TraderRefundCommitted,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[derive(Clone, Copy)]
    struct TraderFundingCase {
        admin_matches: bool,
        admin_signer: bool,
        admin_system_owned: bool,
        admin_has_data: bool,
        trader_canonical: bool,
        trader_system_owned: bool,
        trader_has_data: bool,
        trader_executable: bool,
        trader_balance: u64,
        deposit: u64,
        rent_floor: u64,
    }

    impl Default for TraderFundingCase {
        fn default() -> Self {
            Self {
                admin_matches: true,
                admin_signer: true,
                admin_system_owned: true,
                admin_has_data: false,
                trader_canonical: true,
                trader_system_owned: true,
                trader_has_data: false,
                trader_executable: false,
                trader_balance: 0,
                deposit: 1_000_000,
                rent_floor: 890_880,
            }
        }
    }

    fn check_trader_funding_case(case: TraderFundingCase) -> Result<u64> {
        let admin_key = Pubkey::new_unique();
        let (canonical_trader, _) = Pubkey::find_program_address(&[TRADER_SEED], &crate::ID);
        let trader_key = if case.trader_canonical {
            canonical_trader
        } else {
            Pubkey::new_unique()
        };
        let admin_owner = if case.admin_system_owned {
            System::id()
        } else {
            Pubkey::new_unique()
        };
        let trader_owner = if case.trader_system_owned {
            System::id()
        } else {
            Pubkey::new_unique()
        };
        let configured_admin = if case.admin_matches {
            admin_key
        } else {
            Pubkey::new_unique()
        };
        let mut admin_balance = 2_000_000;
        let mut trader_balance = case.trader_balance;
        let mut admin_data = [0u8; 1];
        let mut trader_data = [0u8; 1];
        let admin_len = usize::from(case.admin_has_data);
        let trader_len = usize::from(case.trader_has_data);
        let admin = AccountInfo::new(
            &admin_key,
            case.admin_signer,
            true,
            &mut admin_balance,
            &mut admin_data[..admin_len],
            &admin_owner,
            false,
            0,
        );
        let trader = AccountInfo::new(
            &trader_key,
            false,
            true,
            &mut trader_balance,
            &mut trader_data[..trader_len],
            &trader_owner,
            case.trader_executable,
            0,
        );
        validate_trader_funding(
            configured_admin,
            &admin,
            &trader,
            case.deposit,
            case.rent_floor,
        )
    }

    fn check_trader_refund_case(
        case: TraderFundingCase,
        active_proposal_id: u64,
        committed_reserve_raw_mstrx: u64,
    ) -> Result<u64> {
        let admin_key = Pubkey::new_unique();
        let (canonical_trader, _) = Pubkey::find_program_address(&[TRADER_SEED], &crate::ID);
        let trader_key = if case.trader_canonical {
            canonical_trader
        } else {
            Pubkey::new_unique()
        };
        let admin_owner = if case.admin_system_owned {
            System::id()
        } else {
            Pubkey::new_unique()
        };
        let trader_owner = if case.trader_system_owned {
            System::id()
        } else {
            Pubkey::new_unique()
        };
        let mut admin_balance = 0;
        let mut trader_balance = case.trader_balance;
        let mut admin_data = [0u8; 1];
        let mut trader_data = [0u8; 1];
        let admin = AccountInfo::new(
            &admin_key,
            case.admin_signer,
            true,
            &mut admin_balance,
            &mut admin_data[..usize::from(case.admin_has_data)],
            &admin_owner,
            false,
            0,
        );
        let trader = AccountInfo::new(
            &trader_key,
            false,
            true,
            &mut trader_balance,
            &mut trader_data[..usize::from(case.trader_has_data)],
            &trader_owner,
            case.trader_executable,
            0,
        );
        let (mut config, _, _) = buyback_fixtures(ReserveAction::BuybackHold);
        config.admin = if case.admin_matches {
            admin_key
        } else {
            Pubkey::new_unique()
        };
        config.active_proposal_id = active_proposal_id;
        config.committed_reserve_raw_mstrx = committed_reserve_raw_mstrx;
        validate_trader_refund(&config, &admin, &trader, case.deposit, case.rent_floor)
    }

    #[test]
    fn trader_pda_is_distinct_from_config_and_reserve() {
        let (trader, bump) = Pubkey::find_program_address(&[TRADER_SEED], &crate::ID);
        let (config, _) = Pubkey::find_program_address(&[b"config"], &crate::ID);
        assert_ne!(trader, config);
        assert_ne!(trader, MSTRX_MINT);
        assert_eq!(
            trader,
            Pubkey::create_program_address(&[TRADER_SEED, &[bump]], &crate::ID).unwrap()
        );
    }

    #[test]
    fn trader_accepts_admin_only_deposit_and_top_up() {
        assert_eq!(
            check_trader_funding_case(TraderFundingCase::default()).unwrap(),
            1_000_000
        );
        assert_eq!(
            check_trader_funding_case(TraderFundingCase {
                trader_balance: 1_000_000,
                deposit: 250_000,
                ..Default::default()
            })
            .unwrap(),
            1_250_000
        );
    }

    #[test]
    fn trader_rejects_wrong_admin_and_non_system_funding_source() {
        for case in [
            TraderFundingCase {
                admin_matches: false,
                ..Default::default()
            },
            TraderFundingCase {
                admin_signer: false,
                ..Default::default()
            },
            TraderFundingCase {
                admin_system_owned: false,
                ..Default::default()
            },
            TraderFundingCase {
                admin_has_data: true,
                ..Default::default()
            },
        ] {
            assert!(check_trader_funding_case(case).is_err());
        }
    }

    #[test]
    fn trader_rejects_substituted_or_non_system_destination() {
        for case in [
            TraderFundingCase {
                trader_canonical: false,
                ..Default::default()
            },
            TraderFundingCase {
                trader_system_owned: false,
                ..Default::default()
            },
            TraderFundingCase {
                trader_has_data: true,
                ..Default::default()
            },
            TraderFundingCase {
                trader_executable: true,
                ..Default::default()
            },
        ] {
            assert!(check_trader_funding_case(case).is_err());
        }
    }

    #[test]
    fn trader_rejects_zero_below_rent_and_overflow() {
        for case in [
            TraderFundingCase {
                deposit: 0,
                ..Default::default()
            },
            TraderFundingCase {
                deposit: 1,
                ..Default::default()
            },
            TraderFundingCase {
                trader_balance: u64::MAX,
                deposit: 1,
                ..Default::default()
            },
        ] {
            assert!(check_trader_funding_case(case).is_err());
        }
    }

    #[test]
    fn trader_refund_is_owner_only_uncommitted_and_preserves_rent() {
        let valid = TraderFundingCase {
            trader_balance: 1_500_000,
            deposit: 500_000,
            ..Default::default()
        };
        assert_eq!(check_trader_refund_case(valid, 0, 0).unwrap(), 1_000_000);
        for case in [
            TraderFundingCase {
                deposit: 0,
                ..valid
            },
            TraderFundingCase {
                deposit: 700_000,
                ..valid
            },
            TraderFundingCase {
                admin_matches: false,
                ..valid
            },
            TraderFundingCase {
                admin_signer: false,
                ..valid
            },
            TraderFundingCase {
                admin_system_owned: false,
                ..valid
            },
            TraderFundingCase {
                admin_has_data: true,
                ..valid
            },
            TraderFundingCase {
                trader_canonical: false,
                ..valid
            },
            TraderFundingCase {
                trader_system_owned: false,
                ..valid
            },
            TraderFundingCase {
                trader_has_data: true,
                ..valid
            },
            TraderFundingCase {
                trader_executable: true,
                ..valid
            },
        ] {
            assert!(check_trader_refund_case(case, 0, 0).is_err());
        }
        assert!(check_trader_refund_case(valid, 1, 0).is_err());
        assert!(check_trader_refund_case(valid, 0, 1).is_err());
    }

    #[test]
    fn incomplete_executor_cannot_open_binding_ballot() {
        assert!(!GOVERNANCE_PROPOSALS_RELEASED);
        assert!(!BUYBACK_EXECUTOR_RELEASED);
        assert!(!BUYBACK_TRADER_FUNDING_RELEASED);
        assert!(!marketing_sale::MARKETING_SALE_EXECUTOR_RELEASED);
        for action in [
            ReserveAction::BuybackHold,
            ReserveAction::BuybackBurn,
            ReserveAction::BuybackLock,
            ReserveAction::MarketingSale,
        ] {
            let choices = [option(ReserveAction::Accumulate), option(action)];
            assert!(require_ballot_executors_released(&choices).is_err());
        }
        assert!(require_ballot_executors_released(&[
            option(ReserveAction::Accumulate),
            option(ReserveAction::LockMstrx),
        ])
        .is_ok());
        assert!(!marketing_sale_ready(true, false, true));
        assert!(!marketing_sale_ready(true, true, false));
        assert!(!marketing_sale_ready(false, true, true));
        assert!(marketing_sale_ready(true, true, true));
    }

    fn check_mint_extensions_for_policy(entries: &[(u16, Vec<u8>)], capital: bool) -> Result<()> {
        let mint_key = MSTRX_MINT;
        let owner = spl_token_2022::ID;
        let mut lamports = 1;
        let mut data = vec![0_u8; 166];
        data[165] = 1;
        for (kind, value) in entries {
            data.extend_from_slice(&kind.to_le_bytes());
            data.extend_from_slice(&(value.len() as u16).to_le_bytes());
            data.extend_from_slice(value);
        }
        let info = AccountInfo::new(
            &mint_key,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
        );
        validate_mint_extensions(&info, capital)
    }

    fn check_mint_extensions(entries: &[(u16, Vec<u8>)]) -> Result<()> {
        check_mint_extensions_for_policy(entries, false)
    }

    #[test]
    fn mint_tlv_accepts_observed_mstrx_extensions_without_old_enum() {
        assert!(check_mint_extensions(&[
            (18, vec![0; 64]),
            (12, vec![0; 32]),
            (6, vec![1]),
            (25, vec![0; 56]),
            (26, vec![0; 33]),
            (4, vec![0; 65]),
            (14, vec![0; 64]),
            (19, vec![0; 173]),
        ])
        .is_ok());
    }

    #[test]
    fn capital_policy_rejects_issuer_powers_that_break_hold_or_lock() {
        // MSTRx compatibility is deliberately different from CAPITAL custody.
        for extension in [(12, vec![0; 32]), (14, vec![0; 64]), (26, vec![0; 33])] {
            assert!(check_mint_extensions_for_policy(&[extension.clone()], false).is_ok());
            assert!(check_mint_extensions_for_policy(&[extension], true).is_err());
        }
        // Metadata and immutable-owner style extensions do not grant the
        // issuer authority over the proposal's purchased CAPITAL inventory.
        assert!(check_mint_extensions_for_policy(&[(18, vec![0; 64])], true).is_ok());
    }

    #[test]
    fn capital_policy_rejects_freeze_authority_before_binding() {
        use anchor_lang::solana_program::program_option::COption;
        use anchor_lang::solana_program::program_pack::Pack;

        let mint_key = Pubkey::new_unique();
        let owner = spl_token_2022::ID;
        let mut lamports = 1;
        let mut data = vec![0_u8; spl_token_2022::state::Mint::LEN];
        let state = spl_token_2022::state::Mint {
            mint_authority: COption::None,
            supply: 1,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::Some(Pubkey::new_unique()),
        };
        spl_token_2022::state::Mint::pack(state, &mut data).unwrap();
        let info = AccountInfo::new(
            &mint_key, false, false, &mut lamports, &mut data, &owner, false, 0,
        );
        let mint = InterfaceAccount::<Mint>::try_from(&info).unwrap();
        assert!(validate_capital_mint_policy(&mint).is_err());
    }

    #[test]
    fn mint_tlv_rejects_fee_active_hook_pause_unknown_and_malformed_data() {
        let mut active_hook = vec![0; 64];
        active_hook[32] = 1;
        let mut paused = vec![0; 33];
        paused[32] = 1;
        for entries in [
            vec![(1, vec![0; 108])],
            vec![(14, active_hook)],
            vec![(26, paused)],
            vec![(24, vec![0; 36])],
            vec![(27, vec![0])],
            vec![(14, vec![0; 64]), (14, vec![0; 64])],
            vec![(14, vec![0; 63])],
            vec![(26, vec![0; 32])],
            vec![(6, vec![2])],
        ] {
            assert!(check_mint_extensions(&entries).is_err());
        }
    }

    #[test]
    fn buyback_receipt_layout_is_exact_and_proposal_scoped() {
        let proposal = Pubkey::new_unique();
        let (key, bump) =
            Pubkey::find_program_address(&[b"buyback-receipt", proposal.as_ref()], &crate::ID);
        assert_eq!(
            key,
            Pubkey::create_program_address(
                &[b"buyback-receipt", proposal.as_ref(), &[bump]],
                &crate::ID,
            )
            .unwrap()
        );
        let receipt = BuybackExecutionReceipt {
            schema_version: SCHEMA_VERSION,
            proposal,
            config: Pubkey::default(),
            capital_mint: Pubkey::default(),
            reserve_vault: Pubkey::default(),
            trader: Pubkey::default(),
            venue_program: PUMP_PROGRAM,
            venue_account: Pubkey::default(),
            destination: Pubkey::default(),
            action: ReserveAction::BuybackLock,
            quote_spent_raw: 1,
            voted_min_output_raw: 1,
            base_acquired_raw: 1,
            base_supply_before: 2,
            base_supply_after: 2,
            executed_at: 100,
            lock_release_at: 200,
            lock_released_at: 0,
            lock_duration_seconds: 100,
            bump,
        };
        assert_eq!(
            receipt.try_to_vec().unwrap().len() + 8,
            BuybackExecutionReceipt::SPACE
        );
    }

    fn hex32(value: &str) -> [u8; 32] {
        assert_eq!(value.len(), 64);
        let mut bytes = [0_u8; 32];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
        }
        bytes
    }

    fn snapshot_fixture() -> Proposal {
        Proposal {
            schema_version: SCHEMA_VERSION,
            config: Pubkey::default(),
            capital_mint: Pubkey::from_str("9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu").unwrap(),
            reserve_vault: Pubkey::default(),
            id: 1,
            starts_at: 2_001,
            ends_at: 5_601,
            executable_at: 5_901,
            window_start: 1_000,
            window_end: 2_000,
            finalized_through_slot: 20,
            finalized_blockhash: Pubkey::from_str("GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse")
                .unwrap()
                .to_bytes(),
            exclusions_hash: hex32(
                "c5cf2cd13ec8c0b7e94bbb54bb86bf0869de021e6d563aeb93c23ed39363440f",
            ),
            merkle_root: hex32("e302ca53ea641cdd4d34ee86682eaccbf489b72360fede22ced0d41741e1e08d"),
            leaf_count: 1,
            total_available_weight: 100_000,
            frozen_reserve_raw_mstrx: 100,
            options: Vec::new(),
            option_weights: [0; MAX_OPTIONS],
            total_cast: 0,
            status: STATUS_ACTIVE,
            winning_option: NO_WINNING_OPTION,
            bump: 0,
        }
    }

    fn option(action: ReserveAction) -> ProposedOption {
        ProposedOption {
            action,
            lock_duration_seconds: 0,
            recipient: Pubkey::default(),
            min_output_raw: if matches!(
                action,
                ReserveAction::BuybackHold
                    | ReserveAction::BuybackBurn
                    | ReserveAction::BuybackLock
                    | ReserveAction::MarketingSale
            ) {
                1
            } else {
                0
            },
        }
    }

    fn lock_fixtures(duration: u32) -> (Config, Proposal) {
        let config = Config {
            schema_version: SCHEMA_VERSION,
            admin: Pubkey::new_unique(),
            capital_mint: Pubkey::new_unique(),
            capital_token_program: Pubkey::new_unique(),
            reserve_mint: MSTRX_MINT,
            reserve_vault: Pubkey::new_unique(),
            marketing_wallet: Pubkey::new_unique(),
            launched_at: 1,
            launch_slot: 1,
            launch_signature: [1; 64],
            last_proposal_id: 1,
            active_proposal_id: 1,
            committed_reserve_raw_mstrx: 100,
            bump: 1,
        };
        let mut proposal = snapshot_fixture();
        proposal.status = STATUS_PASSED_NOT_EXECUTED;
        proposal.winning_option = 1;
        proposal.options = vec![
            FrozenOption {
                action: ReserveAction::Accumulate,
                lock_duration_seconds: 0,
                recipient: Pubkey::default(),
                reserve_raw_mstrx: 0,
                min_output_raw: 0,
            },
            FrozenOption {
                action: ReserveAction::LockMstrx,
                lock_duration_seconds: duration,
                recipient: Pubkey::default(),
                reserve_raw_mstrx: 100,
                min_output_raw: 0,
            },
        ];
        (config, proposal)
    }

    fn buyback_fixtures(action: ReserveAction) -> (Config, Pubkey, Proposal) {
        let (mut config, mut proposal) = lock_fixtures(30 * 86_400);
        config.capital_token_program = spl_token_2022::ID;
        let config_key = Pubkey::new_unique();
        proposal.config = config_key;
        proposal.capital_mint = config.capital_mint;
        proposal.reserve_vault = config.reserve_vault;
        proposal.options[1] = FrozenOption {
            action,
            lock_duration_seconds: if action == ReserveAction::BuybackLock {
                30 * 86_400
            } else {
                0
            },
            recipient: Pubkey::default(),
            reserve_raw_mstrx: 100,
            min_output_raw: 10,
        };
        (config, config_key, proposal)
    }

    fn buyback_balance_fixture(action: ReserveAction) -> (BuybackTerms, BuybackBalances) {
        let (config, config_key, proposal) = buyback_fixtures(action);
        let terms = buyback_execution_terms(&config, &config_key, &proposal, 150, 6_000).unwrap();
        let balances = BuybackBalances {
            reserve_before: 150,
            reserve_after: 50,
            trader_quote_before: 0,
            trader_quote_after_funding: 100,
            trader_quote_after_buy: 0,
            trader_base_before: 0,
            trader_base_after_buy: 25,
            trader_base_after_action: 0,
            destination_before: 5,
            destination_after: if action == ReserveAction::BuybackBurn {
                5
            } else {
                30
            },
            base_supply_before: 1_000,
            base_supply_after: if action == ReserveAction::BuybackBurn {
                975
            } else {
                1_000
            },
        };
        (terms, balances)
    }

    fn mock_venue_account(
        key: Pubkey,
        owner: Pubkey,
        data: Vec<u8>,
        executable: bool,
    ) -> AccountInfo<'static> {
        let key = Box::leak(Box::new(key));
        let owner = Box::leak(Box::new(owner));
        let lamports = Box::leak(Box::new(1));
        let data = Box::leak(data.into_boxed_slice());
        AccountInfo::new(key, false, true, lamports, data, owner, executable, 0)
    }

    fn encoded_venue_state<T: AnchorSerialize>(discriminator: [u8; 8], state: &T) -> Vec<u8> {
        let mut data = discriminator.to_vec();
        state.serialize(&mut data).unwrap();
        data
    }

    fn curve_route_fixture() -> (Config, AccountInfo<'static>, Vec<AccountInfo<'static>>) {
        let (config, _, _) = buyback_fixtures(ReserveAction::BuybackHold);
        let capital = config.capital_mint;
        let token = config.capital_token_program;
        let quote_token = spl_token_2022::ID;
        let trader = venue_pda(&crate::ID, &[TRADER_SEED]);
        let curve_key = venue_pda(&PUMP_PROGRAM, &[b"bonding-curve", capital.as_ref()]);
        let creator = Pubkey::new_unique();
        let fee = Pubkey::new_unique();
        let buyback_fee = Pubkey::new_unique();
        let curve_state = PumpCurveHeader {
            creator,
            quote_mint: MSTRX_MINT,
            ..Default::default()
        };
        let curve = mock_venue_account(
            curve_key,
            PUMP_PROGRAM,
            encoded_venue_state(PUMP_CURVE_DISCRIMINATOR, &curve_state),
            false,
        );
        let global_state = PumpGlobalHeader {
            fee_recipient: fee,
            buyback_fee_recipients: [buyback_fee; 8],
            ..Default::default()
        };
        let global = mock_venue_account(
            venue_pda(&PUMP_PROGRAM, &[b"global"]),
            PUMP_PROGRAM,
            encoded_venue_state(PUMP_GLOBAL_DISCRIMINATOR, &global_state),
            false,
        );
        let creator_vault = venue_pda(&PUMP_PROGRAM, &[b"creator-vault", creator.as_ref()]);
        let user_volume = venue_pda(
            &PUMP_PROGRAM,
            &[b"user_volume_accumulator", trader.as_ref()],
        );
        let keys = vec![
            *global.key,
            capital,
            MSTRX_MINT,
            token,
            quote_token,
            associated_token::ID,
            fee,
            venue_ata(&fee, &MSTRX_MINT, &quote_token),
            buyback_fee,
            venue_ata(&buyback_fee, &MSTRX_MINT, &quote_token),
            curve_key,
            venue_ata(&curve_key, &capital, &token),
            venue_ata(&curve_key, &MSTRX_MINT, &quote_token),
            trader,
            venue_ata(&trader, &capital, &token),
            venue_ata(&trader, &MSTRX_MINT, &quote_token),
            creator_vault,
            venue_ata(&creator_vault, &MSTRX_MINT, &quote_token),
            venue_pda(&PUMP_FEE_PROGRAM, &[b"sharing-config", capital.as_ref()]),
            venue_pda(&PUMP_PROGRAM, &[b"global_volume_accumulator"]),
            user_volume,
            venue_ata(&user_volume, &MSTRX_MINT, &quote_token),
            venue_pda(&PUMP_FEE_PROGRAM, &[b"fee_config", PUMP_PROGRAM.as_ref()]),
            PUMP_FEE_PROGRAM,
            System::id(),
            venue_pda(&PUMP_PROGRAM, &[b"__event_authority"]),
            PUMP_PROGRAM,
        ];
        let mut accounts: Vec<_> = keys
            .iter()
            .map(|key| {
                mock_venue_account(
                    *key,
                    System::id(),
                    vec![],
                    *key == PUMP_PROGRAM || *key == PUMP_FEE_PROGRAM,
                )
            })
            .collect();
        accounts[0] = global;
        accounts[10] = curve.clone();
        (config, curve, accounts)
    }

    fn swap_route_fixture() -> (Config, AccountInfo<'static>, Vec<AccountInfo<'static>>) {
        let (config, _, _) = buyback_fixtures(ReserveAction::BuybackHold);
        let capital = config.capital_mint;
        let token = config.capital_token_program;
        let quote_token = spl_token_2022::ID;
        let trader = venue_pda(&crate::ID, &[TRADER_SEED]);
        let curve_key = venue_pda(&PUMP_PROGRAM, &[b"bonding-curve", capital.as_ref()]);
        let curve_state = PumpCurveHeader {
            complete: true,
            quote_mint: MSTRX_MINT,
            ..Default::default()
        };
        let curve = mock_venue_account(
            curve_key,
            PUMP_PROGRAM,
            encoded_venue_state(PUMP_CURVE_DISCRIMINATOR, &curve_state),
            false,
        );
        let pool_authority = venue_pda(&PUMP_PROGRAM, &[b"pool-authority", capital.as_ref()]);
        let index = 0u16.to_le_bytes();
        let pool_key = venue_pda(
            &PUMP_SWAP_PROGRAM,
            &[
                b"pool",
                &index,
                pool_authority.as_ref(),
                capital.as_ref(),
                MSTRX_MINT.as_ref(),
            ],
        );
        let creator = Pubkey::new_unique();
        let pool_state = PumpSwapPoolHeader {
            creator: pool_authority,
            base_mint: capital,
            quote_mint: MSTRX_MINT,
            pool_base_token_account: venue_ata(&pool_key, &capital, &token),
            pool_quote_token_account: venue_ata(&pool_key, &MSTRX_MINT, &quote_token),
            coin_creator: creator,
            ..Default::default()
        };
        let pool = mock_venue_account(
            pool_key,
            PUMP_SWAP_PROGRAM,
            encoded_venue_state(PUMP_SWAP_POOL_DISCRIMINATOR, &pool_state),
            false,
        );
        let fee = Pubkey::new_unique();
        let global_state = PumpSwapGlobalHeader {
            protocol_fee_recipients: [fee; 8],
            ..Default::default()
        };
        let global = mock_venue_account(
            venue_pda(&PUMP_SWAP_PROGRAM, &[b"global_config"]),
            PUMP_SWAP_PROGRAM,
            encoded_venue_state(PUMP_SWAP_GLOBAL_DISCRIMINATOR, &global_state),
            false,
        );
        let creator_vault = venue_pda(&PUMP_SWAP_PROGRAM, &[b"creator_vault", creator.as_ref()]);
        let keys = vec![
            pool_key,
            trader,
            *global.key,
            capital,
            MSTRX_MINT,
            venue_ata(&trader, &capital, &token),
            venue_ata(&trader, &MSTRX_MINT, &quote_token),
            pool_state.pool_base_token_account,
            pool_state.pool_quote_token_account,
            fee,
            venue_ata(&fee, &MSTRX_MINT, &quote_token),
            token,
            quote_token,
            System::id(),
            associated_token::ID,
            venue_pda(&PUMP_SWAP_PROGRAM, &[b"__event_authority"]),
            PUMP_SWAP_PROGRAM,
            venue_ata(&creator_vault, &MSTRX_MINT, &quote_token),
            creator_vault,
            venue_pda(&PUMP_SWAP_PROGRAM, &[b"global_volume_accumulator"]),
            venue_pda(
                &PUMP_SWAP_PROGRAM,
                &[b"user_volume_accumulator", trader.as_ref()],
            ),
            venue_pda(
                &PUMP_FEE_PROGRAM,
                &[b"fee_config", PUMP_SWAP_PROGRAM.as_ref()],
            ),
            PUMP_FEE_PROGRAM,
        ];
        let mut accounts: Vec<_> = keys
            .iter()
            .map(|key| {
                mock_venue_account(
                    *key,
                    System::id(),
                    vec![],
                    *key == PUMP_SWAP_PROGRAM || *key == PUMP_FEE_PROGRAM,
                )
            })
            .collect();
        accounts[0] = pool;
        accounts[2] = global;
        (config, curve, accounts)
    }

    #[test]
    fn buyback_route_accepts_only_canonical_curve_and_ordered_idl_accounts() {
        let (config, curve, accounts) = curve_route_fixture();
        assert_eq!(
            validate_buyback_venue_accounts(&config, &curve, &accounts).unwrap(),
            BuybackVenue::PumpCurve
        );
        for index in 0..accounts.len() {
            let mut altered = accounts.clone();
            altered[index] = mock_venue_account(Pubkey::new_unique(), System::id(), vec![], false);
            assert!(validate_buyback_venue_accounts(&config, &curve, &altered).is_err());
        }
        assert!(validate_buyback_venue_accounts(&config, &curve, &accounts[..26]).is_err());
        let fake_curve = mock_venue_account(*curve.key, System::id(), vec![], false);
        assert!(validate_buyback_venue_accounts(&config, &fake_curve, &accounts).is_err());
    }

    #[test]
    fn buyback_route_accepts_only_migrated_index_zero_pumpswap_pool() {
        let (config, curve, accounts) = swap_route_fixture();
        assert_eq!(
            validate_buyback_venue_accounts(&config, &curve, &accounts).unwrap(),
            BuybackVenue::PumpSwap
        );
        for index in 0..accounts.len() {
            let mut altered = accounts.clone();
            altered[index] = mock_venue_account(Pubkey::new_unique(), System::id(), vec![], false);
            assert!(validate_buyback_venue_accounts(&config, &curve, &altered).is_err());
        }
        assert!(validate_buyback_venue_accounts(&config, &curve, &accounts[..22]).is_err());
        let fake_curve = mock_venue_account(*curve.key, System::id(), vec![], false);
        assert!(validate_buyback_venue_accounts(&config, &fake_curve, &accounts).is_err());
    }

    #[test]
    fn buyback_payload_is_exact_idl_quote_input_with_only_trader_signing() {
        for (phase, expected_program, discriminator, writable, user_index, data_len) in [
            (
                BuybackVenue::PumpCurve,
                PUMP_PROGRAM,
                PUMP_EXACT_QUOTE_BUY_DISCRIMINATOR,
                &PUMP_CURVE_WRITABLE[..],
                13,
                24,
            ),
            (
                BuybackVenue::PumpSwap,
                PUMP_SWAP_PROGRAM,
                PUMP_SWAP_EXACT_QUOTE_BUY_DISCRIMINATOR,
                &PUMP_SWAP_WRITABLE[..],
                1,
                25,
            ),
        ] {
            let (config, curve, accounts) = if phase == BuybackVenue::PumpCurve {
                curve_route_fixture()
            } else {
                swap_route_fixture()
            };
            let (_, config_key, mut proposal) = buyback_fixtures(ReserveAction::BuybackBurn);
            proposal.capital_mint = config.capital_mint;
            proposal.reserve_vault = config.reserve_vault;
            let (instruction, terms) = pinned_buyback_instruction(
                &config,
                &config_key,
                &proposal,
                100,
                6_000,
                &curve,
                &accounts,
            )
            .unwrap();
            assert_eq!(terms.action, ReserveAction::BuybackBurn);
            assert_eq!(instruction.program_id, expected_program);
            assert_eq!(instruction.data.len(), data_len);
            assert_eq!(&instruction.data[..8], &discriminator);
            assert_eq!(
                u64::from_le_bytes(instruction.data[8..16].try_into().unwrap()),
                100
            );
            assert_eq!(
                u64::from_le_bytes(instruction.data[16..24].try_into().unwrap()),
                10
            );
            if phase == BuybackVenue::PumpSwap {
                assert_eq!(instruction.data[24], 0);
            }
            for (index, meta) in instruction.accounts.iter().enumerate() {
                assert_eq!(meta.pubkey, *accounts[index].key);
                assert_eq!(meta.is_writable, writable[index]);
                assert_eq!(meta.is_signer, index == user_index);
            }
        }
    }

    #[test]
    fn buyback_terms_bind_winner_full_commitment_mint_and_voted_floor() {
        for action in [
            ReserveAction::BuybackHold,
            ReserveAction::BuybackBurn,
            ReserveAction::BuybackLock,
        ] {
            let (config, config_key, proposal) = buyback_fixtures(action);
            let terms =
                buyback_execution_terms(&config, &config_key, &proposal, 125, 6_000).unwrap();
            assert_eq!(terms.action, action);
            assert_eq!(terms.committed_quote_raw, 100);
            assert_eq!(terms.voted_min_base_out_raw, 10);
            assert_eq!(
                terms.lock_release_at,
                if action == ReserveAction::BuybackLock {
                    6_000 + 30 * 86_400
                } else {
                    0
                }
            );
        }
    }

    #[test]
    fn buyback_terms_reject_replay_wrong_action_identity_or_funding() {
        let (mut config, config_key, mut proposal) = buyback_fixtures(ReserveAction::BuybackHold);
        assert!(buyback_execution_terms(&config, &config_key, &proposal, 99, 6_000).is_err());
        assert!(buyback_execution_terms(&config, &config_key, &proposal, 100, 5_900).is_err());
        proposal.status = STATUS_EXECUTED;
        assert!(buyback_execution_terms(&config, &config_key, &proposal, 100, 6_000).is_err());
        proposal.status = STATUS_PASSED_NOT_EXECUTED;
        proposal.options[1].action = ReserveAction::MarketingSale;
        assert!(buyback_execution_terms(&config, &config_key, &proposal, 100, 6_000).is_err());
        proposal.options[1].action = ReserveAction::BuybackHold;
        proposal.options[1].min_output_raw = 0;
        assert!(buyback_execution_terms(&config, &config_key, &proposal, 100, 6_000).is_err());
        proposal.options[1].min_output_raw = 10;
        proposal.config = Pubkey::new_unique();
        assert!(buyback_execution_terms(&config, &config_key, &proposal, 100, 6_000).is_err());
        proposal.config = config_key;
        proposal.capital_mint = Pubkey::new_unique();
        assert!(buyback_execution_terms(&config, &config_key, &proposal, 100, 6_000).is_err());
        proposal.capital_mint = config.capital_mint;
        config.committed_reserve_raw_mstrx = 99;
        assert!(buyback_execution_terms(&config, &config_key, &proposal, 100, 6_000).is_err());
    }

    #[test]
    fn buyback_balance_conservation_covers_hold_burn_and_lock() {
        for action in [
            ReserveAction::BuybackHold,
            ReserveAction::BuybackBurn,
            ReserveAction::BuybackLock,
        ] {
            let (terms, balances) = buyback_balance_fixture(action);
            assert_eq!(
                validate_buyback_balance_conservation(&terms, balances).unwrap(),
                25
            );
        }
    }

    #[test]
    fn buyback_balance_conservation_preserves_preexisting_trader_tokens() {
        for action in [
            ReserveAction::BuybackHold,
            ReserveAction::BuybackBurn,
            ReserveAction::BuybackLock,
        ] {
            let (terms, mut balances) = buyback_balance_fixture(action);
            balances.trader_quote_before = 7;
            balances.trader_quote_after_funding = 107;
            balances.trader_quote_after_buy = 7;
            balances.trader_base_before = 11;
            balances.trader_base_after_buy = 36;
            balances.trader_base_after_action = 11;
            assert_eq!(
                validate_buyback_balance_conservation(&terms, balances).unwrap(),
                25
            );
        }
    }

    #[test]
    fn buyback_balance_conservation_rejects_partial_spend_and_residue() {
        let (terms, baseline) = buyback_balance_fixture(ReserveAction::BuybackHold);
        let invalid = [
            BuybackBalances {
                reserve_after: 51,
                ..baseline
            },
            BuybackBalances {
                trader_quote_before: 1,
                ..baseline
            },
            BuybackBalances {
                trader_quote_after_funding: 99,
                ..baseline
            },
            BuybackBalances {
                trader_quote_after_buy: 1,
                ..baseline
            },
            BuybackBalances {
                trader_base_before: 1,
                ..baseline
            },
            BuybackBalances {
                trader_base_after_buy: 9,
                ..baseline
            },
            BuybackBalances {
                trader_base_after_action: 1,
                ..baseline
            },
            BuybackBalances {
                destination_after: 29,
                ..baseline
            },
            BuybackBalances {
                base_supply_after: 999,
                ..baseline
            },
        ];
        for balances in invalid {
            assert!(validate_buyback_balance_conservation(&terms, balances).is_err());
        }
        let (burn_terms, burn_baseline) = buyback_balance_fixture(ReserveAction::BuybackBurn);
        assert!(validate_buyback_balance_conservation(
            &burn_terms,
            BuybackBalances {
                base_supply_after: 976,
                ..burn_baseline
            },
        )
        .is_err());
        assert!(validate_buyback_balance_conservation(
            &burn_terms,
            BuybackBalances {
                destination_after: 6,
                ..burn_baseline
            },
        )
        .is_err());
    }

    #[test]
    fn option_policy_is_bounded_and_amounts_are_exact() {
        let marketing = Pubkey::new_unique();
        let mut choices = vec![
            option(ReserveAction::Accumulate),
            option(ReserveAction::BuybackBurn),
        ];
        let frozen = freeze_options(&choices, 123, &marketing).unwrap();
        assert_eq!(frozen[0].reserve_raw_mstrx, 0);
        assert_eq!(frozen[1].reserve_raw_mstrx, 123);
        assert_eq!(frozen[1].min_output_raw, 1);
        let mut no_floor = choices[1].clone();
        no_floor.min_output_raw = 0;
        assert!(freeze_options(&[choices[0].clone(), no_floor], 123, &marketing).is_err());
        let mut unexpected_floor = choices[0].clone();
        unexpected_floor.min_output_raw = 1;
        assert!(freeze_options(&[unexpected_floor, choices[1].clone()], 123, &marketing).is_err());
        choices.push(option(ReserveAction::BuybackBurn));
        assert!(freeze_options(&choices, 123, &marketing).is_err());
        let wrong = vec![
            option(ReserveAction::BuybackBurn),
            option(ReserveAction::BuybackHold),
        ];
        assert!(freeze_options(&wrong, 123, &marketing).is_err());
    }

    #[test]
    fn marketing_and_lock_parameters_are_fixed() {
        let marketing = Pubkey::new_unique();
        assert_eq!(ReserveAction::MarketingSale.index(), 5);
        assert_eq!(ReserveAction::MarketingSale.try_to_vec().unwrap(), vec![5]);
        let mut marketing_choice = option(ReserveAction::MarketingSale);
        marketing_choice.recipient = Pubkey::new_unique();
        assert!(freeze_options(
            &[option(ReserveAction::Accumulate), marketing_choice.clone()],
            1,
            &marketing
        )
        .is_err());
        marketing_choice.recipient = marketing;
        assert!(freeze_options(
            &[option(ReserveAction::Accumulate), marketing_choice],
            1,
            &marketing
        )
        .is_ok());
        let mut lock = option(ReserveAction::BuybackLock);
        lock.lock_duration_seconds = 29 * 86_400;
        assert!(freeze_options(
            &[option(ReserveAction::Accumulate), lock.clone()],
            1,
            &marketing
        )
        .is_err());
        lock.lock_duration_seconds = PERMANENT_LOCK_SECONDS;
        assert!(freeze_options(&[option(ReserveAction::Accumulate), lock], 1, &marketing).is_ok());
        let mut mstrx_lock = option(ReserveAction::LockMstrx);
        mstrx_lock.lock_duration_seconds = 30 * 86_400;
        mstrx_lock.min_output_raw = 1;
        assert!(freeze_options(
            &[option(ReserveAction::Accumulate), mstrx_lock],
            1,
            &marketing
        )
        .is_err());
    }

    #[test]
    fn no_quorum_and_tie_are_no_ops() {
        assert_eq!(
            settle_vote(&[6, 0], 6, 100).unwrap(),
            (STATUS_REJECTED_NO_QUORUM, None)
        );
        assert_eq!(
            settle_vote(&[4, 4], 8, 100).unwrap(),
            (STATUS_REJECTED_TIE, None)
        );
        assert_eq!(
            settle_vote(&[5, 3], 8, 100).unwrap(),
            (STATUS_PASSED_NOT_EXECUTED, Some(0))
        );
        assert_eq!(quorum_threshold(101).unwrap(), 8);
        assert!(settle_vote(&[5, 3], 7, 100).is_err());
    }

    #[test]
    fn committed_balance_cannot_be_withdrawn() {
        assert_eq!(free_reserve_raw(100, 100).unwrap(), 0);
        assert_eq!(free_reserve_raw(125, 100).unwrap(), 25);
        assert!(free_reserve_raw(99, 100).is_err());
        assert_eq!(free_reserve_raw(100, 0).unwrap(), 100);
    }

    #[test]
    fn initial_ballot_has_review_but_revote_opens_immediately() {
        let (start, end, executable) =
            proposal_schedule(1_000, 3_600, SNAPSHOT_REVIEW_SECONDS).unwrap();
        assert_eq!(start, 1_000 + 86_400);
        assert_eq!(end, start + 3_600);
        assert_eq!(executable, end + 300);
        let (revote_start, revote_end, revote_executable) =
            proposal_schedule(1_000, 3_600, 0).unwrap();
        assert_eq!(revote_start, 1_000);
        assert_eq!(revote_end, 4_600);
        assert_eq!(revote_executable, 4_900);
        assert!(proposal_schedule(i64::MAX, 3_600, SNAPSHOT_REVIEW_SECONDS).is_err());
        assert!(proposal_schedule(i64::MAX, 3_600, 0).is_err());
        assert!(proposal_schedule(1_000, 3_599, 0).is_err());
        assert!(validate_snapshot_window(1_000, 1_000, 2_000, 2_010).is_ok());
        assert!(validate_snapshot_window(1_000, 1_000, 2_000, 3_500).is_ok());
        assert!(validate_snapshot_window(1_000, 1_000, 2_000, 3_501).is_err());
        assert!(validate_snapshot_window(1_000, 999, 2_000, 2_010).is_err());
    }

    #[test]
    fn revote_is_immediate_at_execution_time_and_preserves_exact_commitment() {
        let (mut config, mut previous) = lock_fixtures(30 * 86_400);
        let deadline = previous.executable_at;
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 125, deadline - 1).is_err());
        assert_eq!(
            revote_terms(&config, &Pubkey::default(), &previous, 125, deadline).unwrap(),
            100
        );
        // A later deposit is free, but the old commitment cannot be borrowed.
        assert_eq!(
            free_reserve_raw(125, config.committed_reserve_raw_mstrx).unwrap(),
            25
        );
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 99, deadline).is_err());
        config.committed_reserve_raw_mstrx = 99;
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 125, deadline).is_err());
        config.committed_reserve_raw_mstrx = 100;
        config.active_proposal_id = 0;
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 125, deadline).is_err());
        config.active_proposal_id = previous.id;
        previous.status = STATUS_SUPERSEDED;
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 125, deadline).is_err());
        previous.status = STATUS_EXECUTED;
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 125, deadline).is_err());
        previous.status = STATUS_ACTIVE_REVOTE;
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 125, deadline).is_err());
        previous.status = STATUS_REVOTE_NO_QUORUM;
        previous.winning_option = NO_WINNING_OPTION;
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 125, deadline - 1).is_err());
        assert_eq!(
            revote_terms(&config, &Pubkey::default(), &previous, 125, deadline).unwrap(),
            100
        );
        previous.status = STATUS_REVOTE_TIE;
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 125, deadline - 1).is_err());
        assert_eq!(
            revote_terms(&config, &Pubkey::default(), &previous, 125, deadline).unwrap(),
            100
        );
        previous.winning_option = 0;
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 125, deadline).is_err());
        previous.status = STATUS_PASSED_NOT_EXECUTED;
        assert!(revote_terms(&config, &Pubkey::default(), &previous, 125, deadline).is_err());
    }

    #[test]
    fn failed_revote_retains_commitment_until_holders_choose_accumulate_or_spend() {
        let options = freeze_options(
            &[
                option(ReserveAction::Accumulate),
                option(ReserveAction::BuybackBurn),
            ],
            100,
            &Pubkey::new_unique(),
        )
        .unwrap();
        assert_eq!(
            ballot_finalization_transition(
                STATUS_ACTIVE_REVOTE,
                STATUS_REJECTED_NO_QUORUM,
                None,
                &options,
                100,
                100,
                2,
            )
            .unwrap(),
            (STATUS_REVOTE_NO_QUORUM, 100, 2)
        );
        assert_eq!(
            ballot_finalization_transition(
                STATUS_ACTIVE_REVOTE,
                STATUS_REJECTED_TIE,
                None,
                &options,
                100,
                100,
                2,
            )
            .unwrap(),
            (STATUS_REVOTE_TIE, 100, 2)
        );
        assert_eq!(
            ballot_finalization_transition(
                STATUS_ACTIVE_REVOTE,
                STATUS_PASSED_NOT_EXECUTED,
                Some(0),
                &options,
                100,
                100,
                2,
            )
            .unwrap(),
            (STATUS_EXECUTED, 0, 0)
        );
        assert_eq!(
            ballot_finalization_transition(
                STATUS_ACTIVE_REVOTE,
                STATUS_PASSED_NOT_EXECUTED,
                Some(1),
                &options,
                100,
                100,
                2,
            )
            .unwrap(),
            (STATUS_PASSED_NOT_EXECUTED, 100, 2)
        );
        assert_eq!(
            ballot_finalization_transition(
                STATUS_ACTIVE,
                STATUS_REJECTED_NO_QUORUM,
                None,
                &options,
                100,
                100,
                1,
            )
            .unwrap(),
            (STATUS_REJECTED_NO_QUORUM, 0, 0)
        );
        assert!(ballot_finalization_transition(
            STATUS_SUPERSEDED,
            STATUS_REJECTED_NO_QUORUM,
            None,
            &options,
            100,
            100,
            1,
        )
        .is_err());
        for closed_status in [STATUS_REVOTE_NO_QUORUM, STATUS_REVOTE_TIE, STATUS_EXECUTED] {
            assert!(ballot_finalization_transition(
                closed_status,
                STATUS_REJECTED_NO_QUORUM,
                None,
                &options,
                100,
                100,
                2,
            )
            .is_err());
        }
        // The only withdrawal route computes free balance from the unchanged
        // commitment, so none of these closed statuses creates free MSTRx.
        for _closed_status in [
            STATUS_SUPERSEDED,
            STATUS_REVOTE_NO_QUORUM,
            STATUS_REVOTE_TIE,
        ] {
            assert_eq!(free_reserve_raw(100, 100).unwrap(), 0);
            assert_eq!(free_reserve_raw(120, 100).unwrap(), 20);
        }
    }

    #[test]
    fn rejected_and_accumulate_outcomes_release_commitment() {
        let options = freeze_options(
            &[
                option(ReserveAction::Accumulate),
                option(ReserveAction::BuybackBurn),
            ],
            100,
            &Pubkey::new_unique(),
        )
        .unwrap();
        assert_eq!(
            finalization_transition(STATUS_REJECTED_NO_QUORUM, None, &options, 100, 100, 7)
                .unwrap(),
            (STATUS_REJECTED_NO_QUORUM, 0, 0)
        );
        assert_eq!(
            finalization_transition(STATUS_REJECTED_TIE, None, &options, 100, 100, 7).unwrap(),
            (STATUS_REJECTED_TIE, 0, 0)
        );
        assert_eq!(
            finalization_transition(STATUS_PASSED_NOT_EXECUTED, Some(0), &options, 100, 100, 7)
                .unwrap(),
            (STATUS_EXECUTED, 0, 0)
        );
        assert_eq!(
            finalization_transition(STATUS_PASSED_NOT_EXECUTED, Some(1), &options, 100, 100, 7)
                .unwrap(),
            (STATUS_PASSED_NOT_EXECUTED, 100, 7)
        );
        assert!(
            finalization_transition(STATUS_PASSED_NOT_EXECUTED, Some(1), &options, 99, 100, 7)
                .is_err()
        );
        assert!(finalization_transition(
            STATUS_PASSED_NOT_EXECUTED,
            Some(2),
            &options,
            100,
            100,
            7
        )
        .is_err());
        assert!(
            finalization_transition(STATUS_PASSED_NOT_EXECUTED, None, &options, 100, 100, 7)
                .is_err()
        );
        assert!(finalization_transition(STATUS_ACTIVE, None, &options, 100, 100, 7).is_err());
        let mut malformed = options.clone();
        malformed[0].reserve_raw_mstrx = 1;
        assert!(finalization_transition(
            STATUS_PASSED_NOT_EXECUTED,
            Some(0),
            &malformed,
            100,
            100,
            7
        )
        .is_err());
    }

    #[test]
    fn lock_execution_requires_exact_committed_winning_action_and_delay() {
        let duration = 30 * 86_400;
        let (mut config, mut proposal) = lock_fixtures(duration);
        assert_eq!(
            lock_execution_terms(&config, &proposal, 125, 6_000).unwrap(),
            (100, duration, 6_000 + i64::from(duration))
        );
        // New deposits are free, but the frozen 100 must remain in custody.
        assert!(lock_execution_terms(&config, &proposal, 99, 6_000).is_err());
        assert!(lock_execution_terms(&config, &proposal, 125, proposal.executable_at - 1).is_err());
        config.committed_reserve_raw_mstrx = 99;
        assert!(lock_execution_terms(&config, &proposal, 125, 6_000).is_err());
        config.committed_reserve_raw_mstrx = 100;
        config.active_proposal_id = 2;
        assert!(lock_execution_terms(&config, &proposal, 125, 6_000).is_err());
        config.active_proposal_id = 1;
        proposal.options[1].reserve_raw_mstrx = 99;
        assert!(lock_execution_terms(&config, &proposal, 125, 6_000).is_err());
        proposal.options[1].reserve_raw_mstrx = 100;
        proposal.winning_option = 0;
        assert!(lock_execution_terms(&config, &proposal, 125, 6_000).is_err());
        proposal.winning_option = 1;
        proposal.status = STATUS_EXECUTED;
        assert!(lock_execution_terms(&config, &proposal, 125, 6_000).is_err());
    }

    #[test]
    fn lock_duration_and_release_are_bounded_and_replay_safe() {
        let (config, proposal) = lock_fixtures(PERMANENT_LOCK_SECONDS);
        assert_eq!(
            lock_execution_terms(&config, &proposal, 100, 6_000).unwrap(),
            (100, PERMANENT_LOCK_SECONDS, 0)
        );
        assert!(lock_release_at(6_000, 42).is_err());
        assert!(lock_release_at(i64::MAX, 30 * 86_400).is_err());
        let mut record = LockRecord {
            proposal: Pubkey::new_unique(),
            config: Pubkey::new_unique(),
            reserve_vault: Pubkey::new_unique(),
            escrow_vault: Pubkey::new_unique(),
            amount: 100,
            locked_at: 6_000,
            release_at: 6_000 + 30 * 86_400,
            duration_seconds: 30 * 86_400,
            status: LOCK_ACTIVE,
            bump: 1,
        };
        assert!(validate_lock_release(&record, 100, record.release_at - 1).is_err());
        assert!(validate_lock_release(&record, 99, record.release_at).is_err());
        assert!(validate_lock_release(&record, 100, record.release_at).is_ok());
        assert!(validate_lock_release(&record, 101, record.release_at).is_ok());
        record.status = LOCK_RELEASED;
        assert!(validate_lock_release(&record, 100, record.release_at).is_err());
        record.status = LOCK_ACTIVE;
        record.duration_seconds = PERMANENT_LOCK_SECONDS;
        record.release_at = 0;
        assert!(validate_lock_release(&record, 100, i64::MAX).is_err());
    }

    #[test]
    fn account_space_matches_maximum_serialized_layout() {
        let config = Config {
            schema_version: SCHEMA_VERSION,
            admin: Pubkey::new_unique(),
            capital_mint: Pubkey::new_unique(),
            capital_token_program: Pubkey::new_unique(),
            reserve_mint: MSTRX_MINT,
            reserve_vault: Pubkey::new_unique(),
            marketing_wallet: Pubkey::new_unique(),
            launched_at: 1,
            launch_slot: 1,
            launch_signature: [1; 64],
            last_proposal_id: 1,
            active_proposal_id: 1,
            committed_reserve_raw_mstrx: 1,
            bump: 1,
        };
        let mut config_bytes = Vec::new();
        config.try_serialize(&mut config_bytes).unwrap();
        assert_eq!(config_bytes.len(), Config::SPACE);

        let mut proposal = snapshot_fixture();
        proposal.options = [
            ReserveAction::Accumulate,
            ReserveAction::BuybackHold,
            ReserveAction::BuybackBurn,
            ReserveAction::BuybackLock,
            ReserveAction::LockMstrx,
            ReserveAction::MarketingSale,
        ]
        .into_iter()
        .map(|action| FrozenOption {
            action,
            lock_duration_seconds: 0,
            recipient: Pubkey::default(),
            reserve_raw_mstrx: 1,
            min_output_raw: 1,
        })
        .collect();
        let mut proposal_bytes = Vec::new();
        proposal.try_serialize(&mut proposal_bytes).unwrap();
        assert_eq!(proposal_bytes.len(), Proposal::SPACE);

        let lock = LockRecord {
            proposal: Pubkey::new_unique(),
            config: Pubkey::new_unique(),
            reserve_vault: Pubkey::new_unique(),
            escrow_vault: Pubkey::new_unique(),
            amount: 1,
            locked_at: 1,
            release_at: 2,
            duration_seconds: 1,
            status: LOCK_ACTIVE,
            bump: 1,
        };
        let mut lock_bytes = Vec::new();
        lock.try_serialize(&mut lock_bytes).unwrap();
        assert_eq!(lock_bytes.len(), LockRecord::SPACE);
    }

    #[test]
    fn snapshot_hashes_match_typescript_format() {
        let mut proposal = snapshot_fixture();
        let voter_a = Pubkey::from_str("EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1").unwrap();
        let voter_b = Pubkey::from_str("8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe").unwrap();
        assert_eq!(
            leaf_hash(&proposal, &voter_a, 100_000),
            hex32("31a5ecbb3a057e18275d934cc00bc4b0f3b00960550f447ca76a6609423ae078")
        );
        assert!(verify_snapshot_proof(&proposal, &voter_a, 100_000, &[]));
        assert!(!verify_snapshot_proof(&proposal, &voter_a, 100_001, &[]));
        assert!(!verify_snapshot_proof(&proposal, &voter_b, 100_000, &[]));

        proposal.leaf_count = 2;
        proposal.total_available_weight = 150_000;
        proposal.merkle_root =
            hex32("17eee2b4b19ad09e3435dd93fd437bf2694b8aee8dcfa159ebff2f20dbff3513");
        let other_leaf = hex32("d0b850c89bf01764bb67e1eb5eaa4a0d07f0866106090b916c9a1e3cec62813a");
        assert!(verify_snapshot_proof(
            &proposal,
            &voter_a,
            100_000,
            &[other_leaf]
        ));
        assert!(!verify_snapshot_proof(
            &proposal,
            &voter_a,
            100_000,
            &[[0_u8; 32]]
        ));
    }
}
