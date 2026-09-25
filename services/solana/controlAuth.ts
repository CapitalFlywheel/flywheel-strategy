import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { normalizeGovernanceProposalPreviewRequest,
  type GovernanceProposalPreviewRequest } from "./governanceProposalPreview";
import type { GovernanceSnapshotManifest } from "./governanceSnapshotPublisher";
import { MARKETING_SALE_POOL } from "./marketingSaleRoute";
import { validateBuybackExecutionIntent, type BuybackExecutionIntent } from "./governanceBuybackIntent";
import { lockReleaseMessage, validateLockReleaseIntent, type LockReleaseIntent,
  type SignedLockRelease } from "./governanceLockReleaseControl";

export const SOLANA_CONTROL_NETWORK = "solana-mainnet-beta" as const;
export const SOLANA_CONTROL_CHALLENGE_MS = 5 * 60_000;
// Keep real-money reserve movement unavailable until the complete governance
// program/executor is independently reviewed, deployed, and its code hash is
// pinned. This is deliberately a source-controlled release gate, not an env
// switch that can accidentally enable the prototype on a server.
export const SOLANA_GOVERNANCE_RESERVE_WITHDRAWAL_RELEASED = false;
/** Ballot finalization only changes the tally/commitment; still kept off until
 * the Solana governance binary and owner control path have been rehearsed. */
export const SOLANA_GOVERNANCE_FINALIZE_RELEASED = false;
/** Owner ballot creation remains unavailable until program, executors and
 * this exact-intent path are reviewed together. No environment override. */
export const SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED = false;

export const SOLANA_CONTROL_ACTIONS = new Set([
  "verify_launch_config", "arm_launch_detection", "disarm_launch_detection", "activate_postlaunch",
  "sweep_curve_fees", "sweep_pumpswap_fees", "pause_conversions", "resume_conversions",
  "recover_uncommitted", "reconcile_fee_receipts",
  "prepare_reward_epoch", "distribute_reward_epoch", "finalize_reward_epoch",
  "withdraw_free_reserve",
  "finalize_vote",
  "create_proposal", "create_revote", "publish_snapshot", "execute_lock_mstrx", "execute_marketing_sale",
  "execute_buyback", "release_lock_mstrx",
]);

export interface FreeReserveWithdrawalIntent {
  amountRaw: string;
  governanceProgram: string;
  programCodeSha256: string;
  reserveMint: string;
  reserveVault: string;
  capitalMint: string;
  adminAta: string;
  verifiedAt: number;
}

export interface FinalizeVoteIntent {
  governanceProgram: string;
  programCodeSha256: string;
  reserveMint: string;
  reserveVault: string;
  capitalMint: string;
  config: string;
  proposalId: string;
  proposal: string;
  proposalStateSha256: string;
  frozenReserveRawMstrx: string;
  executableAt: number;
  verifiedAt: number;
}

export interface ProposalControlIntent {
  request: GovernanceProposalPreviewRequest;
  previewHash: string;
  auditedAtUnix: number;
  governanceProgram: string;
  programCodeSha256: string;
  reserveMint: string;
  capitalMint: string;
  config: string;
  reserveVault: string;
  proposalId: string;
  proposal: string;
  frozenReserveRawMstrx: string;
  previousProposal?: string;
  fixedMarketingRecipient: string;
  publication: GovernanceSnapshotManifest;
}

export interface SnapshotPublicationIntent {
  governanceProgram: string;
  programCodeSha256: string;
  capitalMint: string;
  reserveMint: string;
  proposalId: string;
  verifiedAt: number;
}

export interface LockExecutionIntent {
  governanceProgram: string;
  programCodeSha256: string;
  reserveMint: string;
  reserveVault: string;
  capitalMint: string;
  capitalTokenProgram: string;
  config: string;
  proposalId: string;
  proposal: string;
  lockRecord: string;
  lockVault: string;
  proposalStateSha256: string;
  frozenReserveRawMstrx: string;
  lockDurationSeconds: number;
  executableAt: number;
  verifiedAt: number;
}

export interface MarketingExecutionIntent {
  governanceProgram: string;
  programCodeSha256: string;
  reserveMint: string;
  reserveVault: string;
  capitalMint: string;
  capitalTokenProgram: string;
  config: string;
  proposalId: string;
  proposal: string;
  receipt: string;
  trader: string;
  recipient: string;
  proposalStateSha256: string;
  frozenReserveRawMstrx: string;
  votedMinSolLamports: string;
  executionMinSolLamports: string;
  pool: string;
  bitmap: string;
  tickArrayAddresses: string[];
  executableAt: number;
  verifiedAt: number;
}

const MAX_U64 = (1n << 64n) - 1n;

