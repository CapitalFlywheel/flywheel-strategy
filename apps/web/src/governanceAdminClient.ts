import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { MARKETING_POOL, MARKETING_PROGRAM, governanceAddresses,
  governanceExecutionReceiptAddresses } from "./governanceClient";

export const RESERVE_OUTCOMES = [
  "ACCUMULATE", "BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK", "LOCK_MSTRX", "MARKETING_SALE",
] as const;
export type ReserveOutcome = typeof RESERVE_OUTCOMES[number];

export type OwnerProposalPreviewMode = "initial" | "revote";
export interface OwnerProposalPreviewRequest {
  mode: OwnerProposalPreviewMode;
  votingDurationSeconds: number;
  options: Array<{ action: ReserveOutcome; minOutputRaw?: string; lockDurationSeconds?: number }>;
}
export interface OwnerProposalPreview {
  ok: true;
  sendable: false;
  previewHash: string;
  auditedAtUnix: number;
  fixedMarketingRecipient: string;
  draft: {
    id: string;
    proposal: string;
    config: string;
    reserveVault: string;
    frozenReserveRawMstrx: string;
    estimatedStartsAt: number;
    estimatedEndsAt: number;
    estimatedExecutableAt: number;
    previousProposal?: string;
    unreleasedExecutors: ReserveOutcome[];
  };
  publication: {
    version: 2;
    network: "solana-mainnet-beta";
    proposalId: string;
    merkleRoot: string;
    totalAvailableWeight: string;
    sourceSha256: string;
    snapshotSha256: string;
    publishedAtUnix: number;
    source: string;
    snapshot: string;
  };
  options: OwnerProposalOption[];
}

const SWAP_OUTCOMES = new Set<ReserveOutcome>(["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK", "MARKETING_SALE"]);
const LOCK_OUTCOMES = new Set<ReserveOutcome>(["BUYBACK_LOCK", "LOCK_MSTRX"]);
const PROPOSAL_LOCK_TERMS = new Set([30, 90, 180, 365, 730, 1095, 1825].map((days) => days * 86_400).concat(0xffffffff));
const MAX_TIMESTAMP_SECONDS = 8_640_000_000;

/** Read-only proposal preview input. No owner signature, transaction bytes or
 * mutable recipient is accepted from this form. */
export function normalizeOwnerProposalPreviewRequest(input: {
  mode: OwnerProposalPreviewMode;
  durationHours: number;
  selected: readonly ReserveOutcome[];
  minimums: Partial<Record<ReserveOutcome, string>>;
  lockTerms: Partial<Record<ReserveOutcome, number>>;
}): OwnerProposalPreviewRequest {
  if (!["initial", "revote"].includes(input.mode) || !Number.isInteger(input.durationHours)
    || input.durationHours < 1 || input.durationHours > 12) throw new Error("PROPOSAL_DURATION_INVALID");
  const selected = RESERVE_OUTCOMES.filter((action) => input.selected.includes(action));
  if (selected.length !== input.selected.length || selected.length < 2 || selected.length > 6
    || new Set(selected).size !== selected.length || !selected.includes("ACCUMULATE")) {
    throw new Error("PROPOSAL_OPTIONS_INVALID");
  }
  return {
    mode: input.mode, votingDurationSeconds: input.durationHours * 3_600,
    options: selected.map((action) => {
      const minimum = input.minimums[action];
      const duration = input.lockTerms[action];
      if (SWAP_OUTCOMES.has(action) ? rawU64(minimum) === undefined || rawU64(minimum) === 0n
        : minimum !== undefined && minimum !== "" && minimum !== "0") throw new Error("PROPOSAL_MINIMUM_INVALID");
      if (LOCK_OUTCOMES.has(action) ? !PROPOSAL_LOCK_TERMS.has(duration ?? 0)
        : duration !== undefined && duration !== 0) throw new Error("PROPOSAL_LOCK_TERM_INVALID");
      return {
        action,
        ...(SWAP_OUTCOMES.has(action) ? { minOutputRaw: minimum } : {}),
        ...(LOCK_OUTCOMES.has(action) ? { lockDurationSeconds: duration } : {}),
      };
    }),
  };
}

/** Validate the audit-only server response before showing exact values in
 * owner-facing preview. This does not enable any create/revote send action. */
