import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { readVerifiedGovernancePublicationDirectory } from "../../scripts/verify-governance-publication";
import type { GovernanceSnapshotManifest } from "./governanceSnapshotPublisher";
import { auditCreateProposalDraft, auditCreateRevoteDraft, type FinalizedGovernanceAccounts,
  type GovernanceProposalInstructionInput, type GovernanceRevoteInstructionInput } from "./governanceProposalInstruction";
import { GOVERNANCE_MAX_DURATION_SECONDS, GOVERNANCE_MIN_DURATION_SECONDS,
  RESERVE_ACTIONS, type GovernanceOption, type ReserveAction } from "./governancePolicy";
import { deriveGovernanceReserveRoute, type GovernanceReserveRoute } from "./governanceVaultRoute";
import { finalizedConsensus } from "./rpcConsensus";
import { MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION } from "./rpcTransactionVersion";

const MAX_U64 = (1n << 64n) - 1n;
const CONFIG_LENGTH = 306;

/** Shared canonical digest for the read-only preview and exact signed control
 * path. Keep every publication field in this payload: both sides must commit
 * to the same artifact identity, not merely its Merkle root. */
export function governanceProposalPreviewHash(input: {
  mode: "initial" | "revote";
  program: string;
  proposal: string;
  previousProposal?: string;
  data: string;
  keys: Array<[string, boolean, boolean]>;
  programCodeSha256: string;
  publication: GovernanceSnapshotManifest;
}) {
  const { mode, program, proposal, previousProposal, data, keys, programCodeSha256, publication } = input;
  return createHash("sha256").update(JSON.stringify({ mode, program, proposal, previousProposal,
    data, keys, programCodeSha256, publication })).digest("hex");
}

export function validateGovernancePreviewRpcPair(rpcUrls: readonly [string, string]) {
  let urls: URL[];
  try { urls = rpcUrls.map((value) => new URL(value)); }
  catch { throw new Error("GOVERNANCE_PREVIEW_RPC_PAIR_INVALID"); }
  if (urls.length !== 2 || urls.some((url) => url.protocol !== "https:" || url.username || url.password || url.hash)
    || urls[0].hostname === urls[1].hostname) throw new Error("GOVERNANCE_PREVIEW_RPC_PAIR_INVALID");
}

export interface GovernanceProposalPreviewRequest {
  mode: "initial" | "revote";
  votingDurationSeconds: number;
  options: Array<{ action: ReserveAction; lockDurationSeconds?: number; minOutputRaw?: string }>;
}

export function normalizeGovernanceProposalPreviewRequest(value: unknown): GovernanceProposalPreviewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GOVERNANCE_PREVIEW_REQUEST_INVALID");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !["mode", "votingDurationSeconds", "options"].includes(key))
    || !["initial", "revote"].includes(object.mode as string)
    || !Number.isSafeInteger(object.votingDurationSeconds)
    || (object.votingDurationSeconds as number) < GOVERNANCE_MIN_DURATION_SECONDS
    || (object.votingDurationSeconds as number) > GOVERNANCE_MAX_DURATION_SECONDS
    || !Array.isArray(object.options) || object.options.length < 2 || object.options.length > 6) {
    throw new Error("GOVERNANCE_PREVIEW_REQUEST_INVALID");
  }
  const options = object.options.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GOVERNANCE_PREVIEW_OPTION_INVALID");
    const option = value as Record<string, unknown>;
    if (Object.keys(option).some((key) => !["action", "lockDurationSeconds", "minOutputRaw"].includes(key))
      || !RESERVE_ACTIONS.includes(option.action as ReserveAction)
      || (option.lockDurationSeconds !== undefined && (!Number.isSafeInteger(option.lockDurationSeconds)
        || (option.lockDurationSeconds as number) < 0))
      || (option.minOutputRaw !== undefined && (typeof option.minOutputRaw !== "string"
        || !/^(0|[1-9]\d*)$/.test(option.minOutputRaw)
        || BigInt(option.minOutputRaw) > MAX_U64))) {
      throw new Error("GOVERNANCE_PREVIEW_OPTION_INVALID");
    }
    return { action: option.action as ReserveAction,
      ...(option.lockDurationSeconds === undefined ? {} : { lockDurationSeconds: option.lockDurationSeconds as number }),
      ...(option.minOutputRaw === undefined ? {} : { minOutputRaw: option.minOutputRaw as string }) };
  });
  return { mode: object.mode as GovernanceProposalPreviewRequest["mode"],
    votingDurationSeconds: object.votingDurationSeconds as number, options };
}