export function validateFreeReserveWithdrawalIntent(intent: FreeReserveWithdrawalIntent, issuedAt: number) {
  if (!/^[1-9]\d{0,19}$/.test(intent.amountRaw) || BigInt(intent.amountRaw) > MAX_U64) {
    throw new Error("RESERVE_WITHDRAWAL_AMOUNT_INVALID");
  }
  for (const address of [intent.governanceProgram, intent.reserveMint, intent.reserveVault, intent.capitalMint, intent.adminAta]) {
    try { if (new PublicKey(address).toBase58() !== address) throw new Error(); }
    catch { throw new Error("RESERVE_WITHDRAWAL_IDENTITY_INVALID"); }
  }
  if (!/^[a-f0-9]{64}$/.test(intent.programCodeSha256)) throw new Error("RESERVE_WITHDRAWAL_HASH_INVALID");
  if (!Number.isSafeInteger(intent.verifiedAt) || intent.verifiedAt > issuedAt + 30_000
    || issuedAt - intent.verifiedAt > 90_000) throw new Error("RESERVE_WITHDRAWAL_QUOTE_STALE");
}

export function validateFinalizeVoteIntent(intent: FinalizeVoteIntent, issuedAt: number) {
  for (const address of [intent.governanceProgram, intent.reserveMint, intent.reserveVault,
    intent.capitalMint, intent.config, intent.proposal]) {
    try { if (new PublicKey(address).toBase58() !== address) throw new Error(); }
    catch { throw new Error("GOVERNANCE_FINALIZE_IDENTITY_INVALID"); }
  }
  if (!/^[a-f0-9]{64}$/.test(intent.programCodeSha256)
    || !/^[a-f0-9]{64}$/.test(intent.proposalStateSha256)) {
    throw new Error("GOVERNANCE_FINALIZE_HASH_INVALID");
  }
  if (!/^[1-9]\d{0,19}$/.test(intent.proposalId) || BigInt(intent.proposalId) > MAX_U64
    || !/^[1-9]\d{0,19}$/.test(intent.frozenReserveRawMstrx)
    || BigInt(intent.frozenReserveRawMstrx) > MAX_U64) {
    throw new Error("GOVERNANCE_FINALIZE_AMOUNT_INVALID");
  }
  const program = new PublicKey(intent.governanceProgram);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program);
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(BigInt(intent.proposalId));
  const [proposal] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], program);
  if (config.toBase58() !== intent.config || proposal.toBase58() !== intent.proposal) {
    throw new Error("GOVERNANCE_FINALIZE_PDA_MISMATCH");
  }
  if (!Number.isSafeInteger(intent.executableAt) || intent.executableAt <= 0 || intent.executableAt > 8_640_000_000_000
    || !Number.isSafeInteger(intent.verifiedAt)
    || intent.verifiedAt > issuedAt + 30_000 || issuedAt - intent.verifiedAt > 90_000) {
    throw new Error("GOVERNANCE_FINALIZE_QUOTE_STALE");
  }
}

export function validateProposalControlIntent(intent: ProposalControlIntent, issuedAt: number) {
  const request = normalizeGovernanceProposalPreviewRequest(intent.request);
  if (JSON.stringify(request) !== JSON.stringify(intent.request)
    || !request.options.some((option) => option.action === "ACCUMULATE")
    || new Set(request.options.map((option) => option.action)).size !== request.options.length) {
    throw new Error("GOVERNANCE_PROPOSAL_OPTIONS_INVALID");
  }
  const addresses = [intent.governanceProgram, intent.reserveMint, intent.capitalMint,
    intent.config, intent.reserveVault, intent.proposal, intent.fixedMarketingRecipient,
    ...(intent.previousProposal ? [intent.previousProposal] : [])];
  try {
    if (addresses.some((address) => new PublicKey(address).toBase58() !== address)) throw new Error();
  } catch { throw new Error("GOVERNANCE_PROPOSAL_IDENTITY_INVALID"); }
  if (![intent.previewHash, intent.programCodeSha256, intent.publication?.merkleRoot,
    intent.publication?.sourceSha256, intent.publication?.snapshotSha256]
    .every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("GOVERNANCE_PROPOSAL_HASH_INVALID");
  }
  if (intent.publication.version !== 2 || intent.publication.network !== SOLANA_CONTROL_NETWORK
    || intent.publication.proposalId !== intent.proposalId
    || !/^(0|[1-9]\d*)$/.test(intent.publication.totalAvailableWeight)
    || intent.publication.source !== `governance/proposals/${intent.proposalId}/source.json`
    || intent.publication.snapshot !== `governance/proposals/${intent.proposalId}/snapshot.json`) {
    throw new Error("GOVERNANCE_PROPOSAL_PUBLICATION_INVALID");
  }
  if (!/^[1-9]\d{0,19}$/.test(intent.proposalId) || BigInt(intent.proposalId) > MAX_U64
    || (request.mode === "revote" && intent.proposalId === "1")
    || !/^[1-9]\d{0,19}$/.test(intent.frozenReserveRawMstrx)
    || BigInt(intent.frozenReserveRawMstrx) > MAX_U64) {
    throw new Error("GOVERNANCE_PROPOSAL_AMOUNT_INVALID");
  }
  const program = new PublicKey(intent.governanceProgram);
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
  const seed = Buffer.alloc(8); seed.writeBigUInt64LE(BigInt(intent.proposalId));
  const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], program)[0];
  const priorSeed = Buffer.alloc(8); priorSeed.writeBigUInt64LE(BigInt(intent.proposalId) - 1n);
  const previous = PublicKey.findProgramAddressSync([Buffer.from("proposal"), priorSeed], program)[0];
  if (config.toBase58() !== intent.config || proposal.toBase58() !== intent.proposal
    || (request.mode === "revote" ? intent.previousProposal !== previous.toBase58() : intent.previousProposal !== undefined)) {
    throw new Error("GOVERNANCE_PROPOSAL_PDA_MISMATCH");
  }
  if (!Number.isSafeInteger(intent.auditedAtUnix) || intent.auditedAtUnix <= 0
    || intent.auditedAtUnix > 8_640_000_000
    || !Number.isSafeInteger(intent.publication.publishedAtUnix) || intent.publication.publishedAtUnix <= 0
    || intent.publication.publishedAtUnix > 8_640_000_000
    || intent.publication.publishedAtUnix > intent.auditedAtUnix
    || intent.auditedAtUnix * 1_000 > issuedAt + 30_000
    || issuedAt - intent.auditedAtUnix * 1_000 > 90_000) {
    throw new Error("GOVERNANCE_PROPOSAL_PREVIEW_STALE");
  }
}