export function verifiedOwnerProposalPreview(
  value: unknown, request: OwnerProposalPreviewRequest,
): OwnerProposalPreview | undefined {
  if (!value || typeof value !== "object") return;
  const preview = value as OwnerProposalPreview;
  const draft = preview.draft;
  const publication = preview.publication;
  const frozen = rawU64(draft?.frozenReserveRawMstrx);
  if (preview.ok !== true || preview.sendable !== false || !/^[a-f0-9]{64}$/.test(preview.previewHash)
    || !validTimestamp(preview.auditedAtUnix) || !exactPubkey(preview.fixedMarketingRecipient)
    || !draft || !publication || !Array.isArray(preview.options)
    || rawU64(draft.id) === undefined || draft.id === "0" || frozen === undefined || frozen === 0n
    || !exactPubkey(draft.proposal) || !exactPubkey(draft.config) || !exactPubkey(draft.reserveVault)
    || !validTimestamp(draft.estimatedStartsAt) || !validTimestamp(draft.estimatedEndsAt)
    || !validTimestamp(draft.estimatedExecutableAt)
    || draft.estimatedEndsAt !== draft.estimatedStartsAt + request.votingDurationSeconds
    || draft.estimatedExecutableAt !== draft.estimatedEndsAt + 300
    || (request.mode === "revote" ? !exactPubkey(draft.previousProposal) : draft.previousProposal !== undefined)
    || !Array.isArray(draft.unreleasedExecutors)
    || new Set(draft.unreleasedExecutors).size !== draft.unreleasedExecutors.length
    || draft.unreleasedExecutors.some((action) => !RESERVE_OUTCOMES.includes(action) || !request.options.some((option) => option.action === action))
    || publication.version !== 2 || publication.network !== "solana-mainnet-beta"
    || publication.proposalId !== draft.id || !/^[a-f0-9]{64}$/.test(publication.merkleRoot)
    || !/^[a-f0-9]{64}$/.test(publication.sourceSha256)
    || !/^[a-f0-9]{64}$/.test(publication.snapshotSha256)
    || rawU128(publication.totalAvailableWeight) === undefined
    || !validTimestamp(publication.publishedAtUnix)
    || publication.publishedAtUnix > preview.auditedAtUnix
    || publication.source !== `governance/proposals/${draft.id}/source.json`
    || publication.snapshot !== `governance/proposals/${draft.id}/snapshot.json`
    || preview.options.length !== request.options.length) return;
  for (let index = 0; index < preview.options.length; index++) {
    const actual = preview.options[index];
    const expected = request.options[index];
    const expectedMinimum = rawU64(expected?.minOutputRaw ?? "0");
    if (!actual || !expected || expectedMinimum === undefined || actual.action !== expected.action
      || rawU64(actual.reserveRaw) !== (actual.action === "ACCUMULATE" ? 0n : frozen)
      || rawU64(actual.minOutputRaw) !== expectedMinimum
      || actual.lockDurationSeconds !== (expected.lockDurationSeconds ?? 0)
      || !exactPubkey(actual.recipient)
      || (actual.action === "MARKETING_SALE" && actual.recipient !== preview.fixedMarketingRecipient)
      || (actual.action !== "MARKETING_SALE" && actual.recipient !== SystemProgram.programId.toBase58())) return;
  }
  return preview;
}

export interface OwnerProposalOption {
  action: ReserveOutcome;
  /** Exact raw amount stored in this option; zero only for ACCUMULATE. */
  reserveRaw: string;
  /** Raw CAPITAL for buybacks, lamports for MARKETING_SALE. */
  minOutputRaw: string;
  recipient: string;
  lockDurationSeconds: number;
}

export interface OwnerProposalStatus {
  id: string;
  status: number;
  /** SHA-256 of the exact two-RPC-verified finalized Proposal account bytes. */
  proposalStateSha256?: string;
  frozenRaw: string;
  startsAt: number;
  endsAt: number;
  executableAt: number;
  winningAction?: string;
  executionSignature?: string;
  executionReceipt?: {
    address: string;
    kind: "BUYBACK" | "MARKETING_SALE";
    action: string;
    inputRawMstrx: string;
    votedMinOutputRaw: string;
    actualOutputRaw: string;
    executedAt: number;
    destination: string;
    venue: string;
  };
  executionLock?: {
    address: string;
    escrowAddress: string;
    amountRawMstrx: string;
    lockedAt: number;
    releaseAt: number;
    state: "ACTIVE" | "MATURED_AWAITING_RELEASE" | "RELEASED";
  };
  fixedMarketingWallet?: string;
  options?: OwnerProposalOption[];
  updatedAt: number;
}

export interface OwnerGovernanceStatus {
  owner?: string;
  finalizeVoteReleased?: boolean;
  proposalControlReleased?: boolean;
  launch?: { activated?: boolean; executionReleased?: boolean; governanceBindState?: string; detectedMint?: string };
  governance?: {
    program?: string;
    programCodeSha256?: string;
    reserveMint?: string;
    capitalTokenProgram?: string;
    vaultTokenAccount?: string;
    boundCapitalMint?: string | null;
    vaultBalanceRaw: string;
    committedRaw: string;
    freeRaw: string;
    lastProposalId: string;
    activeProposalId: string;
    updatedAt: number;
  };
  governanceProposal?: OwnerProposalStatus;
  governanceLockExecution?: { state?: string };
  governanceBuybackExecution?: { state?: string };
  governanceMarketingExecution?: { state?: string };
  governanceLockRelease?: { state?: string };
}

const unresolved = (state?: string) => ["prepared", "pending", "unresolved"].includes(state ?? "");

