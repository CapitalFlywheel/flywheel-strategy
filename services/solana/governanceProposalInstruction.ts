import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo, type AccountMeta } from "@solana/web3.js";
import {
  freezeGovernanceProposal, governanceWindowStart, RESERVE_ACTIONS,
  type GovernanceOption, type ReserveAction,
} from "./governancePolicy";
import { assertSolanaGovernanceSnapshot, type SolanaGovernanceSnapshot } from "./governanceSnapshot";
import type { GovernanceSnapshotManifest } from "./governanceSnapshotPublisher";
import {
  assertGovernanceReserveAccounts, deriveGovernanceReserveRoute, type GovernanceReserveRoute,
} from "./governanceVaultRoute";

// Mirror programs/solana-governance/src/lib.rs. This prototype cannot create a
// proposal while the program's initialize/create_proposal release flag is false.
const GOVERNANCE_PROPOSALS_RELEASED = false;
const RELEASED_EXECUTORS: ReadonlySet<ReserveAction> = new Set();
const CREATE_PROPOSAL_DISCRIMINATOR = createHash("sha256").update("global:create_proposal").digest().subarray(0, 8);
const CREATE_REVOTE_DISCRIMINATOR = createHash("sha256").update("global:create_revote").digest().subarray(0, 8);
const PROPOSAL_DISCRIMINATOR = createHash("sha256").update("account:Proposal").digest().subarray(0, 8);
const PROPOSAL_ACCOUNT_LENGTH = 726;
const ZERO_PUBKEY = new PublicKey(new Uint8Array(32));
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const INITIAL_PUBLIC_REVIEW_SECONDS = 86_400;
const MAX_PROPOSAL_SNAPSHOT_AGE_SECONDS = 25 * 60;
const MAX_ACCOUNT_VIEW_SLOT_DRIFT = 24;

export interface GovernanceAccountSet {
  program: AccountInfo<Buffer> | null;
  programData: AccountInfo<Buffer> | null;
  config: AccountInfo<Buffer> | null;
  vault: AccountInfo<Buffer> | null;
  capitalMint: AccountInfo<Buffer> | null;
  /** Required for an exact-amount re-vote; immutable bytes must agree across finalized views. */
  previousProposal?: AccountInfo<Buffer> | null;
}

/** Two independent finalized RPC views, each anchored to an independently checked block. */
export interface FinalizedGovernanceAccounts {
  slot: number;
  blockhash: string;
  accounts: GovernanceAccountSet;
}

export interface GovernanceProposalInstructionInput {
  route: GovernanceReserveRoute;
  finalizedAccounts: readonly [FinalizedGovernanceAccounts, FinalizedGovernanceAccounts];
  /** Finalized block identity independently checked by both RPCs for the snapshot. */
  snapshotFinality: { slot: number; blockhash: string };
  snapshot: SolanaGovernanceSnapshot;
  /** Already published operator bundle; never accept a bare root without review artifacts. */
  publication: GovernanceSnapshotManifest;
  observedClockUnix: number;
  votingDurationSeconds: number;
  /** Exact amount the admin intends to commit, not a percentage or an estimate. */
  frozenReserveRawMstrx: bigint;
  options: readonly GovernanceOption[];
}

export interface GovernanceRevoteInstructionInput extends GovernanceProposalInstructionInput {
  /** Exact PDA whose account bytes were fetched in finalizedAccounts. */
  previousProposalAddress: string;
}

export interface GovernanceProposalDraft {
  programId: string;
  proposal: string;
  config: string;
  reserveVault: string;
  id: bigint;
  frozenReserveRawMstrx: bigint;
  /** Estimated from the observed clock; the submitted transaction uses its own onchain clock. */
  estimatedStartsAt: number;
  estimatedEndsAt: number;
  estimatedExecutableAt: number;
  data: Buffer;
  keys: AccountMeta[];
  unreleasedExecutors: ReserveAction[];
  previousProposal?: string;
}

function exactKey(value: string) {
  const parsed = new PublicKey(value);
  if (parsed.toBase58() !== value) throw new Error("GOVERNANCE_PROPOSAL_ADDRESS_INVALID");
  return parsed;
}

function exactHex(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value) || /^0{64}$/.test(value)) throw new Error("GOVERNANCE_PROPOSAL_HASH_INVALID");
  return Buffer.from(value, "hex");
}

