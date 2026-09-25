import { createHash } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountMeta } from "@solana/web3.js";
import {
  BUYBACK_QUOTE_MINT, createBuybackInstructionManifest, PUMP_BUYBACK_PROGRAM,
  type BuybackVenueState,
} from "./pumpBuybackInstructionManifest";
import { deriveGovernanceReserveRoute, type GovernanceReserveRoute } from "./governanceVaultRoute";
import type { GovernanceProposalStatus } from "./governanceProposalStatus";
import { MARKETING_SALE_POOL } from "./marketingSaleRoute";
import { buildPinnedRaydiumSwapV2Manifest, type MarketingSwapView } from "./raydiumSwapV2Manifest";

// Outer Anchor instruction serialization only. These drafts never sign, send,
// or bypass the unreleased onchain executors. A caller must separately verify
// both finalized RPC views, live proposal/vault state, quote and transaction.
const U64_MAX = (1n << 64n) - 1n;
const TRADER_SEED = Buffer.from("proposal-trader");
const HOLD_SEED = Buffer.from("capital-hold");
const BUYBACK_RECEIPT_SEED = Buffer.from("buyback-receipt");
const MARKETING_RECEIPT_SEED = Buffer.from("marketing-sale-receipt");
const CURVE_SEED = Buffer.from("bonding-curve");
const BITMAP_SEED = Buffer.from("pool_tick_array_bitmap_extension");
const ZERO = PublicKey.default.toBase58();