export function canExecuteOwnerBuyback(status: OwnerGovernanceStatus | undefined, now: number): boolean {
  const proposal = verifiedOwnerProposal(status, now);
  const option = proposal?.options.find((item) => item.action === proposal.winningAction);
  return Boolean(status?.launch?.executionReleased && status.launch.activated
    && status.launch.governanceBindState === "bound" && proposal?.status === 1
    && ["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK"].includes(proposal.winningAction ?? "")
    && now >= proposal.executableAt * 1_000 && option && option.reserveRaw === proposal.frozenRaw
    && rawU64(option.minOutputRaw) !== undefined && rawU64(option.minOutputRaw)! > 0n
    && /^[a-f0-9]{64}$/.test(proposal.proposalStateSha256 ?? "")
    && exactPubkey(status.governance?.program) && exactPubkey(status.governance?.reserveMint)
    && exactPubkey(status.governance?.vaultTokenAccount) && exactPubkey(status.governance?.boundCapitalMint)
    && status.governance?.boundCapitalMint === status.launch.detectedMint
    && [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(status.governance?.capitalTokenProgram ?? "")
    && /^[a-f0-9]{64}$/.test(status.governance?.programCodeSha256 ?? "")
    && !unresolved(status.governanceBuybackExecution?.state));
}

export function canExecuteOwnerMarketingSale(status: OwnerGovernanceStatus | undefined, now: number): boolean {
  const proposal = verifiedOwnerProposal(status, now);
  const option = proposal?.options.find((item) => item.action === "MARKETING_SALE");
  return Boolean(status?.launch?.executionReleased && status.launch.activated
    && status.launch.governanceBindState === "bound" && proposal?.status === 1
    && proposal.winningAction === "MARKETING_SALE" && now >= proposal.executableAt * 1_000
    && option && option.reserveRaw === proposal.frozenRaw && option.recipient === proposal.fixedMarketingWallet
    && rawU64(option.minOutputRaw) !== undefined && rawU64(option.minOutputRaw)! > 0n
    && /^[a-f0-9]{64}$/.test(proposal.proposalStateSha256 ?? "")
    && exactPubkey(status.governance?.program) && exactPubkey(status.governance?.reserveMint)
    && exactPubkey(status.governance?.vaultTokenAccount) && exactPubkey(status.governance?.boundCapitalMint)
    && status.governance?.boundCapitalMint === status.launch.detectedMint
    && [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(status.governance?.capitalTokenProgram ?? "")
    && /^[a-f0-9]{64}$/.test(status.governance?.programCodeSha256 ?? "")
    && !unresolved(status.governanceMarketingExecution?.state));
}

function commonSwapChallenge(message: string, status: OwnerGovernanceStatus, proposal: VerifiedOwnerProposal,
  receiptKind: "buyback" | "marketing", action: string, now: number) {
  const reserve = status.governance!;
  const program = new PublicKey(reserve.program!);
  const addresses = governanceAddresses(program, BigInt(proposal.id));
  const receipt = governanceExecutionReceiptAddresses(program, addresses.proposal)[receiptKind];
  const trader = PublicKey.findProgramAddressSync([new TextEncoder().encode("proposal-trader")], program)[0];
  const option = proposal.options.find((item) => item.action === proposal.winningAction)!;
  const bitmap = PublicKey.findProgramAddressSync([new TextEncoder().encode("pool_tick_array_bitmap_extension"),
    new PublicKey(MARKETING_POOL).toBytes()], new PublicKey(MARKETING_PROGRAM))[0];
  const lines = new Set(message.split("\n"));
  const verifiedLine = message.split("\n").find((line) => line.startsWith("Verified at: "));
  const verifiedAt = verifiedLine ? Date.parse(verifiedLine.slice("Verified at: ".length)) : NaN;
  return Number.isFinite(verifiedAt) && verifiedAt <= now + 30_000 && now - verifiedAt <= 90_000
    && [
      `Action: ${action}`, "Network: Solana Mainnet Beta",
      `Governance program: ${reserve.program}`,
      `Reviewed program SHA-256: ${reserve.programCodeSha256}`,
      `Reserve mint: ${reserve.reserveMint}`,
      `Reserve vault: ${reserve.vaultTokenAccount}`,
      `Bound CAPITAL mint: ${reserve.boundCapitalMint}`,
      `CAPITAL token program: ${reserve.capitalTokenProgram}`,
      `Config PDA: ${addresses.config.toBase58()}`,
      `Proposal ID: ${proposal.id}`,
      `Proposal PDA: ${addresses.proposal.toBase58()}`,
      `Finalized proposal SHA-256: ${proposal.proposalStateSha256}`,
      `Frozen raw MSTRx: ${proposal.frozenRaw}`,
      `Executable at: ${new Date(proposal.executableAt * 1_000).toISOString()}`,
      ...(receiptKind === "buyback"
        ? [`Winning action: ${proposal.winningAction}`, `Voted minimum raw CAPITAL: ${option.minOutputRaw}`,
          `Lock duration seconds: ${option.lockDurationSeconds}`, `Buyback receipt PDA: ${receipt.toBase58()}`]
        : [`Voted minimum SOL lamports: ${option.minOutputRaw}`,
          `Execution minimum SOL lamports: ${option.minOutputRaw}`,
          `Fixed marketing recipient: ${option.recipient}`, `Marketing receipt PDA: ${receipt.toBase58()}`,
          `Raydium pool: ${MARKETING_POOL}`, `Raydium bitmap: ${bitmap.toBase58()}`]),
      `Trader PDA: ${trader.toBase58()}`,
    ].every((line) => lines.has(line));
}

export function matchesBuybackOwnerChallenge(message: string, status: OwnerGovernanceStatus | undefined,
  now: number): boolean {
  if (!canExecuteOwnerBuyback(status, now)) return false;
  const proposal = verifiedOwnerProposal(status, now)!;
  const lines = new Set(message.split("\n"));
  const venue = message.split("\n").find((line) => line.startsWith("Venue address: "))?.slice("Venue address: ".length);
  const phase = message.split("\n").find((line) => line.startsWith("Venue phase: "))?.slice("Venue phase: ".length);
  const hash = message.split("\n").find((line) => line.startsWith("Venue state SHA-256: "))?.slice("Venue state SHA-256: ".length);
  return commonSwapChallenge(message, status!, proposal, "buyback", "execute_buyback", now)
    && (phase === "curve" || phase === "pumpswap") && exactPubkey(venue)
    && /^[a-f0-9]{64}$/.test(hash ?? "") && lines.has(`Venue address: ${venue}`);
}

export function matchesMarketingSaleOwnerChallenge(message: string, status: OwnerGovernanceStatus | undefined,
  now: number): boolean {
  if (!canExecuteOwnerMarketingSale(status, now)) return false;
  const proposal = verifiedOwnerProposal(status, now)!;
  const ticks = message.split("\n").filter((line) => /^Tick array \d+: /.test(line));
  return commonSwapChallenge(message, status!, proposal, "marketing", "execute_marketing_sale", now)
    && ticks.length >= 1 && ticks.length <= 4
    && ticks.every((line, index) => line.startsWith(`Tick array ${index + 1}: `)
      && exactPubkey(line.slice(`Tick array ${index + 1}: `.length)))
    && new Set(ticks.map((line) => line.split(": ")[1])).size === ticks.length;
}

export function canRequestOwnerLockRelease(status: OwnerGovernanceStatus | undefined,
  proposalId: string, now: number): boolean {
  const id = rawU64(proposalId);
  const last = rawU64(status?.governance?.lastProposalId);
  return Boolean(status?.launch?.executionReleased && status.launch.activated
    && status.launch.governanceBindState === "bound" && hasRecentVerifiedReserve(status, now)
    && id !== undefined && id > 0n && last !== undefined && id <= last
    && exactPubkey(status.governance?.program) && exactPubkey(status.governance?.reserveMint)
    && exactPubkey(status.governance?.vaultTokenAccount) && exactPubkey(status.governance?.boundCapitalMint)
    && status.governance?.boundCapitalMint === status.launch.detectedMint
    && /^[a-f0-9]{64}$/.test(status.governance?.programCodeSha256 ?? "")
    && !unresolved(status.governanceLockRelease?.state));
}

export function matchesOwnerLockReleaseChallenge(message: string, status: OwnerGovernanceStatus | undefined,
  proposalId: string, now: number): boolean {
  if (!canRequestOwnerLockRelease(status, proposalId, now)) return false;
  const reserve = status!.governance!;
  const program = new PublicKey(reserve.program!);
  const reserveMint = new PublicKey(reserve.reserveMint!);
  const addresses = governanceAddresses(program, BigInt(proposalId));
  const record = PublicKey.findProgramAddressSync([new TextEncoder().encode("reserve-lock"),
    addresses.proposal.toBytes()], program)[0];
  const escrow = getAssociatedTokenAddressSync(reserveMint, record, true, TOKEN_2022_PROGRAM_ID);
  const lines = new Set(message.split("\n"));
  const get = (prefix: string) => message.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length);
  const committed = rawU64(get("Record committed raw MSTRx: "));
  const observed = rawU64(get("Observed escrow raw MSTRx: "));
  const verifiedAt = Date.parse(get("Verified at: ") ?? "");
  const releaseAt = Date.parse(get("Release at: ") ?? "");
  return committed !== undefined && committed > 0n && observed !== undefined && observed >= committed
    && /^[a-f0-9]{64}$/.test(get("Finalized proposal SHA-256: ") ?? "")
    && /^[a-f0-9]{64}$/.test(get("Finalized lock record SHA-256: ") ?? "")
    && Number.isFinite(verifiedAt) && verifiedAt <= now + 30_000 && now - verifiedAt <= 90_000
    && Number.isFinite(releaseAt) && releaseAt <= now
    && ["Action: release_lock_mstrx", "Network: Solana Mainnet Beta",
      `Governance program: ${reserve.program}`,
      `Reviewed program SHA-256: ${reserve.programCodeSha256}`,
      `Reserve mint: ${reserve.reserveMint}`,
      `Canonical reserve vault: ${reserve.vaultTokenAccount}`,
      `Bound CAPITAL mint: ${reserve.boundCapitalMint}`,
      `Config PDA: ${addresses.config.toBase58()}`,
      `Proposal ID: ${proposalId}`,
      `Proposal PDA: ${addresses.proposal.toBase58()}`,
      `Lock record PDA: ${record.toBase58()}`,
      `Lock vault ATA: ${escrow.toBase58()}`,
      "Releases all current escrow to the canonical reserve vault",
    ].every((line) => lines.has(line));
}

/** Display-side guard only. The web API and runner repeat finalized two-RPC
 * reads before constructing the exact immutable onchain instruction. */
export function canExecuteOwnerMstrxLock(status: OwnerGovernanceStatus | undefined, now: number): boolean {
  const proposal = verifiedOwnerProposal(status, now);
  const governance = status?.governance;
  const winning = proposal?.options.find((option) => option.action === "LOCK_MSTRX");
  return Boolean(status?.launch?.executionReleased === true && status.launch.activated === true
    && status.launch.governanceBindState === "bound" && proposal?.status === 1
    && proposal.winningAction === "LOCK_MSTRX" && now >= proposal.executableAt * 1_000
    && winning && winning.reserveRaw === proposal.frozenRaw
    && /^[a-f0-9]{64}$/.test(proposal.proposalStateSha256 ?? "")
    && exactPubkey(governance?.program) && exactPubkey(governance?.reserveMint)
    && exactPubkey(governance?.vaultTokenAccount) && exactPubkey(governance?.boundCapitalMint)
    && governance?.boundCapitalMint === status.launch.detectedMint
    && [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(governance?.capitalTokenProgram ?? "")
    && /^[a-f0-9]{64}$/.test(governance?.programCodeSha256 ?? "")
    && !["prepared", "pending", "unresolved"].includes(status.governanceLockExecution?.state ?? ""));
}

/** Confirm every material term visible to the owner before signing. */
export function matchesMstrxLockOwnerChallenge(message: string, status: OwnerGovernanceStatus | undefined, now: number): boolean {
  if (!canExecuteOwnerMstrxLock(status, now)) return false;
  const proposal = verifiedOwnerProposal(status, now)!;
  const governance = status!.governance!;
  const program = new PublicKey(governance.program!);
  const reserveMint = new PublicKey(governance.reserveMint!);
  const config = PublicKey.findProgramAddressSync([new TextEncoder().encode("config")], program)[0];
  const proposalId = new Uint8Array(8);
  new DataView(proposalId.buffer).setBigUint64(0, BigInt(proposal.id), true);
  const proposalPda = PublicKey.findProgramAddressSync([new TextEncoder().encode("proposal"), proposalId], program)[0];
  const record = PublicKey.findProgramAddressSync([new TextEncoder().encode("reserve-lock"), proposalPda.toBytes()], program)[0];
  const escrow = getAssociatedTokenAddressSync(reserveMint, record, true, TOKEN_2022_PROGRAM_ID);
  const lines = new Set(message.split("\n"));
  const winning = proposal.options.find((option) => option.action === "LOCK_MSTRX")!;
  const verifiedLine = message.split("\n").find((line) => line.startsWith("Verified at: "));
  const verifiedAt = verifiedLine ? Date.parse(verifiedLine.slice("Verified at: ".length)) : NaN;
  return Number.isFinite(verifiedAt) && verifiedAt <= now + 30_000 && now - verifiedAt <= 90_000
    && [
      "Action: execute_lock_mstrx", "Network: Solana Mainnet Beta",
      `Governance program: ${governance.program}`,
      `Reviewed program SHA-256: ${governance.programCodeSha256}`,
      `Reserve mint: ${governance.reserveMint}`,
      `Reserve vault: ${governance.vaultTokenAccount}`,
      `Bound CAPITAL mint: ${governance.boundCapitalMint}`,
      `CAPITAL token program: ${governance.capitalTokenProgram}`,
      `Config PDA: ${config.toBase58()}`,
      `Proposal ID: ${proposal.id}`,
      `Proposal PDA: ${proposalPda.toBase58()}`,
      `Finalized proposal SHA-256: ${proposal.proposalStateSha256}`,
      `Frozen raw MSTRx: ${proposal.frozenRaw}`,
      `Lock duration seconds: ${winning.lockDurationSeconds}`,
      `Lock record PDA: ${record.toBase58()}`,
      `Lock vault ATA: ${escrow.toBase58()}`,
      `Executable at: ${new Date(proposal.executableAt * 1_000).toISOString()}`,
    ].every((line) => lines.has(line));
}

/** Display-side guard only. The server constructs the exact next ID and the
 * runner repeats the immutable program and two-RPC journal checks. */
export function canPublishOwnerSnapshot(status: OwnerGovernanceStatus | undefined, now: number): boolean {
  const reserve = status?.governance;
  const id = rawU64(reserve?.lastProposalId);
  return Boolean(status?.proposalControlReleased === true && hasRecentVerifiedReserve(status, now)
    && status.launch?.activated === true && status.launch.governanceBindState === "bound"
    && exactPubkey(reserve?.program) && exactPubkey(reserve?.reserveMint)
    && exactPubkey(reserve?.boundCapitalMint)
    && reserve?.boundCapitalMint === status.launch.detectedMint
    && /^[a-f0-9]{64}$/.test(reserve?.programCodeSha256 ?? "")
    && id !== undefined && id < (1n << 64n) - 1n);
}

export function matchesSnapshotOwnerChallenge(message: string, status: OwnerGovernanceStatus | undefined, now: number): boolean {
  if (!canPublishOwnerSnapshot(status, now)) return false;
  const reserve = status!.governance!;
  const lines = new Set(message.split("\n"));
  return [
    "Action: publish_snapshot",
    "Network: Solana Mainnet Beta",
    `Governance program: ${reserve.program}`,
    `Reviewed program SHA-256: ${reserve.programCodeSha256}`,
    `Bound CAPITAL mint: ${reserve.boundCapitalMint}`,
    `Reserve mint: ${reserve.reserveMint}`,
    `Next proposal ID: ${(BigInt(reserve.lastProposalId) + 1n).toString()}`,
    "Purpose: audit and publish a holder voting snapshot; no onchain transaction",
  ].every((line) => lines.has(line));
}

/** Client-side safety only; the server/runner re-read two finalized RPCs and
 * the immutable publication before any signed proposal can be prepared. */
export function canCreateOwnerProposal(status: OwnerGovernanceStatus | undefined,
  preview: OwnerProposalPreview | undefined, request: OwnerProposalPreviewRequest | undefined, now: number): boolean {
  if (status?.proposalControlReleased !== true || !preview || !request
    || !verifiedOwnerProposalPreview(preview, request)
    || status.launch?.activated !== true || status.launch.governanceBindState !== "bound"
    || !exactPubkey(status.governance?.program) || !exactPubkey(status.governance?.reserveMint)
    || !exactPubkey(status.governance?.boundCapitalMint)
    || status.governance?.boundCapitalMint !== status.launch.detectedMint
    || !/^[a-f0-9]{64}$/.test(status.governance?.programCodeSha256 ?? "")
    || preview.auditedAtUnix * 1_000 > now + 30_000
    || now - preview.auditedAtUnix * 1_000 > 90_000) return false;
  const action = ownerActionDrafts(status, now).find((item) => item.key === request.mode);
  return Boolean(action?.exactRaw && action.exactRaw === preview.draft.frozenReserveRawMstrx);
}

export function matchesProposalOwnerChallenge(message: string, status: OwnerGovernanceStatus | undefined,
  preview: OwnerProposalPreview | undefined, request: OwnerProposalPreviewRequest | undefined, now: number): boolean {
  if (!canCreateOwnerProposal(status, preview, request, now)) return false;
  const lines = new Set(message.split("\n"));
  return [
    `Action: ${request!.mode === "initial" ? "create_proposal" : "create_revote"}`,
    `Governance program: ${status!.governance!.program}`,
    `Reviewed program SHA-256: ${status!.governance!.programCodeSha256}`,
    `Reserve mint: ${status!.governance!.reserveMint}`,
    `Bound CAPITAL mint: ${status!.governance!.boundCapitalMint}`,
    `Config PDA: ${preview!.draft.config}`,
    `Reserve vault: ${preview!.draft.reserveVault}`,
    `Proposal ID: ${preview!.draft.id}`,
    `Proposal PDA: ${preview!.draft.proposal}`,
    ...(preview!.draft.previousProposal ? [`Previous proposal: ${preview!.draft.previousProposal}`] : []),
    `Frozen raw MSTRx: ${preview!.draft.frozenReserveRawMstrx}`,
    `Fixed marketing recipient: ${preview!.fixedMarketingRecipient}`,
    `Voting duration seconds: ${request!.votingDurationSeconds}`,
    ...request!.options.map((option, index) =>
      `Option ${index + 1}: ${option.action} | minimum raw output ${option.minOutputRaw ?? "0"} | lock seconds ${option.lockDurationSeconds ?? 0}`),
    `Published snapshot root: ${preview!.publication.merkleRoot}`,
    `Published total voting weight: ${preview!.publication.totalAvailableWeight}`,
    `Published source SHA-256: ${preview!.publication.sourceSha256}`,
    `Published snapshot SHA-256: ${preview!.publication.snapshotSha256}`,
    `Publication time: ${new Date(preview!.publication.publishedAtUnix * 1_000).toISOString()}`,
    `Exact preview SHA-256: ${preview!.previewHash}`,
    `Audited at: ${new Date(preview!.auditedAtUnix * 1_000).toISOString()}`,
  ].every((line) => lines.has(line));
}

/** Display-only readiness. The server and runner repeat authorization, PDA,
 * code-hash, chain-time and two-RPC account checks before any signed send. */
export function canFinalizeOwnerVote(status: OwnerGovernanceStatus | undefined, now: number): boolean {
  if (status?.finalizeVoteReleased !== true) return false;
  const proposal = verifiedOwnerProposal(status, now);
  const governance = status?.governance;
  return Boolean(proposal && status?.launch?.activated && status.launch.governanceBindState === "bound"
    && exactPubkey(governance?.program) && exactPubkey(governance?.reserveMint)
    && exactPubkey(governance?.vaultTokenAccount) && exactPubkey(governance?.boundCapitalMint)
    && governance?.boundCapitalMint === status.launch.detectedMint
    && /^[a-f0-9]{64}$/.test(governance?.programCodeSha256 ?? "")
    && [0, 6].includes(proposal.status)
    && now >= proposal.executableAt * 1_000
    && /^[a-f0-9]{64}$/.test(proposal.proposalStateSha256 ?? ""));
}

/** Prevent signing a finalization challenge for a different mint, ballot,
 * amount or frozen result than the owner panel currently displays. */
export function matchesFinalizeOwnerChallenge(message: string, status: OwnerGovernanceStatus | undefined, now: number): boolean {
  if (!canFinalizeOwnerVote(status, now)) return false;
  const proposal = verifiedOwnerProposal(status, now)!;
  const governance = status!.governance!;
  if (!exactPubkey(governance.program) || !exactPubkey(governance.reserveMint)
    || !exactPubkey(governance.vaultTokenAccount) || !exactPubkey(governance.boundCapitalMint)
    || !/^[a-f0-9]{64}$/.test(governance.programCodeSha256 ?? "")) return false;
  const program = new PublicKey(governance.program);
  const config = PublicKey.findProgramAddressSync([new TextEncoder().encode("config")], program)[0];
  const seed = new Uint8Array(8);
  let id = BigInt(proposal.id);
  for (let index = 0; index < 8; index++) { seed[index] = Number(id & 255n); id >>= 8n; }
  const proposalPda = PublicKey.findProgramAddressSync([new TextEncoder().encode("proposal"), seed], program)[0];
  const lines = new Set(message.split("\n"));
  return [
    "Action: finalize_vote", "Network: Solana Mainnet Beta",
    `Governance program: ${governance.program}`,
    `Reviewed program SHA-256: ${governance.programCodeSha256}`,
    `Reserve mint: ${governance.reserveMint}`,
    `Reserve vault: ${governance.vaultTokenAccount}`,
    `Bound CAPITAL mint: ${governance.boundCapitalMint}`,
    `Config PDA: ${config.toBase58()}`,
    `Proposal ID: ${proposal.id}`,
    `Proposal PDA: ${proposalPda.toBase58()}`,
    `Finalized proposal state SHA-256: ${proposal.proposalStateSha256}`,
    `Frozen raw MSTRx: ${proposal.frozenRaw}`,
  ].every((line) => lines.has(line));
}

export type VerifiedOwnerProposal = Omit<OwnerProposalStatus, "options"> & { options: OwnerProposalOption[] };

const U64_MAX = (1n << 64n) - 1n;
const EMPTY_RECIPIENT = SystemProgram.programId.toBase58();
const LOCK_TERMS = new Set([30, 90, 180, 365, 730, 1095, 1825].map((days) => days * 86_400).concat(0xffffffff));
const SPENDING = new Set<ReserveOutcome>(["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK", "MARKETING_SALE"]);

function rawU64(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return undefined;
  const amount = BigInt(value);
  return amount <= U64_MAX && value === amount.toString() ? amount : undefined;
}

function rawU128(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d{1,39}$/.test(value)) return undefined;
  const amount = BigInt(value);
  return amount <= (1n << 128n) - 1n && value === amount.toString() ? amount : undefined;
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_TIMESTAMP_SECONDS;
}

function exactPubkey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new PublicKey(value).toBase58() === value; }
  catch { return false; }
}