async function checkedBlock(connection: Connection, slot: number) {
  const block = await connection.getBlock(slot, { commitment: "finalized",
    maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
    transactionDetails: "none", rewards: false });
  if (!block || !block.blockhash) throw new Error("GOVERNANCE_PREVIEW_FINALIZED_BLOCK_UNAVAILABLE");
  return block;
}

async function readFinalizedViews(rpcUrls: readonly [string, string], route: GovernanceReserveRoute,
  mode: GovernanceProposalPreviewRequest["mode"]) {
  const derived = deriveGovernanceReserveRoute(route.governanceProgram, route.reserveMint);
  const consensus = await finalizedConsensus(rpcUrls);
  const connections = rpcUrls.map((url) => new Connection(url, "finalized"));
  const configs = await Promise.all(connections.map(async (connection) => {
    const read = await connection.getMultipleAccountsInfoAndContext([derived.authority], {
      commitment: "finalized", minContextSlot: consensus.slot });
    const config = read.value[0];
    if (read.context.slot < consensus.slot || !config?.owner.equals(derived.program)
      || config.data.length !== CONFIG_LENGTH) throw new Error("GOVERNANCE_PREVIEW_CONFIG_UNVERIFIED");
    return config.data;
  }));
  if (!configs[0].equals(configs[1])) throw new Error("GOVERNANCE_PREVIEW_CONFIG_RPC_DISAGREEMENT");
  const lastId = configs[0].readBigUInt64LE(281);
  const nextId = lastId + 1n;
  if (nextId > MAX_U64) throw new Error("GOVERNANCE_PREVIEW_PROPOSAL_ID_OVERFLOW");
  let previousProposalAddress: PublicKey | undefined;
  if (mode === "revote") {
    if (lastId === 0n) throw new Error("GOVERNANCE_PREVIEW_PREVIOUS_MISSING");
    const seed = Buffer.alloc(8);
    seed.writeBigUInt64LE(lastId);
    [previousProposalAddress] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], derived.program);
  }
  const addresses = [derived.program, derived.programDataAddress, derived.authority, derived.ata,
    new PublicKey(route.capitalMint), ...(previousProposalAddress ? [previousProposalAddress] : [])];
  const views = await Promise.all(connections.map(async (connection): Promise<FinalizedGovernanceAccounts> => {
    const read = await connection.getMultipleAccountsInfoAndContext(addresses, {
      commitment: "finalized", minContextSlot: consensus.slot });
    if (read.context.slot < consensus.slot || !read.value[2]?.data.equals(configs[0])) {
      throw new Error("GOVERNANCE_PREVIEW_STATE_CHANGED_DURING_READ");
    }
    const block = await checkedBlock(connection, read.context.slot);
    return { slot: read.context.slot, blockhash: block.blockhash,
      accounts: { program: read.value[0], programData: read.value[1], config: read.value[2],
        vault: read.value[3], capitalMint: read.value[4],
        previousProposal: previousProposalAddress ? read.value[5] : undefined } };
  }));
  return { nextId, previousProposalAddress, views: views as [FinalizedGovernanceAccounts, FinalizedGovernanceAccounts], connections };
}