function u64(value: bigint) {
  if (value < 0n || value > U64_MAX) throw new Error("GOVERNANCE_PROPOSAL_U64_INVALID");
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function i64(value: number) {
  if (!Number.isSafeInteger(value)) throw new Error("GOVERNANCE_PROPOSAL_I64_INVALID");
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(BigInt(value));
  return bytes;
}

function u128(value: bigint) {
  if (value < 0n || value > U128_MAX) throw new Error("GOVERNANCE_PROPOSAL_U128_INVALID");
  const bytes = Buffer.alloc(16);
  bytes.writeBigUInt64LE(value & U64_MAX);
  bytes.writeBigUInt64LE(value >> 64n, 8);
  return bytes;
}

function accountFingerprint(account: AccountInfo<Buffer> | null) {
  return account && JSON.stringify({
      owner: account.owner.toBase58(), executable: account.executable,
      data: createHash("sha256").update(account.data).digest("hex"),
    });
}

function accountStateFingerprint(accounts: GovernanceAccountSet) {
  const vault = accounts.vault;
  let normalizedVault = vault;
  if (vault && vault.data.length >= 72) {
    const data = Buffer.from(vault.data);
    // Token-2022 account amount is the only byte range changed by ordinary
    // fee deposits. Compare every other byte, including owner and extensions.
    data.fill(0, 64, 72);
    normalizedVault = { ...vault, data };
  }
  return [accounts.program, accounts.programData, accounts.config, normalizedVault,
    accounts.capitalMint, accounts.previousProposal ?? null].map(accountFingerprint);
}

function checkedFinalizedState(input: GovernanceProposalInstructionInput, mode: "fresh" | "revote" = "fresh") {
  const [first, second] = input.finalizedAccounts;
  const firstBlockhash = exactKey(first.blockhash).toBase58();
  const secondBlockhash = exactKey(second.blockhash).toBase58();
  if (!Number.isSafeInteger(first.slot) || first.slot <= 0
    || !Number.isSafeInteger(second.slot) || second.slot <= 0
    || first.slot < input.snapshotFinality.slot || second.slot < input.snapshotFinality.slot
    || Math.abs(first.slot - second.slot) > MAX_ACCOUNT_VIEW_SLOT_DRIFT
    || (first.slot === second.slot && firstBlockhash !== secondBlockhash)
    || (first.slot === second.slot
      && accountFingerprint(first.accounts.vault) !== accountFingerprint(second.accounts.vault))
    || JSON.stringify(accountStateFingerprint(first.accounts)) !== JSON.stringify(accountStateFingerprint(second.accounts))) {
    throw new Error("GOVERNANCE_PROPOSAL_RPC_DISAGREEMENT");
  }
  const primary = assertGovernanceReserveAccounts(input.route, first.accounts);
  const secondary = assertGovernanceReserveAccounts(input.route, second.accounts);
  if (primary.programCodeSha256 !== secondary.programCodeSha256
    || primary.committedRaw !== secondary.committedRaw
    || primary.activeProposalId !== secondary.activeProposalId) {
    throw new Error("GOVERNANCE_PROPOSAL_RPC_DISAGREEMENT");
  }
  if (primary.lastDeployedSlot > BigInt(Math.min(first.slot, second.slot))) {
    throw new Error("GOVERNANCE_PROPOSAL_PROGRAM_SLOT_INVALID");
  }
  // A later finalized fee deposit must not invalidate an otherwise identical
  // view. Never draft more than the smaller independently observed balance.
  // The onchain exact-balance check still rejects a stale draft at broadcast.
  const vaultBalanceRaw = primary.vaultBalanceRaw < secondary.vaultBalanceRaw
    ? primary.vaultBalanceRaw : secondary.vaultBalanceRaw;
  const conservativeRoute = {
    ...primary, vaultBalanceRaw, freeRaw: vaultBalanceRaw - primary.committedRaw,
  };
  if (!first.accounts.config) throw new Error("GOVERNANCE_PROPOSAL_CONFIG_MISSING");
  const config = first.accounts.config.data;
  // Anchor Config v3: discriminator(8), schema(1), six Pubkeys, launchedAt(8),
  // launchSlot(8), launchSignature(64), lastProposalId(8), activeId(8), committed(8), bump(1).
  const marketingWallet = new PublicKey(config.subarray(169, 201)).toBase58();
  if (marketingWallet === ZERO_PUBKEY.toBase58()) throw new Error("GOVERNANCE_PROPOSAL_MARKETING_WALLET_INVALID");
  const lastProposalId = config.readBigUInt64LE(281);
  if (mode === "fresh") {
    if (conservativeRoute.activeProposalId !== 0n || conservativeRoute.committedRaw !== 0n) {
      throw new Error("GOVERNANCE_PROPOSAL_COMMITMENT_ACTIVE");
    }
    if (conservativeRoute.freeRaw === 0n || input.frozenReserveRawMstrx !== conservativeRoute.freeRaw) {
      throw new Error("GOVERNANCE_PROPOSAL_EXACT_FREE_AMOUNT_REQUIRED");
    }
  } else {
    if (conservativeRoute.activeProposalId !== lastProposalId || conservativeRoute.committedRaw === 0n
      || input.frozenReserveRawMstrx !== conservativeRoute.committedRaw) {
      throw new Error("GOVERNANCE_REVOTE_COMMITMENT_MISMATCH");
    }
  }
  return { route: conservativeRoute, marketingWallet, lastProposalId };
}

function checkedSnapshot(input: GovernanceProposalInstructionInput, nextId: bigint, launchedAt: number) {
  const snapshot = input.snapshot;
  if (!assertSolanaGovernanceSnapshot(snapshot)) throw new Error("GOVERNANCE_PROPOSAL_SNAPSHOT_INVALID");
  if (snapshot.network !== "solana-mainnet-beta"
    || snapshot.governanceProgram !== input.route.governanceProgram
    || snapshot.capitalMint !== input.route.capitalMint
    || snapshot.proposalId !== nextId.toString()
    || snapshot.windowStart !== governanceWindowStart(snapshot.windowEnd, launchedAt)
    || !Number.isSafeInteger(input.observedClockUnix)
    || snapshot.windowEnd > input.observedClockUnix
    || input.observedClockUnix - snapshot.windowEnd > MAX_PROPOSAL_SNAPSHOT_AGE_SECONDS
    || !Number.isSafeInteger(snapshot.finalizedThroughSlot)
    || snapshot.finalizedThroughSlot <= 0
    || snapshot.finalizedThroughSlot !== input.snapshotFinality.slot
    || snapshot.finalizedBlockhash !== input.snapshotFinality.blockhash
    || input.finalizedAccounts.some((view) => snapshot.finalizedThroughSlot === view.slot
      && snapshot.finalizedBlockhash !== view.blockhash)
    || !Number.isSafeInteger(snapshot.leafCount) || snapshot.leafCount <= 0) {
    throw new Error("GOVERNANCE_PROPOSAL_SNAPSHOT_IDENTITY_MISMATCH");
  }
  exactKey(snapshot.finalizedBlockhash);
  exactHex(snapshot.exclusionsHash);
  exactHex(snapshot.merkleRoot);
  const manifest = input.publication;
  const base = `governance/proposals/${nextId}`;
  const snapshotSha256 = createHash("sha256").update(JSON.stringify(snapshot, null, 2) + "\n").digest("hex");
  if (!manifest || manifest.version !== 2 || manifest.network !== "solana-mainnet-beta"
    || manifest.proposalId !== nextId.toString() || manifest.merkleRoot !== snapshot.merkleRoot
    || manifest.totalAvailableWeight !== snapshot.totalAvailableWeight
    || manifest.snapshotSha256 !== snapshotSha256
    || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)
    || manifest.source !== `${base}/source.json` || manifest.snapshot !== `${base}/snapshot.json`
    || !Number.isSafeInteger(manifest.publishedAtUnix)
    || manifest.publishedAtUnix < snapshot.windowEnd
    || manifest.publishedAtUnix > input.observedClockUnix) {
    throw new Error("GOVERNANCE_PROPOSAL_PUBLICATION_INVALID");
  }
  return snapshot;
}