export function hasRecentVerifiedReserve(status: OwnerGovernanceStatus | undefined, now: number): boolean {
  const reserve = status?.governance;
  const total = rawU64(reserve?.vaultBalanceRaw);
  const committed = rawU64(reserve?.committedRaw);
  const free = rawU64(reserve?.freeRaw);
  return Boolean(reserve && Number.isSafeInteger(reserve.updatedAt) && reserve.updatedAt > 0
    && reserve.updatedAt <= now + 30_000 && now - reserve.updatedAt < 90_000
    && total !== undefined && committed !== undefined && free !== undefined
    && /^\d{1,20}$/.test(reserve.activeProposalId) && total === committed + free);
}

/** The panel displays option amounts and recipients only when a fresh,
 * two-RPC-verified server summary satisfies the immutable v3 option rules. */
export function verifiedOwnerProposal(status: OwnerGovernanceStatus | undefined, now: number): VerifiedOwnerProposal | undefined {
  if (!hasRecentVerifiedReserve(status, now)) return;
  const reserve = status!.governance!;
  const proposal = status?.governanceProposal;
  const frozen = rawU64(proposal?.frozenRaw);
  if (!proposal || !Number.isSafeInteger(proposal.updatedAt) || proposal.updatedAt <= 0
    || proposal.updatedAt > now + 30_000 || now - proposal.updatedAt >= 90_000
    || rawU64(proposal.id) === undefined || proposal.id === "0" || frozen === undefined || frozen === 0n
    || !Number.isSafeInteger(proposal.status) || proposal.status < 0 || proposal.status > 8
    || !Number.isSafeInteger(proposal.startsAt) || proposal.startsAt <= 0
    || !Number.isSafeInteger(proposal.endsAt) || proposal.endsAt <= proposal.startsAt
    || !Number.isSafeInteger(proposal.executableAt) || proposal.executableAt !== proposal.endsAt + 300
    || !Array.isArray(proposal.options) || proposal.options.length < 2 || proposal.options.length > 6) return;
  const active = [0, 1, 6, 7, 8].includes(proposal.status);
  if (active ? reserve.activeProposalId !== proposal.id || rawU64(reserve.committedRaw) !== frozen
    : reserve.activeProposalId !== "0" || reserve.committedRaw !== "0") return;
  const seen = new Set<string>();
  for (const option of proposal.options) {
    if (!option || !RESERVE_OUTCOMES.includes(option.action) || seen.has(option.action)) return;
    seen.add(option.action);
    const amount = rawU64(option.reserveRaw);
    const minimum = rawU64(option.minOutputRaw);
    if (amount !== (option.action === "ACCUMULATE" ? 0n : frozen) || minimum === undefined
      || (SPENDING.has(option.action) ? minimum === 0n : minimum !== 0n)
      || !Number.isSafeInteger(option.lockDurationSeconds)
      || (["BUYBACK_LOCK", "LOCK_MSTRX"].includes(option.action)
        ? !LOCK_TERMS.has(option.lockDurationSeconds) : option.lockDurationSeconds !== 0)
      || !exactPubkey(option.recipient)
      || (option.action === "MARKETING_SALE"
        ? !exactPubkey(proposal.fixedMarketingWallet) || proposal.fixedMarketingWallet === EMPTY_RECIPIENT
          || option.recipient !== proposal.fixedMarketingWallet
        : option.recipient !== EMPTY_RECIPIENT)) return;
  }
  if (!seen.has("ACCUMULATE")) return;
  const hasWinner = [1, 4, 5].includes(proposal.status);
  if (hasWinner ? !seen.has(proposal.winningAction ?? "") : proposal.winningAction !== undefined) return;
  const receipt = proposal.executionReceipt;
  const lock = proposal.executionLock;
  const winningOption = proposal.options.find((option) => option.action === proposal.winningAction);
  const needsReceipt = proposal.status === 4 && SPENDING.has(proposal.winningAction as ReserveOutcome);
  const needsLock = proposal.status === 4 && proposal.winningAction === "LOCK_MSTRX";
  if (Boolean(receipt) !== needsReceipt) return;
  if (Boolean(lock) !== needsLock) return;
  if (receipt && (!winningOption || !exactPubkey(receipt.address) || !exactPubkey(receipt.destination)
    || !exactPubkey(receipt.venue) || receipt.action !== proposal.winningAction
    || receipt.kind !== (receipt.action === "MARKETING_SALE" ? "MARKETING_SALE" : "BUYBACK")
    || rawU64(receipt.inputRawMstrx) !== frozen
    || rawU64(receipt.votedMinOutputRaw) !== rawU64(winningOption.minOutputRaw)
    || rawU64(receipt.actualOutputRaw) === undefined
    || rawU64(receipt.actualOutputRaw)! < rawU64(receipt.votedMinOutputRaw)!
    || !Number.isSafeInteger(receipt.executedAt) || receipt.executedAt < proposal.executableAt
    || receipt.executedAt * 1_000 > now + 30_000
    || (receipt.action === "MARKETING_SALE" && receipt.destination !== proposal.fixedMarketingWallet)
    || (receipt.action === "BUYBACK_BURN" && receipt.destination !== EMPTY_RECIPIENT))) return;
  if (lock && (!winningOption || !exactPubkey(lock.address) || !exactPubkey(lock.escrowAddress)
    || rawU64(lock.amountRawMstrx) !== frozen
    || !Number.isSafeInteger(lock.lockedAt) || lock.lockedAt < proposal.executableAt
    || lock.lockedAt * 1_000 > now + 30_000
    || !Number.isSafeInteger(lock.releaseAt)
    || lock.releaseAt !== (winningOption.lockDurationSeconds === 0xffffffff
      ? 0 : lock.lockedAt + winningOption.lockDurationSeconds)
    || !["ACTIVE", "MATURED_AWAITING_RELEASE", "RELEASED"].includes(lock.state))) return;
  return proposal as VerifiedOwnerProposal;
}