export function validateSnapshotPublicationIntent(intent: SnapshotPublicationIntent, issuedAt: number) {
  try {
    for (const address of [intent.governanceProgram, intent.capitalMint, intent.reserveMint]) {
      if (new PublicKey(address).toBase58() !== address) throw new Error();
    }
  } catch { throw new Error("GOVERNANCE_SNAPSHOT_IDENTITY_INVALID"); }
  if (!/^[a-f0-9]{64}$/.test(intent.programCodeSha256)
    || !/^[1-9]\d{0,19}$/.test(intent.proposalId) || BigInt(intent.proposalId) > MAX_U64) {
    throw new Error("GOVERNANCE_SNAPSHOT_INTENT_INVALID");
  }
  if (!Number.isSafeInteger(intent.verifiedAt) || intent.verifiedAt > issuedAt + 30_000
    || issuedAt - intent.verifiedAt > 90_000) throw new Error("GOVERNANCE_SNAPSHOT_QUOTE_STALE");
}

export function validateLockExecutionIntent(intent: LockExecutionIntent, issuedAt: number) {
  const fields = ["governanceProgram", "programCodeSha256", "reserveMint", "reserveVault", "capitalMint",
    "capitalTokenProgram", "config", "proposalId", "proposal", "lockRecord", "lockVault",
    "proposalStateSha256", "frozenReserveRawMstrx", "lockDurationSeconds", "executableAt", "verifiedAt"];
  if (!intent || Object.keys(intent).sort().join("|") !== fields.sort().join("|")) {
    throw new Error("GOVERNANCE_LOCK_INTENT_FIELDS_INVALID");
  }
  let program: PublicKey;
  let mint: PublicKey;
  try {
    const addresses = [intent.governanceProgram, intent.reserveMint, intent.reserveVault, intent.capitalMint,
      intent.capitalTokenProgram, intent.config, intent.proposal, intent.lockRecord, intent.lockVault];
    if (addresses.some((address) => new PublicKey(address).toBase58() !== address)) throw new Error();
    program = new PublicKey(intent.governanceProgram);
    mint = new PublicKey(intent.reserveMint);
  } catch { throw new Error("GOVERNANCE_LOCK_IDENTITY_INVALID"); }
  if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((candidate) =>
    candidate.toBase58() === intent.capitalTokenProgram)
    || !/^[a-f0-9]{64}$/.test(intent.programCodeSha256)
    || !/^[a-f0-9]{64}$/.test(intent.proposalStateSha256)
    || !/^[1-9]\d{0,19}$/.test(intent.proposalId) || BigInt(intent.proposalId) > MAX_U64
    || !/^[1-9]\d{0,19}$/.test(intent.frozenReserveRawMstrx)
    || BigInt(intent.frozenReserveRawMstrx) > MAX_U64) throw new Error("GOVERNANCE_LOCK_IDENTITY_INVALID");
  const proposalSeed = Buffer.alloc(8);
  proposalSeed.writeBigUInt64LE(BigInt(intent.proposalId));
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
  const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), proposalSeed], program)[0];
  const record = PublicKey.findProgramAddressSync([Buffer.from("reserve-lock"), proposal.toBuffer()], program)[0];
  const lockVault = getAssociatedTokenAddressSync(mint, record, true, TOKEN_2022_PROGRAM_ID);
  const vault = getAssociatedTokenAddressSync(mint, config, true, TOKEN_2022_PROGRAM_ID);
  if (intent.config !== config.toBase58() || intent.proposal !== proposal.toBase58()
    || intent.lockRecord !== record.toBase58() || intent.lockVault !== lockVault.toBase58()
    || intent.reserveVault !== vault.toBase58()) throw new Error("GOVERNANCE_LOCK_PDA_MISMATCH");
  const allowedTerms = new Set([30, 90, 180, 365, 730, 1095, 1825]
    .map((days) => days * 86_400).concat(0xffff_ffff));
  if (!allowedTerms.has(intent.lockDurationSeconds)
    || !Number.isSafeInteger(intent.executableAt) || intent.executableAt <= 0
    || !Number.isSafeInteger(intent.verifiedAt) || intent.verifiedAt > issuedAt + 30_000
    || issuedAt - intent.verifiedAt > 90_000) throw new Error("GOVERNANCE_LOCK_PREVIEW_INVALID");
}