function encodeArgs(
  input: GovernanceProposalInstructionInput, id: bigint, snapshot: SolanaGovernanceSnapshot,
  discriminator = CREATE_PROPOSAL_DISCRIMINATOR,
) {
  const count = Buffer.alloc(4);
  count.writeUInt32LE(input.options.length);
  const options = input.options.map((option) => {
    const encoded = Buffer.alloc(45);
    encoded.writeUInt8(RESERVE_ACTIONS.indexOf(option.action), 0);
    encoded.writeUInt32LE(option.lockDurationSeconds ?? 0, 1);
    (option.recipient ? exactKey(option.recipient) : ZERO_PUBKEY).toBuffer().copy(encoded, 5);
    u64(option.minOutputRaw ?? 0n).copy(encoded, 37);
    return encoded;
  });
  return Buffer.concat([
    discriminator,
    u64(id), i64(input.votingDurationSeconds), i64(snapshot.windowStart), i64(snapshot.windowEnd),
    u64(BigInt(snapshot.finalizedThroughSlot)), exactKey(snapshot.finalizedBlockhash).toBuffer(),
    exactHex(snapshot.exclusionsHash), exactHex(snapshot.merkleRoot), u64(BigInt(snapshot.leafCount)),
    u128(BigInt(snapshot.totalAvailableWeight)), u64(input.frozenReserveRawMstrx), count, ...options,
  ]);
}