export interface OwnerActionDraft {
  key: "initial" | "revote" | "finalize" | "execute" | "release";
  label: string;
  state: string;
  exactRaw?: string;
  button: string;
}

/** Lifecycle hints are diagnostic only. No item is a sendable action. */
export function ownerActionDrafts(status: OwnerGovernanceStatus | undefined, now: number): OwnerActionDraft[] {
  const reserve = hasRecentVerifiedReserve(status, now) ? status!.governance! : undefined;
  const proposal = verifiedOwnerProposal(status, now);
  const free = rawU64(reserve?.freeRaw);
  const initial = Boolean(reserve && reserve.activeProposalId === "0" && reserve.committedRaw === "0"
    && free !== undefined && free > 0n);
  const revote = Boolean(proposal && [1, 7, 8].includes(proposal.status)
    && now >= proposal.executableAt * 1_000);
  const finalize = Boolean(proposal && [0, 6].includes(proposal.status)
    && now >= proposal.executableAt * 1_000);
  const execute = Boolean(proposal && proposal.status === 1
    && now >= proposal.executableAt * 1_000);
  return [
    { key: "initial", label: "Create initial ballot", state: initial ? "EXACT FREE RESERVE IDENTIFIED · SNAPSHOT REQUIRED" : "NO VERIFIED FREE RESERVE",
      exactRaw: initial ? reserve!.freeRaw : undefined, button: "CREATE BALLOT · LOCKED" },
    { key: "revote", label: "Open immediate re-vote", state: revote ? "EXACT PRIOR COMMITMENT IDENTIFIED · NEW SNAPSHOT REQUIRED" : "NOT ELIGIBLE FROM VERIFIED STATE",
      exactRaw: revote ? proposal!.frozenRaw : undefined, button: "OPEN RE-VOTE · LOCKED" },
    { key: "finalize", label: "Finalize vote result", state: finalize ? "RESULT DELAY ELAPSED · ONCHAIN RESULT REQUIRED" : "VOTE OR RESULT DELAY NOT COMPLETE",
      exactRaw: finalize ? proposal!.frozenRaw : undefined, button: "FINALIZE RESULT · LOCKED" },
    { key: "execute", label: "Execute winning decision", state: execute ? `VOTED ${proposal!.winningAction} · COMMITMENT STILL FROZEN` : "NO VERIFIED EXECUTABLE WINNER",
      exactRaw: execute ? proposal!.frozenRaw : undefined, button: "EXECUTE WINNER · LOCKED" },
    { key: "release", label: "Release matured lock", state: "MATURITY AND LOCK ACCOUNT NOT VERIFIED IN THIS PANEL",
      button: "RELEASE LOCK · LOCKED" },
  ];
}