const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const exactKeys = (value: object, names: readonly string[]) => {
  if (Object.keys(value).sort().join("|") !== [...names].sort().join("|")) {
    throw new Error("GOVERNANCE_EXECUTION_EXTRA_FIELDS");
  }
};
const key = (value: string) => {
  const parsed = new PublicKey(value);
  if (parsed.toBase58() !== value) {
    throw new Error("GOVERNANCE_EXECUTION_ADDRESS_INVALID");
  }
  return parsed;
};
const u64 = (value: bigint, code = "GOVERNANCE_EXECUTION_U64_INVALID") => {
  if (typeof value !== "bigint" || value <= 0n || value > U64_MAX) throw new Error(code);
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};
const decimalU64 = (value: string) => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error("GOVERNANCE_EXECUTION_U64_INVALID");
  }
  const parsed = BigInt(value);
  u64(parsed);
  return parsed;
};
const pda = (program: PublicKey, ...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
const ata = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta =>
  ({ pubkey, isWritable, isSigner });

export interface GovernanceExecutionDraft {
  programId: PublicKey;
  data: Buffer;
  keys: readonly AccountMeta[];
  proposal: PublicKey;
  receipt: PublicKey;
  /** This is a serialization audit, not an authorization or release signal. */
  executionPermitted: false;
}

interface CommonExecutionInput {
  route: GovernanceReserveRoute;
  payer: string;
  capitalTokenProgram: string;
}

interface SpendingInput extends CommonExecutionInput {
  proposalStatus: GovernanceProposalStatus;
  observedClockUnix: number;
}

export interface BuybackExecutionInput extends SpendingInput {
  venueState: BuybackVenueState;
}

export interface MarketingSaleExecutionInput extends SpendingInput {
  executionMinSolLamports: bigint;
  marketViews: readonly [MarketingSwapView, MarketingSwapView];
}

export interface LockMstrxExecutionInput extends SpendingInput {}

export interface ReleaseCapitalLockInput extends CommonExecutionInput {
  /** Historical executed proposal; it need not be the current active ballot. */
  proposalId: bigint;
}

export interface RefundTraderInput {
  route: GovernanceReserveRoute;
  payer: string;
  lamports: bigint;
}

function identities(input: CommonExecutionInput) {
  const derived = deriveGovernanceReserveRoute(input.route.governanceProgram, input.route.reserveMint);
  if (input.route.reserveAuthority !== derived.authority.toBase58()
    || input.route.capitalMint === input.route.reserveMint
    || input.route.capitalMint === ZERO || input.route.admin !== input.payer
    || input.route.admin === ZERO || derived.program.equals(SystemProgram.programId)
    || !/^[a-f0-9]{64}$/.test(input.route.expectedProgramCodeSha256)) {
    throw new Error("GOVERNANCE_EXECUTION_ROUTE_INVALID");
  }
  const capitalMint = key(input.route.capitalMint);
  const payer = key(input.payer);
  const baseTokenProgram = key(input.capitalTokenProgram);
  if (!baseTokenProgram.equals(TOKEN_PROGRAM_ID) && !baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("GOVERNANCE_EXECUTION_BASE_PROGRAM_INVALID");
  }
  return {
    program: derived.program, config: derived.authority, reserveMint: derived.mint,
    reserveVault: derived.ata, capitalMint, payer, baseTokenProgram,
  };
}

function proposalKey(program: PublicKey, id: bigint) {
  return pda(program, Buffer.from("proposal"), u64(id));
}

function winningOption(input: SpendingInput, permittedActions: readonly string[]) {
  const { proposalStatus: status } = input;
  if (status.status !== 1 || !Number.isSafeInteger(input.observedClockUnix)
    || !Number.isSafeInteger(status.executableAt)
    || input.observedClockUnix < status.executableAt
    || !permittedActions.includes(status.winningAction ?? "")) {
    throw new Error("GOVERNANCE_EXECUTION_DECISION_NOT_READY");
  }
  const id = decimalU64(status.id);
  const commitment = decimalU64(status.frozenRaw);
  const matches = status.options.filter((option) => option.action === status.winningAction);
  if (matches.length !== 1 || decimalU64(matches[0].reserveRaw) !== commitment) {
    throw new Error("GOVERNANCE_EXECUTION_DECISION_INVALID");
  }
  const option = matches[0];
  const votedFloor = decimalU64(option.minOutputRaw);
  if (option.action === "BUYBACK_LOCK") {
    if (!Number.isSafeInteger(option.lockDurationSeconds) || option.lockDurationSeconds <= 0) {
      throw new Error("GOVERNANCE_EXECUTION_DECISION_INVALID");
    }
  } else if (option.lockDurationSeconds !== 0) {
    throw new Error("GOVERNANCE_EXECUTION_DECISION_INVALID");
  }
  if (option.action !== "MARKETING_SALE" && option.recipient !== SystemProgram.programId.toBase58()) {
    throw new Error("GOVERNANCE_EXECUTION_DECISION_INVALID");
  }
  return { id, commitment, votedFloor, option, status };
}

function draft(program: PublicKey, name: string, keys: AccountMeta[], proposal: PublicKey, receipt: PublicKey, args?: Buffer): GovernanceExecutionDraft {
  return { programId: program, data: Buffer.concat([discriminator(name), args ?? Buffer.alloc(0)]),
    keys, proposal, receipt, executionPermitted: false };
}

/** Exact outer accounts for the winning MSTRx lock. No route-specific
 * remaining accounts or alternate destination are accepted. The receipt
 * field names the proposal-specific onchain LockRecord PDA. */
export function buildExecuteLockMstrxDraft(input: LockMstrxExecutionInput): GovernanceExecutionDraft {
  exactKeys(input, ["route", "payer", "capitalTokenProgram", "proposalStatus", "observedClockUnix"]);
  const ids = identities(input);
  const status = input.proposalStatus;
  if (status.status !== 1 || status.winningAction !== "LOCK_MSTRX"
    || !Number.isSafeInteger(input.observedClockUnix)
    || !Number.isSafeInteger(status.executableAt)
    || input.observedClockUnix < status.executableAt) {
    throw new Error("GOVERNANCE_LOCK_DECISION_NOT_READY");
  }
  const id = decimalU64(status.id);
  const frozen = decimalU64(status.frozenRaw);
  const matches = status.options.filter((option) => option.action === "LOCK_MSTRX");
  const option = matches[0];
  const allowedDurations = new Set([30, 90, 180, 365, 730, 1095, 1825].map((days) => days * 86_400));
  allowedDurations.add(0xffff_ffff);
  if (matches.length !== 1 || !option || decimalU64(option.reserveRaw) !== frozen
    || option.minOutputRaw !== "0"
    || option.recipient !== SystemProgram.programId.toBase58()
    || !allowedDurations.has(option.lockDurationSeconds)) {
    throw new Error("GOVERNANCE_LOCK_DECISION_INVALID");
  }
  const proposal = proposalKey(ids.program, id);
  const lockRecord = pda(ids.program, Buffer.from("reserve-lock"), proposal.toBuffer());
  return draft(ids.program, "execute_lock_mstrx", [
    meta(ids.config, true), meta(proposal, true), meta(ids.reserveMint), meta(ids.reserveVault, true),
    meta(lockRecord, true), meta(ata(lockRecord, ids.reserveMint, TOKEN_2022_PROGRAM_ID), true),
    meta(ids.payer, true, true), meta(TOKEN_2022_PROGRAM_ID), meta(ASSOCIATED_TOKEN_PROGRAM_ID),
    meta(SystemProgram.programId),
  ], proposal, lockRecord);
}

/** Exact outer accounts for gated Pump curve/PumpSwap buyback CPI. */
export function buildExecuteBuybackDraft(input: BuybackExecutionInput): GovernanceExecutionDraft {
  exactKeys(input, ["route", "payer", "capitalTokenProgram", "proposalStatus", "observedClockUnix", "venueState"]);
  if (input.venueState.phase === "curve") {
    exactKeys(input.venueState, ["phase", "bondingCurveAddress", "bondingCurveOwner", "complete",
      "curveBaseMint", "curveQuoteMint", "creator", "feeRecipient", "buybackFeeRecipient"]);
  } else if (input.venueState.phase === "pumpSwap") {
    exactKeys(input.venueState, ["phase", "bondingCurveComplete", "poolAddress", "poolOwner", "poolIndex",
      "poolCreator", "poolBaseMint", "poolQuoteMint", "coinCreator", "protocolFeeRecipient"]);
  } else {
    throw new Error("GOVERNANCE_EXECUTION_BUYBACK_VENUE_INVALID");
  }
  const ids = identities(input);
  const decision = winningOption(input, ["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK"]);
  const proposal = proposalKey(ids.program, decision.id);
  const trader = pda(ids.program, TRADER_SEED);
  const holdAuthority = pda(ids.program, HOLD_SEED);
  const receipt = pda(ids.program, BUYBACK_RECEIPT_SEED, proposal.toBuffer());
  const curve = pda(PUMP_BUYBACK_PROGRAM, CURVE_SEED, ids.capitalMint.toBuffer());
  const venue = createBuybackInstructionManifest({
    phase: input.venueState.phase, capitalMint: ids.capitalMint.toBase58(),
    capitalTokenProgram: ids.baseTokenProgram.toBase58(), trader: trader.toBase58(),
    committedQuoteRaw: decision.commitment, votedMinOutputRaw: decision.votedFloor,
    executionMinOutputRaw: decision.votedFloor, venueState: input.venueState,
  });
  if (![27, 23].includes(venue.accounts.length)
    || venue.accounts.find((account) => account.name === "user")?.address !== trader.toBase58()) {
    throw new Error("GOVERNANCE_EXECUTION_BUYBACK_VENUE_INVALID");
  }
  const keys = [
    meta(ids.config, true), meta(proposal, true), meta(ids.reserveMint), meta(ids.reserveVault, true),
    meta(ids.capitalMint, true), meta(trader, true),
    meta(ata(trader, ids.reserveMint, TOKEN_2022_PROGRAM_ID), true),
    meta(ata(trader, ids.capitalMint, ids.baseTokenProgram), true),
    meta(holdAuthority), meta(ata(holdAuthority, ids.capitalMint, ids.baseTokenProgram), true),
    meta(receipt, true), meta(ata(receipt, ids.capitalMint, ids.baseTokenProgram), true),
    // The same curve is writable in the canonical curve remaining vector.
    meta(curve), meta(ids.payer, true, true), meta(TOKEN_2022_PROGRAM_ID),
    meta(ids.baseTokenProgram), meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
    // A PDA cannot sign the outer transaction. Only the onchain invoke_signed
    // raises the inner Pump CPI trader signer privilege.
    ...venue.accounts.map((account) => meta(key(account.address), account.isWritable, false)),
  ];
  return draft(ids.program, "execute_buyback", keys, proposal, receipt);
}

/** Exact outer accounts for permissionless post-lock transfer to public hold custody. */
export function buildReleaseCapitalLockDraft(input: ReleaseCapitalLockInput): GovernanceExecutionDraft {
  exactKeys(input, ["route", "payer", "capitalTokenProgram", "proposalId"]);
  const ids = identities(input);
  const proposal = proposalKey(ids.program, input.proposalId);
  const receipt = pda(ids.program, BUYBACK_RECEIPT_SEED, proposal.toBuffer());
  const holdAuthority = pda(ids.program, HOLD_SEED);
  return draft(ids.program, "release_capital_lock", [
    meta(ids.config), meta(proposal), meta(receipt, true), meta(ids.capitalMint),
    meta(ata(receipt, ids.capitalMint, ids.baseTokenProgram), true), meta(holdAuthority),
    meta(ata(holdAuthority, ids.capitalMint, ids.baseTokenProgram), true),
    meta(ids.payer, true, true), meta(ids.baseTokenProgram),
    meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
  ], proposal, receipt);
}

/** Exact outer accounts for the fixed MSTRx -> WSOL -> marketing SOL route. */
export function buildExecuteMarketingSaleDraft(input: MarketingSaleExecutionInput): GovernanceExecutionDraft {
  exactKeys(input, ["route", "payer", "capitalTokenProgram", "proposalStatus", "observedClockUnix", "executionMinSolLamports", "marketViews"]);
  const ids = identities(input);
  const decision = winningOption(input, ["MARKETING_SALE"]);
  if (decision.option.recipient !== decision.status.fixedMarketingWallet
    || decision.option.recipient === ZERO || decision.option.recipient === SystemProgram.programId.toBase58()) {
    throw new Error("GOVERNANCE_EXECUTION_MARKETING_RECIPIENT_INVALID");
  }
  u64(input.executionMinSolLamports, "GOVERNANCE_EXECUTION_MARKETING_FLOOR_INVALID");
  if (input.executionMinSolLamports < decision.votedFloor
    || MARKETING_SALE_POOL.mstrxMint !== ids.reserveMint.toBase58()) {
    throw new Error("GOVERNANCE_EXECUTION_MARKETING_FLOOR_INVALID");
  }
  const proposal = proposalKey(ids.program, decision.id);
  const receipt = pda(ids.program, MARKETING_RECEIPT_SEED, proposal.toBuffer());
  const trader = pda(ids.program, TRADER_SEED);
  const swap = buildPinnedRaydiumSwapV2Manifest({
    trader: trader.toBase58(), exactInputMstrxRaw: decision.commitment,
    governanceMinWsolOutRaw: decision.votedFloor,
    requestedMinWsolOutRaw: input.executionMinSolLamports, views: input.marketViews,
  });
  const ticks = swap.accounts.filter((account) => account.role.startsWith("tick_array_"));
  if (ticks.length < 1 || ticks.length > 4
    || swap.pool !== MARKETING_SALE_POOL.pool || swap.programId !== MARKETING_SALE_POOL.program) {
    throw new Error("GOVERNANCE_EXECUTION_MARKETING_ROUTE_INVALID");
  }
  const pool = key(MARKETING_SALE_POOL.pool);
  const raydium = key(MARKETING_SALE_POOL.program);
  const bitmap = pda(raydium, BITMAP_SEED, pool.toBuffer());
  return draft(ids.program, "execute_marketing_sale", [
    meta(ids.config, true), meta(proposal, true), meta(receipt, true),
    meta(ids.reserveMint), meta(ids.reserveVault, true), meta(trader, true),
    meta(ata(trader, ids.reserveMint, TOKEN_2022_PROGRAM_ID), true),
    meta(ata(trader, key(MARKETING_SALE_POOL.wsolMint), TOKEN_PROGRAM_ID), true),
    meta(key(decision.option.recipient), true), meta(raydium), meta(pool, true),
    meta(key(MARKETING_SALE_POOL.config)), meta(key(MARKETING_SALE_POOL.observation), true),
    meta(key(MARKETING_SALE_POOL.wsolMint)), meta(key(MARKETING_SALE_POOL.mstrxVault), true),
    meta(key(MARKETING_SALE_POOL.wsolVault), true), meta(bitmap, true),
    meta(key("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")),
    meta(ids.payer, true, true), meta(TOKEN_PROGRAM_ID), meta(TOKEN_2022_PROGRAM_ID),
    meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
    ...ticks.map((tick) => meta(key(tick.pubkey), true)),
  ], proposal, receipt, u64(input.executionMinSolLamports));
}

/** Owner-only surplus-SOL recovery; onchain Config must have no active commitment. */
export function buildRefundTraderDraft(input: RefundTraderInput) {
  exactKeys(input, ["route", "payer", "lamports"]);
  const derived = deriveGovernanceReserveRoute(input.route.governanceProgram, input.route.reserveMint);
  if (input.route.reserveAuthority !== derived.authority.toBase58()
    || input.payer !== input.route.admin
    || input.route.admin === ZERO || derived.program.equals(SystemProgram.programId)
    || !/^[a-f0-9]{64}$/.test(input.route.expectedProgramCodeSha256)) {
    throw new Error("GOVERNANCE_EXECUTION_ROUTE_INVALID");
  }
  const programId = derived.program;
  const data = Buffer.concat([discriminator("refund_trader"),
    u64(input.lamports, "GOVERNANCE_TRADER_REFUND_AMOUNT_INVALID")]);
  const keys = [meta(derived.authority), meta(pda(programId, TRADER_SEED), true),
    meta(key(input.payer), true, true), meta(SystemProgram.programId)];
  return { programId, data, keys, executionPermitted: false as const };
}