function checkedPreviousProposal(input: GovernanceRevoteInstructionInput, priorId: bigint) {
  const previous = input.finalizedAccounts[0].accounts.previousProposal;
  if (!previous || !previous.owner.equals(exactKey(input.route.governanceProgram))
    || previous.data.length !== PROPOSAL_ACCOUNT_LENGTH
    || !previous.data.subarray(0, 8).equals(PROPOSAL_DISCRIMINATOR)) {
    throw new Error("GOVERNANCE_REVOTE_PREVIOUS_INVALID");
  }
  const data = previous.data;
  const derived = deriveGovernanceReserveRoute(input.route.governanceProgram, input.route.reserveMint);
  if (data.readUInt8(8) !== 3
    || !new PublicKey(data.subarray(9, 41)).equals(derived.authority)
    || !new PublicKey(data.subarray(41, 73)).equals(exactKey(input.route.capitalMint))
    || !new PublicKey(data.subarray(73, 105)).equals(derived.ata)
    || data.readBigUInt64LE(105) !== priorId
    || data.readBigUInt64LE(281) !== input.frozenReserveRawMstrx) {
    throw new Error("GOVERNANCE_REVOTE_PREVIOUS_INVALID");
  }
  const count = data.readUInt32LE(289);
  if (count < 2 || count > 6) throw new Error("GOVERNANCE_REVOTE_PREVIOUS_INVALID");
  const status = data.readUInt8(405 + 53 * count);
  const winning = data.readUInt8(406 + 53 * count);
  if (![1, 7, 8].includes(status)) throw new Error("GOVERNANCE_REVOTE_PREVIOUS_NOT_PENDING");
  if (status === 1) {
    if (winning >= count) throw new Error("GOVERNANCE_REVOTE_PREVIOUS_INVALID");
    const optionStart = 293 + 53 * winning;
    if (data.readUInt8(optionStart) === 0
      || data.readBigUInt64LE(optionStart + 37) !== input.frozenReserveRawMstrx) {
      throw new Error("GOVERNANCE_REVOTE_PREVIOUS_INVALID");
    }
  } else if (winning !== 255) throw new Error("GOVERNANCE_REVOTE_PREVIOUS_INVALID");
  const executableAt = data.readBigInt64LE(129);
  if (BigInt(input.observedClockUnix) < executableAt) {
    throw new Error("GOVERNANCE_REVOTE_TOO_EARLY");
  }
  const [previousPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), u64(priorId)], derived.program,
  );
  if (!previousPda.equals(exactKey(input.previousProposalAddress))) {
    throw new Error("GOVERNANCE_REVOTE_PREVIOUS_ADDRESS_MISMATCH");
  }
  return previousPda;
}

/**
 * Audit-only serialization. The caller must supply two close finalized
 * account reads plus independently agreed snapshot-block identity. This does
 * not prove historical transfer completeness; snapshot publication does that.
 * No TransactionInstruction, signature, or broadcast is returned here.
 */