export async function auditGovernanceProposal(input: {
  request: unknown;
  rpcUrls: readonly [string, string];
  route: GovernanceReserveRoute;
  publicDataRoot: string;
  nowMs?: number;
}) {
  const request = normalizeGovernanceProposalPreviewRequest(input.request);
  validateGovernancePreviewRpcPair(input.rpcUrls);
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("GOVERNANCE_PREVIEW_TIME_INVALID");
  const { nextId, previousProposalAddress, views, connections } = await readFinalizedViews(input.rpcUrls, input.route, request.mode);
  const directory = resolve(input.publicDataRoot, "governance", "proposals", nextId.toString());
  const { manifest: publication, snapshot } = await readVerifiedGovernancePublicationDirectory(directory);
  if (snapshot.proposalId !== nextId.toString()) throw new Error("GOVERNANCE_PREVIEW_PUBLICATION_ID_MISMATCH");
  const snapshotBlocks = await Promise.all(connections.map((connection) => checkedBlock(connection, snapshot.finalizedThroughSlot)));
  if (snapshotBlocks.some((block) => block.blockhash !== snapshot.finalizedBlockhash)) {
    throw new Error("GOVERNANCE_PREVIEW_SNAPSHOT_BLOCK_DISAGREEMENT");
  }
  const marketingWallet = views[0].accounts.config?.data.subarray(169, 201);
  if (!marketingWallet || marketingWallet.length !== 32) throw new Error("GOVERNANCE_PREVIEW_MARKETING_WALLET_INVALID");
  const fixedMarketingWallet = new PublicKey(marketingWallet).toBase58();
  const options: GovernanceOption[] = request.options.map((option) => ({
    action: option.action, lockDurationSeconds: option.lockDurationSeconds,
    minOutputRaw: BigInt(option.minOutputRaw ?? "0"),
    ...(option.action === "MARKETING_SALE" ? { recipient: fixedMarketingWallet } : {}),
  }));
  const firstVault = views[0].accounts.vault;
  const secondVault = views[1].accounts.vault;
  if (!firstVault || !secondVault || firstVault.data.length < 72 || secondVault.data.length < 72) {
    throw new Error("GOVERNANCE_PREVIEW_VAULT_UNVERIFIED");
  }
  const firstBalance = firstVault.data.readBigUInt64LE(64);
  const secondBalance = secondVault.data.readBigUInt64LE(64);
  const base: GovernanceProposalInstructionInput = { route: input.route, finalizedAccounts: views,
    snapshotFinality: { slot: snapshot.finalizedThroughSlot, blockhash: snapshot.finalizedBlockhash },
    snapshot, publication, observedClockUnix: Math.floor(nowMs / 1_000),
    votingDurationSeconds: request.votingDurationSeconds,
    frozenReserveRawMstrx: request.mode === "initial"
      ? (firstBalance < secondBalance ? firstBalance : secondBalance)
      : views[0].accounts.config!.data.readBigUInt64LE(297),
    options };
  const instructionInput = request.mode === "initial" ? base
    : { ...base, previousProposalAddress: previousProposalAddress!.toBase58() } as GovernanceRevoteInstructionInput;
  const draft = request.mode === "initial" ? auditCreateProposalDraft(base)
    : auditCreateRevoteDraft(instructionInput as GovernanceRevoteInstructionInput);
  const frozen = draft.frozenReserveRawMstrx;
  const displayedOptions = options.map((option) => ({ action: option.action,
    reserveRaw: option.action === "ACCUMULATE" ? "0" : frozen.toString(),
    minOutputRaw: (option.minOutputRaw ?? 0n).toString(),
    recipient: option.recipient ?? "11111111111111111111111111111111",
    lockDurationSeconds: option.lockDurationSeconds ?? 0 }));
  const previewHash = governanceProposalPreviewHash({ mode: request.mode,
    program: draft.programId, proposal: draft.proposal, previousProposal: draft.previousProposal,
    data: draft.data.toString("hex"), keys: draft.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    programCodeSha256: input.route.expectedProgramCodeSha256, publication,
  });
  const preview = { ok: true as const, sendable: false as const, previewHash,
    auditedAtUnix: Math.floor(nowMs / 1_000),
    fixedMarketingRecipient: fixedMarketingWallet,
    draft: { id: draft.id.toString(), proposal: draft.proposal, config: draft.config,
      reserveVault: draft.reserveVault, frozenReserveRawMstrx: frozen.toString(),
      estimatedStartsAt: draft.estimatedStartsAt, estimatedEndsAt: draft.estimatedEndsAt,
      estimatedExecutableAt: draft.estimatedExecutableAt,
      ...(draft.previousProposal ? { previousProposal: draft.previousProposal } : {}),
      unreleasedExecutors: draft.unreleasedExecutors },
    publication, options: displayedOptions };
  return { preview, instructionInput, mode: request.mode, draft };
}

/** Public endpoint returns only display values. The runner may separately
 * re-audit both RPCs and use instructionInput with the source-gated builders. */
export async function previewGovernanceProposal(input: Parameters<typeof auditGovernanceProposal>[0]) {
  return (await auditGovernanceProposal(input)).preview;
}