export function validateMarketingExecutionIntent(intent: MarketingExecutionIntent, issuedAt: number) {
  const fields = ["governanceProgram", "programCodeSha256", "reserveMint", "reserveVault", "capitalMint",
    "capitalTokenProgram", "config", "proposalId", "proposal", "receipt", "trader", "recipient",
    "proposalStateSha256", "frozenReserveRawMstrx", "votedMinSolLamports", "executionMinSolLamports",
    "pool", "bitmap", "tickArrayAddresses", "executableAt", "verifiedAt"];
  if (!intent || Object.keys(intent).sort().join("|") !== fields.sort().join("|")) {
    throw new Error("GOVERNANCE_MARKETING_INTENT_FIELDS_INVALID");
  }
  const addresses = [intent.governanceProgram, intent.reserveMint, intent.reserveVault, intent.capitalMint,
    intent.capitalTokenProgram, intent.config, intent.proposal, intent.receipt, intent.trader, intent.recipient,
    intent.pool, intent.bitmap];
  if (!Array.isArray(intent.tickArrayAddresses) || intent.tickArrayAddresses.length < 1
    || intent.tickArrayAddresses.length > 4 || new Set(intent.tickArrayAddresses).size !== intent.tickArrayAddresses.length) {
    throw new Error("GOVERNANCE_MARKETING_TICKS_INVALID");
  }
  try {
    for (const address of [...addresses, ...intent.tickArrayAddresses]) {
      if (new PublicKey(address).toBase58() !== address) throw new Error();
    }
  } catch { throw new Error("GOVERNANCE_MARKETING_IDENTITY_INVALID"); }
  if (intent.reserveMint !== MARKETING_SALE_POOL.mstrxMint || intent.pool !== MARKETING_SALE_POOL.pool
    || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((candidate) =>
      candidate.toBase58() === intent.capitalTokenProgram)
    || intent.recipient === PublicKey.default.toBase58()
    || !/^[a-f0-9]{64}$/.test(intent.programCodeSha256)
    || !/^[a-f0-9]{64}$/.test(intent.proposalStateSha256)
    || !/^[1-9]\d{0,19}$/.test(intent.proposalId) || BigInt(intent.proposalId) > MAX_U64) {
    throw new Error("GOVERNANCE_MARKETING_IDENTITY_INVALID");
  }
  const u64 = (value: string) => /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= MAX_U64;
  if (![intent.frozenReserveRawMstrx, intent.votedMinSolLamports, intent.executionMinSolLamports].every(u64)
    || BigInt(intent.executionMinSolLamports) < BigInt(intent.votedMinSolLamports)) {
    throw new Error("GOVERNANCE_MARKETING_AMOUNT_INVALID");
  }
  const program = new PublicKey(intent.governanceProgram);
  const proposalSeed = Buffer.alloc(8);
  proposalSeed.writeBigUInt64LE(BigInt(intent.proposalId));
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
  const proposal = PublicKey.findProgramAddressSync([Buffer.from("proposal"), proposalSeed], program)[0];
  const receipt = PublicKey.findProgramAddressSync([Buffer.from("marketing-sale-receipt"), proposal.toBuffer()], program)[0];
  const trader = PublicKey.findProgramAddressSync([Buffer.from("proposal-trader")], program)[0];
  const bitmap = PublicKey.findProgramAddressSync([Buffer.from("pool_tick_array_bitmap_extension"),
    new PublicKey(intent.pool).toBuffer()], new PublicKey(MARKETING_SALE_POOL.program))[0];
  const vault = getAssociatedTokenAddressSync(new PublicKey(intent.reserveMint), config, true, TOKEN_2022_PROGRAM_ID);
  if (intent.config !== config.toBase58() || intent.proposal !== proposal.toBase58()
    || intent.receipt !== receipt.toBase58() || intent.trader !== trader.toBase58()
    || intent.bitmap !== bitmap.toBase58() || intent.reserveVault !== vault.toBase58()) {
    throw new Error("GOVERNANCE_MARKETING_PDA_MISMATCH");
  }
  if (!Number.isSafeInteger(intent.executableAt) || intent.executableAt <= 0
    || !Number.isSafeInteger(intent.verifiedAt) || intent.verifiedAt > issuedAt + 30_000
    || issuedAt - intent.verifiedAt > 90_000) throw new Error("GOVERNANCE_MARKETING_PREVIEW_STALE");
}