export function auditCreateProposalDraft(input: GovernanceProposalInstructionInput): GovernanceProposalDraft {
  const state = checkedFinalizedState(input);
  const nextId = state.lastProposalId + 1n;
  u64(nextId);
  const launchedAt = Number(state.route.launchedAt);
  if (!Number.isSafeInteger(launchedAt) || launchedAt <= 0) throw new Error("GOVERNANCE_PROPOSAL_LAUNCH_TIME_INVALID");
  const snapshot = checkedSnapshot(input, nextId, launchedAt);
  const schedule = freezeGovernanceProposal({
    id: nextId, now: input.observedClockUnix + INITIAL_PUBLIC_REVIEW_SECONDS,
    votingDurationSeconds: input.votingDurationSeconds,
    snapshotRoot: snapshot.merkleRoot, totalAvailableWeight: BigInt(snapshot.totalAvailableWeight),
    availableReserveRawMstrx: state.route.freeRaw, options: input.options,
    marketingWallet: state.marketingWallet,
  });
  const derived = deriveGovernanceReserveRoute(input.route.governanceProgram, input.route.reserveMint);
  const [proposal] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), u64(nextId)], derived.program);
  return {
    programId: derived.program.toBase58(), proposal: proposal.toBase58(),
    config: derived.authority.toBase58(), reserveVault: derived.ata.toBase58(),
    id: nextId, frozenReserveRawMstrx: state.route.freeRaw,
    estimatedStartsAt: schedule.startsAt, estimatedEndsAt: schedule.endsAt,
    estimatedExecutableAt: schedule.executableAt,
    data: encodeArgs(input, nextId, snapshot),
    keys: [
      { pubkey: derived.authority, isSigner: false, isWritable: true },
      { pubkey: derived.ata, isSigner: false, isWritable: false },
      { pubkey: proposal, isSigner: false, isWritable: true },
      { pubkey: exactKey(input.route.admin), isSigner: true, isWritable: true },
      { pubkey: derived.program, isSigner: false, isWritable: false },
      { pubkey: derived.programDataAddress, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    unreleasedExecutors: input.options.filter((option) => !RELEASED_EXECUTORS.has(option.action)).map((option) => option.action),
  };
}

/** Audit-only re-vote serialization; commitment never becomes free here. */
export function auditCreateRevoteDraft(input: GovernanceRevoteInstructionInput): GovernanceProposalDraft {
  const state = checkedFinalizedState(input, "revote");
  const priorId = state.lastProposalId;
  const previousProposal = checkedPreviousProposal(input, priorId);
  const nextId = priorId + 1n;
  u64(nextId);
  const launchedAt = Number(state.route.launchedAt);
  if (!Number.isSafeInteger(launchedAt) || launchedAt <= 0) throw new Error("GOVERNANCE_PROPOSAL_LAUNCH_TIME_INVALID");
  const snapshot = checkedSnapshot(input, nextId, launchedAt);
  const schedule = freezeGovernanceProposal({
    id: nextId, now: input.observedClockUnix, votingDurationSeconds: input.votingDurationSeconds,
    snapshotRoot: snapshot.merkleRoot, totalAvailableWeight: BigInt(snapshot.totalAvailableWeight),
    availableReserveRawMstrx: state.route.committedRaw, options: input.options,
    marketingWallet: state.marketingWallet,
  });
  const derived = deriveGovernanceReserveRoute(input.route.governanceProgram, input.route.reserveMint);
  const [proposal] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), u64(nextId)], derived.program);
  return {
    programId: derived.program.toBase58(), proposal: proposal.toBase58(),
    config: derived.authority.toBase58(), reserveVault: derived.ata.toBase58(),
    previousProposal: previousProposal.toBase58(),
    id: nextId, frozenReserveRawMstrx: state.route.committedRaw,
    estimatedStartsAt: schedule.startsAt, estimatedEndsAt: schedule.endsAt,
    estimatedExecutableAt: schedule.executableAt,
    data: encodeArgs(input, nextId, snapshot, CREATE_REVOTE_DISCRIMINATOR),
    keys: [
      { pubkey: derived.authority, isSigner: false, isWritable: true },
      { pubkey: derived.ata, isSigner: false, isWritable: false },
      { pubkey: previousProposal, isSigner: false, isWritable: true },
      { pubkey: proposal, isSigner: false, isWritable: true },
      { pubkey: exactKey(input.route.admin), isSigner: true, isWritable: true },
      { pubkey: derived.program, isSigner: false, isWritable: false },
      { pubkey: derived.programDataAddress, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    unreleasedExecutors: input.options.filter((option) => !RELEASED_EXECUTORS.has(option.action)).map((option) => option.action),
  };
}

/** This must stay unavailable until the onchain gate and every offered executor are released. */
export function buildCreateProposalInstruction(input: GovernanceProposalInstructionInput): TransactionInstruction {
  const draft = auditCreateProposalDraft(input);
  if (!GOVERNANCE_PROPOSALS_RELEASED) throw new Error("GOVERNANCE_PROPOSALS_NOT_RELEASED");
  if (draft.unreleasedExecutors.length > 0) throw new Error("GOVERNANCE_PROPOSAL_EXECUTOR_UNRELEASED");
  return new TransactionInstruction({ programId: exactKey(draft.programId), keys: draft.keys, data: draft.data });
}

/** This must stay unavailable until reviewed executors and the onchain gate are released. */
export function buildCreateRevoteInstruction(input: GovernanceRevoteInstructionInput): TransactionInstruction {
  const draft = auditCreateRevoteDraft(input);
  if (!GOVERNANCE_PROPOSALS_RELEASED) throw new Error("GOVERNANCE_PROPOSALS_NOT_RELEASED");
  if (draft.unreleasedExecutors.length > 0) throw new Error("GOVERNANCE_PROPOSAL_EXECUTOR_UNRELEASED");
  return new TransactionInstruction({ programId: exactKey(draft.programId), keys: draft.keys, data: draft.data });
}