export interface SignedSolanaControlAction {
  network: string;
  action: string;
  signer: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
  withdrawal?: FreeReserveWithdrawalIntent;
  finalization?: FinalizeVoteIntent;
  proposalCreation?: ProposalControlIntent;
  snapshotPublication?: SnapshotPublicationIntent;
  lockExecution?: LockExecutionIntent;
  marketingExecution?: MarketingExecutionIntent;
  buybackExecution?: BuybackExecutionIntent;
  lockRelease?: LockReleaseIntent;
}

export function solanaControlMessage(input: Omit<SignedSolanaControlAction, "signature">) {
  if (input.action === "release_lock_mstrx") {
    if (!input.lockRelease) throw new Error("GOVERNANCE_LOCK_RELEASE_INTENT_REQUIRED");
    if (input.withdrawal !== undefined || input.finalization !== undefined
      || input.proposalCreation !== undefined || input.snapshotPublication !== undefined
      || input.lockExecution !== undefined || input.marketingExecution !== undefined
      || input.buybackExecution !== undefined) throw new Error("GOVERNANCE_LOCK_RELEASE_ACTION_INVALID");
    return lockReleaseMessage(input as Omit<SignedLockRelease, "signature">);
  }
  if (input.lockRelease !== undefined) throw new Error("GOVERNANCE_LOCK_RELEASE_ACTION_INVALID");
  if (input.action === "withdraw_free_reserve") {
    if (!input.withdrawal) throw new Error("RESERVE_WITHDRAWAL_INTENT_REQUIRED");
    validateFreeReserveWithdrawalIntent(input.withdrawal, input.issuedAt);
  } else if (input.withdrawal !== undefined) throw new Error("RESERVE_WITHDRAWAL_ACTION_INVALID");
  if (input.action === "finalize_vote") {
    if (!input.finalization) throw new Error("GOVERNANCE_FINALIZE_INTENT_REQUIRED");
    validateFinalizeVoteIntent(input.finalization, input.issuedAt);
  } else if (input.finalization !== undefined) throw new Error("GOVERNANCE_FINALIZE_ACTION_INVALID");
  if (["create_proposal", "create_revote"].includes(input.action)) {
    if (!input.proposalCreation || input.proposalCreation.request.mode !== (input.action === "create_revote" ? "revote" : "initial")) {
      throw new Error("GOVERNANCE_PROPOSAL_INTENT_REQUIRED");
    }
    validateProposalControlIntent(input.proposalCreation, input.issuedAt);
  } else if (input.proposalCreation !== undefined) throw new Error("GOVERNANCE_PROPOSAL_ACTION_INVALID");
  if (input.action === "publish_snapshot") {
    if (!input.snapshotPublication) throw new Error("GOVERNANCE_SNAPSHOT_INTENT_REQUIRED");
    validateSnapshotPublicationIntent(input.snapshotPublication, input.issuedAt);
  } else if (input.snapshotPublication !== undefined) throw new Error("GOVERNANCE_SNAPSHOT_ACTION_INVALID");
  if (input.action === "execute_lock_mstrx") {
    if (!input.lockExecution) throw new Error("GOVERNANCE_LOCK_INTENT_REQUIRED");
    validateLockExecutionIntent(input.lockExecution, input.issuedAt);
  } else if (input.lockExecution !== undefined) throw new Error("GOVERNANCE_LOCK_ACTION_INVALID");
  if (input.action === "execute_marketing_sale") {
    if (!input.marketingExecution) throw new Error("GOVERNANCE_MARKETING_INTENT_REQUIRED");
    validateMarketingExecutionIntent(input.marketingExecution, input.issuedAt);
  } else if (input.marketingExecution !== undefined) throw new Error("GOVERNANCE_MARKETING_ACTION_INVALID");
  if (input.action === "execute_buyback") {
    if (!input.buybackExecution) throw new Error("GOVERNANCE_BUYBACK_INTENT_REQUIRED");
    validateBuybackExecutionIntent(input.buybackExecution, input.issuedAt);
  } else if (input.buybackExecution !== undefined) throw new Error("GOVERNANCE_BUYBACK_ACTION_INVALID");
  return [
    "FLYWHEEL STRATEGY SOLANA CONTROL",
    `Action: ${input.action}`,
    `Owner: ${input.signer}`,
    "Network: Solana Mainnet Beta",
    "Allocation: 60% holders / 40% strategic reserve",
    ...(input.withdrawal ? [
      `Exact raw MSTRx: ${input.withdrawal.amountRaw}`,
      `Governance program: ${input.withdrawal.governanceProgram}`,
      `Reviewed program SHA-256: ${input.withdrawal.programCodeSha256}`,
      `Reserve mint: ${input.withdrawal.reserveMint}`,
      `Reserve vault: ${input.withdrawal.reserveVault}`,
      `Bound CAPITAL mint: ${input.withdrawal.capitalMint}`,
      `Fixed admin ATA: ${input.withdrawal.adminAta}`,
      `Verified at: ${new Date(input.withdrawal.verifiedAt).toISOString()}`,
    ] : []),
    ...(input.finalization ? [
      `Governance program: ${input.finalization.governanceProgram}`,
      `Reviewed program SHA-256: ${input.finalization.programCodeSha256}`,
      `Reserve mint: ${input.finalization.reserveMint}`,
      `Reserve vault: ${input.finalization.reserveVault}`,
      `Bound CAPITAL mint: ${input.finalization.capitalMint}`,
      `Config PDA: ${input.finalization.config}`,
      `Proposal ID: ${input.finalization.proposalId}`,
      `Proposal PDA: ${input.finalization.proposal}`,
      `Finalized proposal state SHA-256: ${input.finalization.proposalStateSha256}`,
      `Frozen raw MSTRx: ${input.finalization.frozenReserveRawMstrx}`,
      `Executable at: ${new Date(input.finalization.executableAt * 1000).toISOString()}`,
      `Verified at: ${new Date(input.finalization.verifiedAt).toISOString()}`,
    ] : []),
    ...(input.proposalCreation ? [
      `Governance program: ${input.proposalCreation.governanceProgram}`,
      `Reviewed program SHA-256: ${input.proposalCreation.programCodeSha256}`,
      `Reserve mint: ${input.proposalCreation.reserveMint}`,
      `Bound CAPITAL mint: ${input.proposalCreation.capitalMint}`,
      `Config PDA: ${input.proposalCreation.config}`,
      `Reserve vault: ${input.proposalCreation.reserveVault}`,
      `Proposal ID: ${input.proposalCreation.proposalId}`,
      `Proposal PDA: ${input.proposalCreation.proposal}`,
      ...(input.proposalCreation.previousProposal ? [`Previous proposal: ${input.proposalCreation.previousProposal}`] : []),
      `Frozen raw MSTRx: ${input.proposalCreation.frozenReserveRawMstrx}`,
      `Fixed marketing recipient: ${input.proposalCreation.fixedMarketingRecipient}`,
      `Voting duration seconds: ${input.proposalCreation.request.votingDurationSeconds}`,
      ...input.proposalCreation.request.options.map((option, index) =>
        `Option ${index + 1}: ${option.action} | minimum raw output ${option.minOutputRaw ?? "0"} | lock seconds ${option.lockDurationSeconds ?? 0}`),
      `Published snapshot root: ${input.proposalCreation.publication.merkleRoot}`,
      `Published total voting weight: ${input.proposalCreation.publication.totalAvailableWeight}`,
      `Published source SHA-256: ${input.proposalCreation.publication.sourceSha256}`,
      `Published snapshot SHA-256: ${input.proposalCreation.publication.snapshotSha256}`,
      `Publication time: ${new Date(input.proposalCreation.publication.publishedAtUnix * 1_000).toISOString()}`,
      `Exact preview SHA-256: ${input.proposalCreation.previewHash}`,
      `Audited at: ${new Date(input.proposalCreation.auditedAtUnix * 1_000).toISOString()}`,
    ] : []),
    ...(input.snapshotPublication ? [
      `Governance program: ${input.snapshotPublication.governanceProgram}`,
      `Reviewed program SHA-256: ${input.snapshotPublication.programCodeSha256}`,
      `Bound CAPITAL mint: ${input.snapshotPublication.capitalMint}`,
      `Reserve mint: ${input.snapshotPublication.reserveMint}`,
      `Next proposal ID: ${input.snapshotPublication.proposalId}`,
      `Verified at: ${new Date(input.snapshotPublication.verifiedAt).toISOString()}`,
      "Purpose: audit and publish a holder voting snapshot; no onchain transaction",
    ] : []),
    ...(input.lockExecution ? [
      `Governance program: ${input.lockExecution.governanceProgram}`,
      `Reviewed program SHA-256: ${input.lockExecution.programCodeSha256}`,
      `Reserve mint: ${input.lockExecution.reserveMint}`,
      `Reserve vault: ${input.lockExecution.reserveVault}`,
      `Bound CAPITAL mint: ${input.lockExecution.capitalMint}`,
      `CAPITAL token program: ${input.lockExecution.capitalTokenProgram}`,
      `Config PDA: ${input.lockExecution.config}`,
      `Proposal ID: ${input.lockExecution.proposalId}`,
      `Proposal PDA: ${input.lockExecution.proposal}`,
      `Finalized proposal SHA-256: ${input.lockExecution.proposalStateSha256}`,
      `Frozen raw MSTRx: ${input.lockExecution.frozenReserveRawMstrx}`,
      `Lock duration seconds: ${input.lockExecution.lockDurationSeconds}`,
      `Lock record PDA: ${input.lockExecution.lockRecord}`,
      `Lock vault ATA: ${input.lockExecution.lockVault}`,
      `Executable at: ${new Date(input.lockExecution.executableAt * 1000).toISOString()}`,
      `Verified at: ${new Date(input.lockExecution.verifiedAt).toISOString()}`,
    ] : []),
    ...(input.marketingExecution ? [
      `Governance program: ${input.marketingExecution.governanceProgram}`,
      `Reviewed program SHA-256: ${input.marketingExecution.programCodeSha256}`,
      `Reserve mint: ${input.marketingExecution.reserveMint}`,
      `Reserve vault: ${input.marketingExecution.reserveVault}`,
      `Bound CAPITAL mint: ${input.marketingExecution.capitalMint}`,
      `CAPITAL token program: ${input.marketingExecution.capitalTokenProgram}`,
      `Config PDA: ${input.marketingExecution.config}`,
      `Proposal ID: ${input.marketingExecution.proposalId}`,
      `Proposal PDA: ${input.marketingExecution.proposal}`,
      `Finalized proposal SHA-256: ${input.marketingExecution.proposalStateSha256}`,
      `Frozen raw MSTRx: ${input.marketingExecution.frozenReserveRawMstrx}`,
      `Voted minimum SOL lamports: ${input.marketingExecution.votedMinSolLamports}`,
      `Execution minimum SOL lamports: ${input.marketingExecution.executionMinSolLamports}`,
      `Fixed marketing recipient: ${input.marketingExecution.recipient}`,
      `Marketing receipt PDA: ${input.marketingExecution.receipt}`,
      `Trader PDA: ${input.marketingExecution.trader}`,
      `Raydium pool: ${input.marketingExecution.pool}`,
      `Raydium bitmap: ${input.marketingExecution.bitmap}`,
      ...input.marketingExecution.tickArrayAddresses.map((address, index) => `Tick array ${index + 1}: ${address}`),
      `Executable at: ${new Date(input.marketingExecution.executableAt * 1000).toISOString()}`,
      `Verified at: ${new Date(input.marketingExecution.verifiedAt).toISOString()}`,
    ] : []),
    ...(input.buybackExecution ? [
      `Governance program: ${input.buybackExecution.governanceProgram}`,
      `Reviewed program SHA-256: ${input.buybackExecution.programCodeSha256}`,
      `Reserve mint: ${input.buybackExecution.reserveMint}`,
      `Reserve vault: ${input.buybackExecution.reserveVault}`,
      `Bound CAPITAL mint: ${input.buybackExecution.capitalMint}`,
      `CAPITAL token program: ${input.buybackExecution.capitalTokenProgram}`,
      `Config PDA: ${input.buybackExecution.config}`,
      `Proposal ID: ${input.buybackExecution.proposalId}`,
      `Proposal PDA: ${input.buybackExecution.proposal}`,
      `Finalized proposal SHA-256: ${input.buybackExecution.proposalStateSha256}`,
      `Winning action: ${input.buybackExecution.action}`,
      `Frozen raw MSTRx: ${input.buybackExecution.frozenReserveRawMstrx}`,
      `Voted minimum raw CAPITAL: ${input.buybackExecution.votedMinOutputRawCapital}`,
      `Lock duration seconds: ${input.buybackExecution.lockDurationSeconds}`,
      `Buyback receipt PDA: ${input.buybackExecution.receipt}`,
      `Trader PDA: ${input.buybackExecution.trader}`,
      `Venue phase: ${input.buybackExecution.venueState.phase}`,
      `Venue address: ${input.buybackExecution.venueState.phase === "curve"
        ? input.buybackExecution.venueState.bondingCurveAddress : input.buybackExecution.venueState.poolAddress}`,
      `Venue state SHA-256: ${createHash("sha256").update(JSON.stringify(input.buybackExecution.venueState)).digest("hex")}`,
      `Executable at: ${new Date(input.buybackExecution.executableAt * 1000).toISOString()}`,
      `Verified at: ${new Date(input.buybackExecution.verifiedAt).toISOString()}`,
    ] : []),
    `Issued: ${new Date(input.issuedAt).toISOString()}`,
    `Expires: ${new Date(input.expiresAt).toISOString()}`,
    `Nonce: ${input.nonce}`,
  ].join("\n");
}

export function verifySignedSolanaControlAction(
  input: SignedSolanaControlAction,
  expectedOwner: string,
  now = Date.now(),
) {
  if (input.network !== SOLANA_CONTROL_NETWORK || !SOLANA_CONTROL_ACTIONS.has(input.action)) {
    throw new Error("CONTROL_ACTION_INVALID");
  }
  let signer: PublicKey;
  try { signer = new PublicKey(input.signer); } catch { throw new Error("SIGNER_NOT_OWNER"); }
  if (signer.toBase58() !== input.signer || signer.toBase58() !== new PublicKey(expectedOwner).toBase58()) {
    throw new Error("SIGNER_NOT_OWNER");
  }
  if (!Number.isSafeInteger(input.issuedAt) || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt !== input.issuedAt + SOLANA_CONTROL_CHALLENGE_MS
    || input.issuedAt > now + 30_000 || input.expiresAt < now) {
    throw new Error("CONTROL_CHALLENGE_EXPIRED");
  }
  if (!/^[a-f0-9]{40}$/.test(input.nonce)) throw new Error("CONTROL_NONCE_INVALID");
  if (input.action === "withdraw_free_reserve") {
    if (!input.withdrawal) throw new Error("RESERVE_WITHDRAWAL_INTENT_REQUIRED");
    validateFreeReserveWithdrawalIntent(input.withdrawal, input.issuedAt);
  } else if (input.withdrawal !== undefined) throw new Error("RESERVE_WITHDRAWAL_ACTION_INVALID");
  if (input.action === "finalize_vote") {
    if (!input.finalization) throw new Error("GOVERNANCE_FINALIZE_INTENT_REQUIRED");
    validateFinalizeVoteIntent(input.finalization, input.issuedAt);
  } else if (input.finalization !== undefined) throw new Error("GOVERNANCE_FINALIZE_ACTION_INVALID");
  if (["create_proposal", "create_revote"].includes(input.action)) {
    if (!input.proposalCreation || input.proposalCreation.request.mode !== (input.action === "create_revote" ? "revote" : "initial")) {
      throw new Error("GOVERNANCE_PROPOSAL_INTENT_REQUIRED");
    }
    validateProposalControlIntent(input.proposalCreation, input.issuedAt);
  } else if (input.proposalCreation !== undefined) throw new Error("GOVERNANCE_PROPOSAL_ACTION_INVALID");
  if (input.action === "publish_snapshot") {
    if (!input.snapshotPublication) throw new Error("GOVERNANCE_SNAPSHOT_INTENT_REQUIRED");
    validateSnapshotPublicationIntent(input.snapshotPublication, input.issuedAt);
  } else if (input.snapshotPublication !== undefined) throw new Error("GOVERNANCE_SNAPSHOT_ACTION_INVALID");
  if (input.action === "execute_lock_mstrx") {
    if (!input.lockExecution) throw new Error("GOVERNANCE_LOCK_INTENT_REQUIRED");
    validateLockExecutionIntent(input.lockExecution, input.issuedAt);
  } else if (input.lockExecution !== undefined) throw new Error("GOVERNANCE_LOCK_ACTION_INVALID");
  if (input.action === "execute_marketing_sale") {
    if (!input.marketingExecution) throw new Error("GOVERNANCE_MARKETING_INTENT_REQUIRED");
    validateMarketingExecutionIntent(input.marketingExecution, input.issuedAt);
  } else if (input.marketingExecution !== undefined) throw new Error("GOVERNANCE_MARKETING_ACTION_INVALID");
  if (input.action === "execute_buyback") {
    if (!input.buybackExecution) throw new Error("GOVERNANCE_BUYBACK_INTENT_REQUIRED");
    validateBuybackExecutionIntent(input.buybackExecution, input.issuedAt);
  } else if (input.buybackExecution !== undefined) throw new Error("GOVERNANCE_BUYBACK_ACTION_INVALID");
  if (input.action === "release_lock_mstrx") {
    if (!input.lockRelease) throw new Error("GOVERNANCE_LOCK_RELEASE_INTENT_REQUIRED");
    validateLockReleaseIntent(input.lockRelease, input.issuedAt);
  } else if (input.lockRelease !== undefined) throw new Error("GOVERNANCE_LOCK_RELEASE_ACTION_INVALID");
  let signature: Uint8Array;
  try { signature = bs58.decode(input.signature); } catch { throw new Error("SIGNATURE_INVALID"); }
  if (signature.length !== 64 || !nacl.sign.detached.verify(
    new TextEncoder().encode(solanaControlMessage(input)), signature, signer.toBytes(),
  )) throw new Error("SIGNATURE_INVALID");
  return true;
}
