import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toBytes,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import {
  normalizePostlaunchManifest,
  normalizePrelaunchManifest,
  verifyPostlaunchManifest,
  verifyPrelaunchManifest,
} from "../admin/launchManifest";
import { normalizeGovernanceDraft } from "../admin/governanceDraft";
import { PublicKey } from "@solana/web3.js";
import {
  SOLANA_CONTROL_ACTIONS, SOLANA_CONTROL_CHALLENGE_MS, SOLANA_CONTROL_NETWORK,
  SOLANA_GOVERNANCE_FINALIZE_RELEASED, SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED,
  SOLANA_GOVERNANCE_RESERVE_WITHDRAWAL_RELEASED, solanaControlMessage,
  validateFinalizeVoteIntent, validateFreeReserveWithdrawalIntent, validateProposalControlIntent,
  validateSnapshotPublicationIntent,
  validateLockExecutionIntent,
  validateMarketingExecutionIntent,
  verifySignedSolanaControlAction, type FinalizeVoteIntent, type FreeReserveWithdrawalIntent,
  type ProposalControlIntent, type SnapshotPublicationIntent, type LockExecutionIntent,
  type MarketingExecutionIntent,
} from "../solana/controlAuth";
import { mstrxAta } from "../solana/mstrxTransfers";
import { readControlRequestOutcome } from "../solana/controlRequestStatus";
import { blockLegacyAdminPath, solanaAdminMode } from "./adminRoutePolicy";
import { handlePublicSolanaRpc } from "./publicSolanaRpc";
import { handleGovernanceVoteRpc } from "./governanceVoteRelay";
import { normalizeGovernanceProposalPreviewRequest, previewGovernanceProposal } from "../solana/governanceProposalPreview";
import { deriveGovernanceReserveRoute } from "../solana/governanceVaultRoute";
import { auditLockExecution } from "../solana/governanceLockExecutionControl";
import { SOLANA_GOVERNANCE_EXECUTION_RELEASED } from "../solana/releaseGates";
import { auditBuybackExecution } from "../solana/governanceBuybackExecutionControl";
import { validateBuybackExecutionIntent, type BuybackExecutionIntent } from "../solana/governanceBuybackIntent";
import { auditMarketingExecution } from "../solana/governanceMarketingExecutionControl";
import { auditLockRelease, validateLockReleaseIntent,
  type LockReleaseIntent } from "../solana/governanceLockReleaseControl";
import { OFFCHAIN_ACTIONS, offchainTally, recordOffchainVote, validateOffchainBallot,
  verifiedOffchainSnapshot, voteWeight, type OffchainBallot, type SignedOffchainVote } from "../solana/offchainGovernance";
import { validateOffchainBallotIntent, type OffchainBallotIntent } from "../solana/offchainBallotPublisher";

const port = Number(process.env.PORT || "8787");
const staticRoot = resolve(process.env.WEB_STATIC_ROOT || "dist/web");
const publicDataRoot = resolve(process.env.PUBLIC_DATA_ROOT || "data/public");
const controlDataRoot = resolve(process.env.CONTROL_DATA_ROOT || "data/control");
const adminOwner = process.env.ADMIN_OWNER_ADDRESS
  ? getAddress(process.env.ADMIN_OWNER_ADDRESS)
  : undefined;
const reserveVault = process.env.RESERVE_VAULT_ADDRESS
  ? getAddress(process.env.RESERVE_VAULT_ADDRESS)
  : undefined;
const mstrToken = process.env.VITE_MSTR_ADDRESS
  ? getAddress(process.env.VITE_MSTR_ADDRESS)
  : undefined;
const wethToken = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const v3Quoter = getAddress("0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7");
const reserveQuoteAbi = parseAbi(["function availableBalance() view returns (uint256)"]);
const erc20QuoteAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const adminPanelPath = (() => {
  const value = process.env.ADMIN_PANEL_PATH?.trim().replace(/\/$/, "");
  if (!value) return undefined;
  if (!/^\/[a-zA-Z0-9_-]{16,120}$/.test(value) || value === "/admin") {
    throw new Error("ADMIN_PANEL_PATH must be an unlisted path with at least 16 letters, numbers, dashes or underscores");
  }
  return value;
})();
const solanaAdminApiRoot = adminPanelPath ? `${adminPanelPath}/api/solana` : undefined;
let governancePreviewInFlight = false;
let governancePreviewStartedAt = 0;
let governanceProposalChallengeStartedAt = 0;
let governanceLockAuditInFlight = false;
let governanceLockAuditStartedAt = 0;
let governanceSpendingAuditInFlight = false;
let governanceSpendingAuditStartedAt = 0;
const allowedAdminActions = new Set([
  "start_automation", "stop_automation", "register_prelaunch", "arm_launch_detection",
  "cancel_launch_detection", "activate_postlaunch", "prepare_governance",
]);
const solanaAdminOwner = (() => {
  const value = process.env.SOLANA_ADMIN_OWNER?.trim();
  if (!value) return undefined;
  return new PublicKey(value).toBase58();
})();
const isSolanaAdminMode = solanaAdminMode(process.env.SOLANA_CLUSTER, solanaAdminOwner);
const challenges = new Map<string, { action: string; message: string; expiresAt: number; payload?: unknown }>();
const solanaChallenges = new Map<string, { action: string; message: string; issuedAt: number; expiresAt: number; nonce: string;
  withdrawal?: FreeReserveWithdrawalIntent; finalization?: FinalizeVoteIntent; proposalCreation?: ProposalControlIntent;
  snapshotPublication?: SnapshotPublicationIntent; lockExecution?: LockExecutionIntent;
  buybackExecution?: BuybackExecutionIntent; marketingExecution?: MarketingExecutionIntent;
  lockRelease?: LockReleaseIntent; offchainBallot?: OffchainBallotIntent }>();
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function safePath(root: string, pathname: string): string | undefined {
  const target = resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return;
  return target;
}

async function fileResponse(path: string) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("NOT_FILE");
  return readFile(path);
}

function jsonResponse(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function verifiedReserveQuote(requestedAmount?: bigint) {
  const primaryUrl = process.env.ROBINHOOD_RPC_URL?.trim();
  const fallbackUrl = process.env.ROBINHOOD_RPC_FALLBACK_URL?.trim();
  if (!primaryUrl || !fallbackUrl || !reserveVault || !mstrToken || !adminOwner) {
    return { ok: false, reason: "quote_providers_unavailable" } as const;
  }

  const clients = [
    createPublicClient({ transport: http(primaryUrl, { timeout: 12_000 }) }),
    createPublicClient({ transport: http(fallbackUrl, { timeout: 12_000 }) }),
  ];
  const latest = await Promise.all(clients.map((client) => client.getBlockNumber()));
  const commonBlock = (latest[0] < latest[1] ? latest[0] : latest[1]) - 2n;
  if (commonBlock <= 0n || (latest[0] > latest[1] ? latest[0] - latest[1] : latest[1] - latest[0]) > 8n) {
    return { ok: false, reason: "quote_providers_out_of_sync" } as const;
  }

  const blocks = await Promise.all(clients.map((client) => client.getBlock({ blockNumber: commonBlock })));
  if (!blocks[0].hash || blocks[0].hash !== blocks[1].hash) {
    return { ok: false, reason: "quote_block_disagreement" } as const;
  }

  const snapshots = await Promise.all(clients.map(async (client) => {
    const available = await client.readContract({
      address: reserveVault,
      abi: reserveQuoteAbi,
      functionName: "availableBalance",
      blockNumber: commonBlock,
    });
    const walletMstr = await client.readContract({
      address: mstrToken,
      abi: erc20QuoteAbi,
      functionName: "balanceOf",
      args: [adminOwner],
      blockNumber: commonBlock,
    });
    const amountIn = requestedAmount ?? (available > 0n ? available : walletMstr);
    if (amountIn < 0n || (available > 0n ? amountIn !== available : amountIn > walletMstr)) {
      throw new Error("QUOTE_AMOUNT_INVALID");
    }
    if (amountIn === 0n) return { available, walletMstr, amountIn, amountOut: 0n };
    const path = encodePacked(["address", "uint24", "address"], [mstrToken, 10_000, wethToken]);
    const data = encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactInput", args: [path, amountIn] });
    const result = await client.call({ to: v3Quoter, data, blockNumber: commonBlock });
    if (!result.data) throw new Error("QUOTE_EMPTY");
    const amountOut = decodeFunctionResult({ abi: quoterAbi, functionName: "quoteExactInput", data: result.data })[0];
    return { available, walletMstr, amountIn, amountOut };
  }));

  const [left, right] = snapshots;
  if (left.available !== right.available || left.walletMstr !== right.walletMstr
    || left.amountIn !== right.amountIn || left.amountOut !== right.amountOut) {
    return { ok: false, reason: "quote_state_disagreement" } as const;
  }

  return {
    ok: true,
    blockNumber: commonBlock.toString(),
    blockHash: blocks[0].hash,
    source: left.available > 0n && left.amountIn === left.available ? "reserve" : "admin_wallet",
    amountIn: left.amountIn.toString(),
    amountOut: left.amountOut.toString(),
    providers: 2,
  } as const;
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function cleanChallenges(now = Date.now()) {
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAt < now) challenges.delete(id);
  }
  for (const [id, challenge] of solanaChallenges) {
    if (challenge.expiresAt < now) solanaChallenges.delete(id);
  }
}

function adminChallenge(action: string, payload?: unknown) {
  if (!adminOwner || !allowedAdminActions.has(action)) return;
  cleanChallenges();
  if (challenges.size >= 500) challenges.delete(challenges.keys().next().value as string);
  const id = randomBytes(20).toString("hex");
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 5 * 60_000;
  const readableActions: Record<string, string> = {
    start_automation: "START AUTOMATION",
    stop_automation: "STOP AUTOMATION",
    register_prelaunch: "REGISTER PRELAUNCH CONTRACTS",
    arm_launch_detection: "ARM PONS LAUNCH DETECTION",
    cancel_launch_detection: "CANCEL PONS LAUNCH DETECTION",
    activate_postlaunch: "ACTIVATE NEW PROJECT",
    prepare_governance: "PREPARE GOVERNANCE PROPOSAL",
  };
  const payloadHash = payload === undefined ? undefined : keccak256(toBytes(JSON.stringify(payload)));
  const message = [
    "MSTR SYSTEM ADMIN",
    `Action: ${readableActions[action]}`,
    `Owner: ${adminOwner}`,
    "Chain: Robinhood Chain (4663)",
    ...(payloadHash ? [`Payload: ${payloadHash}`] : []),
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    `Nonce: ${id}`,
  ].join("\n");
  challenges.set(id, { action, message, expiresAt, payload });
  return { id, action, message, expiresAt, owner: adminOwner };
}

async function queueAdminAction(challengeId: string, signature: Hex) {
  if (!adminOwner) throw new Error("ADMIN_DISABLED");
  cleanChallenges();
  const challenge = challenges.get(challengeId);
  if (!challenge) throw new Error("CHALLENGE_INVALID");
  challenges.delete(challengeId);
  const valid = await verifyMessage({ address: adminOwner as Address, message: challenge.message, signature });
  if (!valid) throw new Error("SIGNATURE_INVALID");

  let payload = challenge.payload;
  if (challenge.action === "register_prelaunch") {
    const normalized = normalizePrelaunchManifest(payload, adminOwner);
    await verifyPrelaunchManifest(normalized);
    payload = normalized;
  } else if (challenge.action === "activate_postlaunch") {
    const normalized = normalizePostlaunchManifest(payload, adminOwner);
    await verifyPostlaunchManifest(normalized);
    payload = normalized;
  } else if (challenge.action === "prepare_governance") {
    payload = normalizeGovernanceDraft(payload);
  }

  const queueDir = resolve(controlDataRoot, "requests");
  await mkdir(queueDir, { recursive: true });
  const requestId = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  await writeFile(resolve(queueDir, `${requestId}.json`), JSON.stringify({
    id: requestId,
    action: challenge.action,
    signer: adminOwner,
    requestedAt: Date.now(),
    ...(payload === undefined ? {} : { payload }),
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { ok: true, requestId, action: challenge.action };
}

async function verifiedSolanaProposalPreview(rawRequest: unknown, kind: "preview" | "challenge" = "preview") {
  const startedAt = Date.now();
  if (governancePreviewInFlight || startedAt - (kind === "preview"
    ? governancePreviewStartedAt : governanceProposalChallengeStartedAt) < 5_000) {
    throw new Error("GOVERNANCE_PREVIEW_RATE_LIMITED");
  }
  governancePreviewInFlight = true;
  if (kind === "preview") governancePreviewStartedAt = startedAt;
  else governanceProposalChallengeStartedAt = startedAt;
  try {
  if (!isSolanaAdminMode || !solanaAdminOwner) throw new Error("GOVERNANCE_PREVIEW_ADMIN_DISABLED");
  const rpcPrimary = process.env.SOLANA_RPC_PRIMARY_URL?.trim();
  const rpcFallback = process.env.SOLANA_RPC_FALLBACK_URL?.trim();
  const governanceProgram = process.env.SOLANA_GOVERNANCE_PROGRAM?.trim();
  const reserveMint = process.env.SOLANA_MSTRX_MINT?.trim();
  const expectedProgramCodeSha256 = process.env.SOLANA_GOVERNANCE_PROGRAM_CODE_SHA256?.trim();
  const capitalMint = process.env.SOLANA_CAPITAL_MINT?.trim();
  if (!rpcPrimary || !rpcFallback || !governanceProgram || !reserveMint || !capitalMint
    || !expectedProgramCodeSha256 || !/^[a-f0-9]{64}$/.test(expectedProgramCodeSha256)) {
    throw new Error("GOVERNANCE_PREVIEW_CONFIGURATION_UNAVAILABLE");
  }
  const launch = JSON.parse(await readFile(resolve(publicDataRoot, "config.json"), "utf8")) as {
    network?: string; projectMint?: string;
  };
  if (launch.network !== "solana-mainnet-beta" || launch.projectMint !== capitalMint) {
    throw new Error("GOVERNANCE_PREVIEW_LAUNCH_IDENTITY_MISMATCH");
  }
  const derived = deriveGovernanceReserveRoute(governanceProgram, reserveMint);
  const request = normalizeGovernanceProposalPreviewRequest(rawRequest);
  const preview = await previewGovernanceProposal({
    request, publicDataRoot, rpcUrls: [rpcPrimary, rpcFallback],
    route: { governanceProgram, reserveAuthority: derived.authority.toBase58(), reserveMint,
      capitalMint, admin: solanaAdminOwner, expectedProgramCodeSha256 },
  });
  return { preview, request, governanceProgram, reserveMint, capitalMint, expectedProgramCodeSha256 };
  } finally {
    governancePreviewInFlight = false;
  }
}

async function guardedLockAudit(environment: Parameters<typeof auditLockExecution>[0], proposalId: string) {
  const startedAt = Date.now();
  if (governanceLockAuditInFlight || startedAt - governanceLockAuditStartedAt < 5_000) {
    throw new Error("GOVERNANCE_LOCK_RATE_LIMITED");
  }
  governanceLockAuditInFlight = true;
  governanceLockAuditStartedAt = startedAt;
  try { return await auditLockExecution(environment, proposalId); }
  finally { governanceLockAuditInFlight = false; }
}

async function guardedSpendingAudit<T>(task: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  if (governanceSpendingAuditInFlight || startedAt - governanceSpendingAuditStartedAt < 5_000) {
    throw new Error("GOVERNANCE_EXECUTION_RATE_LIMITED");
  }
  governanceSpendingAuditInFlight = true;
  governanceSpendingAuditStartedAt = startedAt;
  try { return await task(); }
  finally { governanceSpendingAuditInFlight = false; }
}

async function solanaAdminChallenge(action: string, amountRaw?: unknown,
  proposalRequest?: unknown, previewHash?: unknown, previewAuditedAtUnix?: unknown,
  releaseProposalId?: unknown, durationHours?: unknown) {
  if (!solanaAdminOwner || !SOLANA_CONTROL_ACTIONS.has(action)) return;
  cleanChallenges();
  if (!["create_proposal", "create_revote"].includes(action)
    && (proposalRequest !== undefined || previewHash !== undefined || previewAuditedAtUnix !== undefined)) {
    throw new Error("CONTROL_ACTION_PAYLOAD_INVALID");
  }
  if (action !== "release_lock_mstrx" && releaseProposalId !== undefined) {
    throw new Error("CONTROL_ACTION_PAYLOAD_INVALID");
  }
  if (action !== "start_offchain_ballot" && durationHours !== undefined) {
    throw new Error("CONTROL_ACTION_PAYLOAD_INVALID");
  }
  let withdrawal: FreeReserveWithdrawalIntent | undefined;
  let finalization: FinalizeVoteIntent | undefined;
  let proposalCreation: ProposalControlIntent | undefined;
  let snapshotPublication: SnapshotPublicationIntent | undefined;
  let lockExecution: LockExecutionIntent | undefined;
  let buybackExecution: BuybackExecutionIntent | undefined;
  let marketingExecution: MarketingExecutionIntent | undefined;
  let lockRelease: LockReleaseIntent | undefined;
  let offchainBallot: OffchainBallotIntent | undefined;
  if (action === "withdraw_free_reserve") {
    if (!SOLANA_GOVERNANCE_RESERVE_WITHDRAWAL_RELEASED) throw new Error("RESERVE_WITHDRAWAL_NOT_RELEASED");
    if (typeof amountRaw !== "string" || !/^[1-9]\d{0,19}$/.test(amountRaw)) throw new Error("RESERVE_WITHDRAWAL_AMOUNT_INVALID");
    // The web container has only read access to this runner-produced, two-RPC-
    // verified snapshot. The runner will independently verify again before it
    // constructs or sends the fixed-destination onchain instruction.
    const snapshot = JSON.parse(await readFile(resolve(controlDataRoot, "solana-status-visible", "solana-status.json"), "utf8")) as {
      launch?: { activated?: boolean; governanceBindState?: string };
      governanceWithdrawal?: { state?: string };
      governance?: { program?: string; programCodeSha256?: string; reserveMint?: string; vaultTokenAccount?: string;
        boundCapitalMint?: string | null; vaultBalanceRaw?: string; committedRaw?: string; freeRaw?: string; updatedAt?: number };
    };
    const governance = snapshot.governance;
    if (!snapshot.launch?.activated || snapshot.launch.governanceBindState !== "bound"
      || ["prepared", "pending", "unresolved"].includes(snapshot.governanceWithdrawal?.state ?? "")
      || !governance?.boundCapitalMint || !governance.updatedAt
      || Date.now() - governance.updatedAt > 90_000 || governance.updatedAt > Date.now() + 30_000
      || !/^(0|[1-9]\d*)$/.test(governance.freeRaw ?? "")
      || !/^(0|[1-9]\d*)$/.test(governance.vaultBalanceRaw ?? "")
      || !/^(0|[1-9]\d*)$/.test(governance.committedRaw ?? "")
      || BigInt(governance.vaultBalanceRaw!) - BigInt(governance.committedRaw!) !== BigInt(governance.freeRaw!)
      || BigInt(amountRaw) > BigInt(governance.freeRaw!)) throw new Error("RESERVE_WITHDRAWAL_QUOTE_UNAVAILABLE");
    const mint = new PublicKey(governance.reserveMint!).toBase58();
    withdrawal = {
      amountRaw,
      governanceProgram: governance.program!,
      programCodeSha256: governance.programCodeSha256!,
      reserveMint: mint,
      reserveVault: governance.vaultTokenAccount!,
      capitalMint: governance.boundCapitalMint,
      adminAta: mstrxAta(new PublicKey(solanaAdminOwner), new PublicKey(mint)).toBase58(),
      verifiedAt: governance.updatedAt,
    };
  } else if (action === "finalize_vote") {
    if (!SOLANA_GOVERNANCE_FINALIZE_RELEASED) throw new Error("GOVERNANCE_FINALIZE_NOT_RELEASED");
    if (amountRaw !== undefined) throw new Error("GOVERNANCE_FINALIZE_ACTION_INVALID");
    const snapshot = JSON.parse(await readFile(resolve(controlDataRoot, "solana-status-visible", "solana-status.json"), "utf8")) as {
      governanceFinalizeReleased?: boolean;
      launch?: { activated?: boolean; governanceBindState?: string; detectedMint?: string };
      governanceWithdrawal?: { state?: string };
      governance?: { program?: string; programCodeSha256?: string; reserveMint?: string; vaultTokenAccount?: string;
        boundCapitalMint?: string | null; committedRaw?: string; activeProposalId?: string; updatedAt?: number };
      governanceProposal?: { id?: string; status?: number; frozenRaw?: string; executableAt?: number;
        proposalStateSha256?: string; updatedAt?: number };
    };
    const config = snapshot.governance;
    const proposal = snapshot.governanceProposal;
    if (!snapshot.governanceFinalizeReleased || !snapshot.launch?.activated || snapshot.launch.governanceBindState !== "bound"
      || !config?.program || !config.programCodeSha256 || !config.reserveMint || !config.vaultTokenAccount
      || !config.boundCapitalMint || config.boundCapitalMint !== snapshot.launch.detectedMint
      || !proposal || ![0, 6].includes(proposal.status ?? -1)
      || proposal.id !== config.activeProposalId || proposal.frozenRaw !== config.committedRaw
      || !proposal.proposalStateSha256 || !proposal.executableAt || !proposal.updatedAt
      || Math.floor(Date.now() / 1000) < proposal.executableAt
      || !config.updatedAt || Date.now() - Math.min(config.updatedAt, proposal.updatedAt) > 90_000
      || Math.max(config.updatedAt, proposal.updatedAt) > Date.now() + 30_000
      || ["prepared", "pending", "unresolved"].includes(snapshot.governanceWithdrawal?.state ?? "")) {
      throw new Error("GOVERNANCE_FINALIZE_QUOTE_UNAVAILABLE");
    }
    const program = new PublicKey(config.program);
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program);
    const seed = Buffer.alloc(8);
    seed.writeBigUInt64LE(BigInt(proposal.id!));
    const [proposalPda] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), seed], program);
    finalization = {
      governanceProgram: config.program, programCodeSha256: config.programCodeSha256,
      reserveMint: config.reserveMint, reserveVault: config.vaultTokenAccount,
      capitalMint: config.boundCapitalMint, config: configPda.toBase58(),
      proposalId: proposal.id!, proposal: proposalPda.toBase58(),
      proposalStateSha256: proposal.proposalStateSha256, frozenReserveRawMstrx: proposal.frozenRaw!,
      executableAt: proposal.executableAt, verifiedAt: Math.min(config.updatedAt, proposal.updatedAt),
    };
  } else if (["create_proposal", "create_revote"].includes(action)) {
    if (!SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED) throw new Error("GOVERNANCE_PROPOSAL_NOT_RELEASED");
    if (amountRaw !== undefined || typeof previewHash !== "string" || !/^[a-f0-9]{64}$/.test(previewHash)
      || !Number.isSafeInteger(previewAuditedAtUnix)
      || Math.abs(Date.now() - (previewAuditedAtUnix as number) * 1_000) > 90_000) {
      throw new Error("GOVERNANCE_PROPOSAL_PREVIEW_STALE");
    }
    const { preview, request, governanceProgram, reserveMint, capitalMint,
      expectedProgramCodeSha256 } = await verifiedSolanaProposalPreview(proposalRequest, "challenge");
    if (request.mode !== (action === "create_revote" ? "revote" : "initial")
      || preview.previewHash !== previewHash || preview.draft.unreleasedExecutors.length !== 0) {
      throw new Error("GOVERNANCE_PROPOSAL_PREVIEW_CHANGED");
    }
    proposalCreation = {
      request, previewHash: preview.previewHash, auditedAtUnix: preview.auditedAtUnix,
      governanceProgram, programCodeSha256: expectedProgramCodeSha256,
      reserveMint, capitalMint,
      config: preview.draft.config, reserveVault: preview.draft.reserveVault,
      proposalId: preview.draft.id, proposal: preview.draft.proposal,
      frozenReserveRawMstrx: preview.draft.frozenReserveRawMstrx,
      ...(preview.draft.previousProposal ? { previousProposal: preview.draft.previousProposal } : {}),
      fixedMarketingRecipient: preview.fixedMarketingRecipient,
      publication: preview.publication,
    };
  } else if (action === "publish_snapshot") {
    if (!SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED) throw new Error("GOVERNANCE_SNAPSHOT_NOT_RELEASED");
    if (amountRaw !== undefined) throw new Error("CONTROL_ACTION_PAYLOAD_INVALID");
    const snapshot = JSON.parse(await readFile(resolve(controlDataRoot, "solana-status-visible", "solana-status.json"), "utf8")) as {
      launch?: { activated?: boolean; governanceBindState?: string; detectedMint?: string };
      governance?: { program?: string; programCodeSha256?: string; reserveMint?: string;
        boundCapitalMint?: string | null; lastProposalId?: string; updatedAt?: number };
    };
    const governance = snapshot.governance;
    const lastId = governance?.lastProposalId;
    if (!snapshot.launch?.activated || snapshot.launch.governanceBindState !== "bound"
      || !snapshot.launch.detectedMint || !governance?.program || !governance.programCodeSha256
      || !governance.reserveMint || governance.boundCapitalMint !== snapshot.launch.detectedMint
      || governance.program !== process.env.SOLANA_GOVERNANCE_PROGRAM?.trim()
      || governance.programCodeSha256 !== process.env.SOLANA_GOVERNANCE_PROGRAM_CODE_SHA256?.trim()
      || !governance.updatedAt || Date.now() - governance.updatedAt > 90_000
      || governance.updatedAt > Date.now() + 30_000
      || !lastId || !/^(0|[1-9]\d{0,19})$/.test(lastId)
      || BigInt(lastId) >= (1n << 64n) - 1n) {
      throw new Error("GOVERNANCE_SNAPSHOT_QUOTE_UNAVAILABLE");
    }
    snapshotPublication = {
      governanceProgram: governance.program, programCodeSha256: governance.programCodeSha256,
      capitalMint: snapshot.launch.detectedMint, reserveMint: governance.reserveMint,
      proposalId: (BigInt(lastId) + 1n).toString(), verifiedAt: governance.updatedAt,
    };
  } else if (action === "execute_lock_mstrx") {
    if (!SOLANA_GOVERNANCE_EXECUTION_RELEASED) throw new Error("GOVERNANCE_LOCK_NOT_RELEASED");
    if (amountRaw !== undefined) throw new Error("CONTROL_ACTION_PAYLOAD_INVALID");
    const snapshot = JSON.parse(await readFile(resolve(controlDataRoot, "solana-status-visible", "solana-status.json"), "utf8")) as {
      launch?: { activated?: boolean; governanceBindState?: string; detectedMint?: string };
      governance?: { program?: string; programCodeSha256?: string; reserveMint?: string;
        boundCapitalMint?: string | null; activeProposalId?: string; committedRaw?: string; updatedAt?: number };
      governanceProposal?: { id?: string; status?: number; winningAction?: string; frozenRaw?: string;
        executableAt?: number; updatedAt?: number };
      governanceLockExecution?: { state?: string };
    };
    const governance = snapshot.governance;
    const proposal = snapshot.governanceProposal;
    if (!snapshot.launch?.activated || snapshot.launch.governanceBindState !== "bound"
      || !snapshot.launch.detectedMint || !governance?.program || !governance.programCodeSha256
      || !governance.reserveMint || governance.boundCapitalMint !== snapshot.launch.detectedMint
      || governance.program !== process.env.SOLANA_GOVERNANCE_PROGRAM?.trim()
      || governance.programCodeSha256 !== process.env.SOLANA_GOVERNANCE_PROGRAM_CODE_SHA256?.trim()
      || !proposal || proposal.status !== 1 || proposal.winningAction !== "LOCK_MSTRX"
      || proposal.id !== governance.activeProposalId || proposal.frozenRaw !== governance.committedRaw
      || !Number.isSafeInteger(proposal.executableAt) || Math.floor(Date.now() / 1_000) < proposal.executableAt!
      || !governance.updatedAt || !proposal.updatedAt
      || Date.now() - Math.min(governance.updatedAt, proposal.updatedAt) > 90_000
      || Math.max(governance.updatedAt, proposal.updatedAt) > Date.now() + 30_000
      || ["prepared", "pending", "unresolved"].includes(snapshot.governanceLockExecution?.state ?? "")) {
      throw new Error("GOVERNANCE_LOCK_QUOTE_UNAVAILABLE");
    }
    const rpcPrimary = process.env.SOLANA_RPC_PRIMARY_URL?.trim();
    const rpcFallback = process.env.SOLANA_RPC_FALLBACK_URL?.trim();
    if (!rpcPrimary || !rpcFallback) throw new Error("GOVERNANCE_LOCK_QUOTE_UNAVAILABLE");
    const derived = deriveGovernanceReserveRoute(governance.program, governance.reserveMint);
    if (derived.authority.toBase58() !== process.env.SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY?.trim()) {
      throw new Error("GOVERNANCE_LOCK_QUOTE_UNAVAILABLE");
    }
    const audited = await guardedLockAudit({
      rpcUrls: [rpcPrimary, rpcFallback], governanceProgram: governance.program,
      expectedProgramCodeSha256: governance.programCodeSha256,
      reserveAuthority: derived.authority.toBase58(), reserveMint: governance.reserveMint,
      capitalMint: snapshot.launch.detectedMint, admin: solanaAdminOwner,
    }, proposal.id!);
    if (audited.intent.proposalStateSha256 !== (snapshot.governanceProposal as { proposalStateSha256?: string }).proposalStateSha256
      || audited.intent.frozenReserveRawMstrx !== proposal.frozenRaw) {
      throw new Error("GOVERNANCE_LOCK_QUOTE_CHANGED");
    }
    lockExecution = audited.intent;
  } else if (action === "execute_buyback" || action === "execute_marketing_sale") {
    if (!SOLANA_GOVERNANCE_EXECUTION_RELEASED) throw new Error("GOVERNANCE_EXECUTION_NOT_RELEASED");
    if (amountRaw !== undefined) throw new Error("CONTROL_ACTION_PAYLOAD_INVALID");
    const snapshot = JSON.parse(await readFile(resolve(controlDataRoot, "solana-status-visible", "solana-status.json"), "utf8")) as {
      launch?: { activated?: boolean; governanceBindState?: string; detectedMint?: string };
      governance?: { program?: string; programCodeSha256?: string; reserveMint?: string;
        boundCapitalMint?: string | null; activeProposalId?: string; committedRaw?: string; updatedAt?: number };
      governanceProposal?: { id?: string; status?: number; winningAction?: string; frozenRaw?: string;
        executableAt?: number; proposalStateSha256?: string; updatedAt?: number;
        options?: Array<{ action?: string; minOutputRaw?: string; recipient?: string }> };
      governanceBuybackExecution?: { state?: string };
      governanceMarketingExecution?: { state?: string };
    };
    const governance = snapshot.governance;
    const proposal = snapshot.governanceProposal;
    const winner = proposal?.options?.find((option) => option.action === proposal.winningAction);
    if (!snapshot.launch?.activated || snapshot.launch.governanceBindState !== "bound"
      || !snapshot.launch.detectedMint || !governance?.program || !governance.programCodeSha256
      || !governance.reserveMint || governance.boundCapitalMint !== snapshot.launch.detectedMint
      || governance.program !== process.env.SOLANA_GOVERNANCE_PROGRAM?.trim()
      || governance.programCodeSha256 !== process.env.SOLANA_GOVERNANCE_PROGRAM_CODE_SHA256?.trim()
      || !proposal || proposal.status !== 1 || !proposal.proposalStateSha256
      || proposal.id !== governance.activeProposalId || proposal.frozenRaw !== governance.committedRaw
      || !winner || !/^[1-9]\d*$/.test(winner.minOutputRaw ?? "")
      || (action === "execute_buyback"
        ? !["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK"].includes(proposal.winningAction ?? "")
          || ["prepared", "pending", "unresolved"].includes(snapshot.governanceBuybackExecution?.state ?? "")
        : proposal.winningAction !== "MARKETING_SALE"
          || ["prepared", "pending", "unresolved"].includes(snapshot.governanceMarketingExecution?.state ?? ""))
      || !Number.isSafeInteger(proposal.executableAt) || Math.floor(Date.now() / 1_000) < proposal.executableAt!
      || !governance.updatedAt || !proposal.updatedAt
      || Date.now() - Math.min(governance.updatedAt, proposal.updatedAt) > 90_000
      || Math.max(governance.updatedAt, proposal.updatedAt) > Date.now() + 30_000) {
      throw new Error("GOVERNANCE_EXECUTION_QUOTE_UNAVAILABLE");
    }
    const rpcPrimary = process.env.SOLANA_RPC_PRIMARY_URL?.trim();
    const rpcFallback = process.env.SOLANA_RPC_FALLBACK_URL?.trim();
    if (!rpcPrimary || !rpcFallback) throw new Error("GOVERNANCE_EXECUTION_QUOTE_UNAVAILABLE");
    const derived = deriveGovernanceReserveRoute(governance.program, governance.reserveMint);
    if (derived.authority.toBase58() !== process.env.SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY?.trim()) {
      throw new Error("GOVERNANCE_EXECUTION_QUOTE_UNAVAILABLE");
    }
    const environment = {
      rpcUrls: [rpcPrimary, rpcFallback] as [string, string], governanceProgram: governance.program,
      expectedProgramCodeSha256: governance.programCodeSha256,
      reserveAuthority: derived.authority.toBase58(), reserveMint: governance.reserveMint,
      capitalMint: snapshot.launch.detectedMint, admin: solanaAdminOwner,
    };
    if (action === "execute_buyback") {
      const audited = await guardedSpendingAudit(() => auditBuybackExecution(environment, proposal.id!));
      if (audited.intent.action !== proposal.winningAction
        || audited.intent.proposalStateSha256 !== proposal.proposalStateSha256
        || audited.intent.frozenReserveRawMstrx !== proposal.frozenRaw
        || audited.intent.votedMinOutputRawCapital !== winner.minOutputRaw) {
        throw new Error("GOVERNANCE_EXECUTION_QUOTE_CHANGED");
      }
      buybackExecution = audited.intent;
    } else {
      const audited = await guardedSpendingAudit(() => auditMarketingExecution(environment, proposal.id!));
      if (audited.intent.proposalStateSha256 !== proposal.proposalStateSha256
        || audited.intent.frozenReserveRawMstrx !== proposal.frozenRaw
        || audited.intent.votedMinSolLamports !== winner.minOutputRaw
        || audited.intent.recipient !== winner.recipient) {
        throw new Error("GOVERNANCE_EXECUTION_QUOTE_CHANGED");
      }
      marketingExecution = audited.intent;
    }
  } else if (action === "release_lock_mstrx") {
    if (!SOLANA_GOVERNANCE_EXECUTION_RELEASED) throw new Error("GOVERNANCE_EXECUTION_NOT_RELEASED");
    if (amountRaw !== undefined || typeof releaseProposalId !== "string"
      || !/^[1-9]\d{0,19}$/.test(releaseProposalId)) {
      throw new Error("GOVERNANCE_LOCK_RELEASE_ID_INVALID");
    }
    const snapshot = JSON.parse(await readFile(resolve(controlDataRoot, "solana-status-visible", "solana-status.json"), "utf8")) as {
      launch?: { activated?: boolean; governanceBindState?: string; detectedMint?: string };
      governance?: { program?: string; programCodeSha256?: string; reserveMint?: string;
        boundCapitalMint?: string | null; lastProposalId?: string; updatedAt?: number };
      governanceLockRelease?: { state?: string };
    };
    const governance = snapshot.governance;
    if (!snapshot.launch?.activated || snapshot.launch.governanceBindState !== "bound"
      || !snapshot.launch.detectedMint || !governance?.program || !governance.programCodeSha256
      || !governance.reserveMint || governance.boundCapitalMint !== snapshot.launch.detectedMint
      || governance.program !== process.env.SOLANA_GOVERNANCE_PROGRAM?.trim()
      || governance.programCodeSha256 !== process.env.SOLANA_GOVERNANCE_PROGRAM_CODE_SHA256?.trim()
      || !/^(0|[1-9]\d{0,19})$/.test(governance.lastProposalId ?? "")
      || BigInt(releaseProposalId) > BigInt(governance.lastProposalId ?? "0")
      || !governance.updatedAt || Date.now() - governance.updatedAt > 90_000
      || governance.updatedAt > Date.now() + 30_000
      || ["prepared", "pending", "unresolved"].includes(snapshot.governanceLockRelease?.state ?? "")) {
      throw new Error("GOVERNANCE_LOCK_RELEASE_QUOTE_UNAVAILABLE");
    }
    const rpcPrimary = process.env.SOLANA_RPC_PRIMARY_URL?.trim();
    const rpcFallback = process.env.SOLANA_RPC_FALLBACK_URL?.trim();
    if (!rpcPrimary || !rpcFallback) throw new Error("GOVERNANCE_LOCK_RELEASE_QUOTE_UNAVAILABLE");
    const derived = deriveGovernanceReserveRoute(governance.program, governance.reserveMint);
    if (derived.authority.toBase58() !== process.env.SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY?.trim()) {
      throw new Error("GOVERNANCE_LOCK_RELEASE_QUOTE_UNAVAILABLE");
    }
    const audited = await guardedSpendingAudit(() => auditLockRelease({
      rpcUrls: [rpcPrimary, rpcFallback], governanceProgram: governance.program!,
      expectedProgramCodeSha256: governance.programCodeSha256!,
      reserveAuthority: derived.authority.toBase58(), reserveMint: governance.reserveMint!,
      capitalMint: snapshot.launch!.detectedMint!, admin: solanaAdminOwner,
    }, releaseProposalId));
    lockRelease = audited.intent;
  } else if (action === "start_offchain_ballot") {
    if (amountRaw !== undefined || !Number.isSafeInteger(durationHours)) throw new Error("OFFCHAIN_BALLOT_INTENT_INVALID");
    const snapshot = JSON.parse(await readFile(resolve(controlDataRoot, "solana-status-visible", "solana-status.json"), "utf8")) as {
      launch?: { activated?: boolean; detectedMint?: string }; reserveWallet?: string;
      balances?: { reserveMstrxRaw?: string }; updatedAt?: number;
    };
    if (!snapshot.launch?.activated || !snapshot.launch.detectedMint || !snapshot.reserveWallet
      || !snapshot.balances?.reserveMstrxRaw || !snapshot.updatedAt) throw new Error("OFFCHAIN_BALLOT_STATUS_UNAVAILABLE");
    offchainBallot = validateOffchainBallotIntent({
      id: String(Date.now()), capitalMint: snapshot.launch.detectedMint,
      reserveWallet: snapshot.reserveWallet, reserveRawMstrx: snapshot.balances.reserveMstrxRaw,
      durationHours, options: [...OFFCHAIN_ACTIONS], verifiedAt: snapshot.updatedAt,
    });
  } else if (amountRaw !== undefined || proposalRequest !== undefined || previewHash !== undefined
    || previewAuditedAtUnix !== undefined) throw new Error("CONTROL_ACTION_PAYLOAD_INVALID");
  const id = randomBytes(20).toString("hex");
  const issuedAt = Date.now();
  const expiresAt = issuedAt + SOLANA_CONTROL_CHALLENGE_MS;
  if (withdrawal) validateFreeReserveWithdrawalIntent(withdrawal, issuedAt);
  if (finalization) validateFinalizeVoteIntent(finalization, issuedAt);
  if (proposalCreation) validateProposalControlIntent(proposalCreation, issuedAt);
  if (snapshotPublication) validateSnapshotPublicationIntent(snapshotPublication, issuedAt);
  if (lockExecution) validateLockExecutionIntent(lockExecution, issuedAt);
  if (buybackExecution) validateBuybackExecutionIntent(buybackExecution, issuedAt);
  if (marketingExecution) validateMarketingExecutionIntent(marketingExecution, issuedAt);
  if (lockRelease) validateLockReleaseIntent(lockRelease, issuedAt);
  const message = solanaControlMessage({ network: SOLANA_CONTROL_NETWORK, action, signer: solanaAdminOwner,
    issuedAt, expiresAt, nonce: id, withdrawal, finalization, proposalCreation, snapshotPublication,
    lockExecution, buybackExecution, marketingExecution, lockRelease, offchainBallot });
  if (solanaChallenges.size >= 500) solanaChallenges.delete(solanaChallenges.keys().next().value as string);
  solanaChallenges.set(id, { action, message, issuedAt, expiresAt, nonce: id, withdrawal, finalization,
    proposalCreation, snapshotPublication, lockExecution, buybackExecution, marketingExecution, lockRelease, offchainBallot });
  return { id, action, message, expiresAt, owner: solanaAdminOwner, offchainBallot };
}

async function queueSolanaAdminAction(challengeId: string, signer: string, signature: string) {
  if (!solanaAdminOwner) throw new Error("ADMIN_DISABLED");
  const challenge = solanaChallenges.get(challengeId);
  if (!challenge || challenge.expiresAt < Date.now()) throw new Error("CHALLENGE_INVALID");
  solanaChallenges.delete(challengeId);
  const normalizedSigner = new PublicKey(signer).toBase58();
  const authorization = {
    network: SOLANA_CONTROL_NETWORK,
    action: challenge.action,
    signer: normalizedSigner,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    nonce: challenge.nonce,
    withdrawal: challenge.withdrawal,
    finalization: challenge.finalization,
    proposalCreation: challenge.proposalCreation,
    snapshotPublication: challenge.snapshotPublication,
    lockExecution: challenge.lockExecution,
    buybackExecution: challenge.buybackExecution,
    marketingExecution: challenge.marketingExecution,
    lockRelease: challenge.lockRelease,
    offchainBallot: challenge.offchainBallot,
    signature,
  };
  verifySignedSolanaControlAction(authorization, solanaAdminOwner);

  const queueDir = resolve(controlDataRoot, "solana-requests");
  await mkdir(queueDir, { recursive: true });
  const requestId = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  await writeFile(resolve(queueDir, `${requestId}.json`), JSON.stringify({
    id: requestId,
    ...authorization,
    requestedAt: Date.now(),
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { ok: true, requestId, action: challenge.action };
}

async function loadOffchainBallot(proposalId?: string) {
  let ballot: OffchainBallot;
  if (proposalId && !/^[1-9]\d{0,19}$/.test(proposalId)) throw new Error("OFFCHAIN_BALLOT_ID_INVALID");
  try {
    ballot = validateOffchainBallot(JSON.parse(await readFile(resolve(publicDataRoot,
      "governance", "offchain", proposalId ? `${proposalId}.json` : "active.json"), "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const raw = await readFile(resolve(publicDataRoot, "governance", "proposals", ballot.id, "snapshot.json"), "utf8");
  return { ballot, snapshot: verifiedOffchainSnapshot(ballot, raw) };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      return jsonResponse(response, 200, { ok: true, timestamp: Date.now() });
    }

    if (url.pathname === "/api/solana/rpc") {
      return handlePublicSolanaRpc(request, response);
    }
    if (url.pathname === "/api/solana/governance-vote") {
      return handleGovernanceVoteRpc(request, response);
    }
    if (url.pathname === "/api/solana/offchain-governance" && request.method === "GET") {
      try {
        const requested = url.searchParams.get("proposal") ?? undefined;
        const active = await loadOffchainBallot(requested);
        if (!active) return jsonResponse(response, 200, { ballot: null });
        const tally = await offchainTally(controlDataRoot, active.ballot, active.snapshot);
        if (url.searchParams.get("receipts") === "1") {
          const after = url.searchParams.get("after") || "";
          if (after && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(after)) {
            return jsonResponse(response, 400, { error: "invalid_cursor" });
          }
          const remaining = tally.receipts.filter((receipt) => receipt.wallet > after);
          const page = remaining.slice(0, 100);
          return jsonResponse(response, 200, { proposalId: active.ballot.id, receipts: page,
            nextCursor: remaining.length > page.length ? page.at(-1)?.wallet : null });
        }
        const wallet = url.searchParams.get("wallet");
        let eligibility: { weight: string; receipt?: typeof tally.receipts[number] } | null = null;
        if (wallet !== null) {
          if (new PublicKey(wallet).toBase58() !== wallet) return jsonResponse(response, 400, { error: "invalid_wallet" });
          try {
            eligibility = { weight: voteWeight(active.snapshot, wallet),
              receipt: tally.receipts.find((item) => item.wallet === wallet) };
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "OFFCHAIN_WALLET_INELIGIBLE") throw error;
          }
        }
        return jsonResponse(response, 200, { ballot: active.ballot, totals: tally.totals,
          count: tally.count, eligibility });
      } catch {
        return jsonResponse(response, 503, { error: "governance_unavailable" });
      }
    }
    if (url.pathname === "/api/solana/offchain-governance/vote" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (Object.keys(body).some((key) => !["proposalId", "wallet", "option", "signature"].includes(key))
          || typeof body.proposalId !== "string" || typeof body.wallet !== "string"
          || typeof body.option !== "string" || typeof body.signature !== "string"
          || body.signature.length > 128) return jsonResponse(response, 400, { error: "invalid_vote" });
        const active = await loadOffchainBallot();
        if (!active || active.ballot.id !== body.proposalId) return jsonResponse(response, 409, { error: "proposal_not_active" });
        const receipt = await recordOffchainVote({ controlDataRoot, ballot: active.ballot,
          snapshot: active.snapshot, vote: body as unknown as SignedOffchainVote });
        return jsonResponse(response, 200, { receipt });
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const known = ["OFFCHAIN_VOTE_CLOSED", "OFFCHAIN_VOTE_INVALID", "OFFCHAIN_SIGNATURE_INVALID",
          "OFFCHAIN_WALLET_INELIGIBLE", "OFFCHAIN_ALREADY_VOTED"];
        return jsonResponse(response, known.includes(code) ? 400 : 503,
          { error: known.includes(code) ? code.toLowerCase() : "governance_unavailable" });
      }
    }

    if (blockLegacyAdminPath(url.pathname, isSolanaAdminMode)) {
      throw new Error("NOT_FOUND");
    }

    if (solanaAdminApiRoot && url.pathname === `${solanaAdminApiRoot}/status` && request.method === "GET") {
      try {
        const body = JSON.parse(await readFile(resolve(controlDataRoot, "solana-status-visible", "solana-status.json"), "utf8"));
        return jsonResponse(response, 200, { ...body, network: "solana-mainnet-beta", owner: solanaAdminOwner,
          launch: { ...body.launch, executionReleased: body.launch?.executionReleased === true },
          finalizeVoteReleased: SOLANA_GOVERNANCE_FINALIZE_RELEASED && body.governanceFinalizeReleased === true,
          proposalControlReleased: SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED && body.governanceProposalControlReleased === true });
      } catch {
        return jsonResponse(response, 200, {
          network: "solana-mainnet-beta",
          owner: solanaAdminOwner,
          automationState: "stopped",
          launch: { configured: false, armed: false, activated: false },
          services: {},
          balances: {},
          finalizeVoteReleased: false,
          proposalControlReleased: false,
          updatedAt: 0,
        });
      }
    }

    if (solanaAdminApiRoot && url.pathname === `${solanaAdminApiRoot}/governance-proposal-preview` && request.method === "POST") {
      try {
        // readJsonBody caps the request at 16 KiB; reject arbitrary fields
        // before expensive finalized RPC reads or publication verification.
        const { preview: result } = await verifiedSolanaProposalPreview(await readJsonBody(request));
        return jsonResponse(response, 200, result);
      } catch (error) {
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)
          ? error.message : "GOVERNANCE_PREVIEW_UNAVAILABLE";
        return jsonResponse(response, code === "GOVERNANCE_PREVIEW_RATE_LIMITED" ? 429 : 400, { error: code });
      }
    }

    if (solanaAdminApiRoot && request.method === "GET" && url.pathname.startsWith(`${solanaAdminApiRoot}/request/`)) {
      const requestId = url.pathname.slice(`${solanaAdminApiRoot}/request/`.length);
      try {
        const state = await readControlRequestOutcome(controlDataRoot, requestId);
        return state ? jsonResponse(response, 200, { requestId, state }) : jsonResponse(response, 404, { error: "request_not_found" });
      } catch (error) {
        if (error instanceof Error && error.message === "REQUEST_ID_INVALID") return jsonResponse(response, 400, { error: "invalid_request_id" });
        throw error;
      }
    }

    if (solanaAdminApiRoot && url.pathname === `${solanaAdminApiRoot}/challenge` && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (typeof body.action !== "string" || Object.keys(body).some((key) =>
          !["action", "amountRaw", "proposalRequest", "previewHash", "previewAuditedAtUnix", "releaseProposalId", "durationHours"].includes(key))) {
          return jsonResponse(response, 400, { error: "invalid_request" });
        }
        const challenge = await solanaAdminChallenge(body.action, body.amountRaw,
          body.proposalRequest, body.previewHash, body.previewAuditedAtUnix, body.releaseProposalId, body.durationHours);
        return challenge
          ? jsonResponse(response, 200, challenge)
          : jsonResponse(response, 400, { error: solanaAdminOwner ? "action_not_allowed" : "admin_disabled" });
      } catch (error) {
        const code = error instanceof Error ? error.message : "invalid_request";
        const publicCode = ["RESERVE_WITHDRAWAL_AMOUNT_INVALID", "RESERVE_WITHDRAWAL_QUOTE_UNAVAILABLE",
          "RESERVE_WITHDRAWAL_IDENTITY_INVALID", "RESERVE_WITHDRAWAL_HASH_INVALID",
          "RESERVE_WITHDRAWAL_QUOTE_STALE", "RESERVE_WITHDRAWAL_ACTION_INVALID",
          "RESERVE_WITHDRAWAL_NOT_RELEASED", "GOVERNANCE_FINALIZE_NOT_RELEASED",
          "GOVERNANCE_FINALIZE_QUOTE_UNAVAILABLE", "GOVERNANCE_FINALIZE_ACTION_INVALID",
          "GOVERNANCE_FINALIZE_IDENTITY_INVALID", "GOVERNANCE_FINALIZE_HASH_INVALID",
          "GOVERNANCE_FINALIZE_AMOUNT_INVALID", "GOVERNANCE_FINALIZE_PDA_MISMATCH",
          "GOVERNANCE_FINALIZE_QUOTE_STALE", "GOVERNANCE_PROPOSAL_NOT_RELEASED",
          "GOVERNANCE_PROPOSAL_PREVIEW_STALE", "GOVERNANCE_PROPOSAL_PREVIEW_CHANGED",
          "GOVERNANCE_PROPOSAL_OPTIONS_INVALID", "GOVERNANCE_PROPOSAL_INTENT_REQUIRED",
          "GOVERNANCE_SNAPSHOT_NOT_RELEASED", "GOVERNANCE_SNAPSHOT_QUOTE_UNAVAILABLE",
          "GOVERNANCE_SNAPSHOT_IDENTITY_INVALID", "GOVERNANCE_SNAPSHOT_INTENT_INVALID",
          "GOVERNANCE_SNAPSHOT_QUOTE_STALE",
          "GOVERNANCE_LOCK_NOT_RELEASED", "GOVERNANCE_LOCK_QUOTE_UNAVAILABLE",
          "GOVERNANCE_LOCK_QUOTE_CHANGED", "GOVERNANCE_LOCK_RATE_LIMITED",
          "GOVERNANCE_EXECUTION_NOT_RELEASED", "GOVERNANCE_EXECUTION_QUOTE_UNAVAILABLE",
          "GOVERNANCE_EXECUTION_QUOTE_CHANGED", "GOVERNANCE_EXECUTION_RATE_LIMITED",
          "GOVERNANCE_LOCK_RELEASE_ID_INVALID", "GOVERNANCE_LOCK_RELEASE_QUOTE_UNAVAILABLE",
          "GOVERNANCE_PREVIEW_RATE_LIMITED", "OFFCHAIN_BALLOT_INTENT_INVALID",
          "OFFCHAIN_BALLOT_STATUS_UNAVAILABLE"].includes(code)
          ? code.toLowerCase() : "invalid_request";
        return jsonResponse(response, ["GOVERNANCE_LOCK_RATE_LIMITED", "GOVERNANCE_EXECUTION_RATE_LIMITED"].includes(code)
          ? 429 : 400, { error: publicCode });
      }
    }

    if (solanaAdminApiRoot && url.pathname === `${solanaAdminApiRoot}/action` && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (typeof body.challengeId !== "string" || typeof body.signer !== "string" || typeof body.signature !== "string"
          || Object.keys(body).some((key) => !["challengeId", "signer", "signature"].includes(key))) {
          return jsonResponse(response, 400, { error: "invalid_request" });
        }
        const queued = await queueSolanaAdminAction(body.challengeId, body.signer, body.signature);
        return jsonResponse(response, 202, queued);
      } catch (error) {
        const code = error instanceof Error ? error.message : "ACTION_FAILED";
        const publicCode = [
          "ADMIN_DISABLED", "CHALLENGE_INVALID", "SIGNATURE_INVALID", "SIGNER_NOT_OWNER",
          "CONTROL_ACTION_INVALID", "CONTROL_CHALLENGE_EXPIRED", "CONTROL_NONCE_INVALID",
        ].includes(code) ? code : "ACTION_FAILED";
        return jsonResponse(response, ["SIGNATURE_INVALID", "SIGNER_NOT_OWNER"].includes(publicCode) ? 403 : 400, { error: publicCode.toLowerCase() });
      }
    }

    if (url.pathname === "/admin/api/status" && request.method === "GET") {
      let activated = false;
      try {
        await stat(resolve(controlDataRoot, "main-launch", "postlaunch.json"));
        activated = true;
      } catch {
        activated = false;
      }
      try {
        const body = JSON.parse(await readFile(resolve(controlDataRoot, "status.json"), "utf8"));
        return jsonResponse(response, 200, { ...body, owner: adminOwner, activated });
      } catch {
        return jsonResponse(response, 200, {
          automationState: "unknown",
          services: {},
          updatedAt: 0,
          owner: adminOwner,
          activated,
        });
      }
    }

    if (url.pathname === "/admin/api/reserve-quote" && request.method === "GET") {
      try {
        const amountRaw = url.searchParams.get("amount");
        if (amountRaw && !/^\d{1,78}$/.test(amountRaw)) {
          return jsonResponse(response, 400, { ok: false, reason: "quote_amount_invalid" });
        }
        const quote = await verifiedReserveQuote(amountRaw ? BigInt(amountRaw) : undefined);
        return jsonResponse(response, quote.ok ? 200 : 503, quote);
      } catch {
        return jsonResponse(response, 503, { ok: false, reason: "quote_verification_failed" });
      }
    }

    if (url.pathname === "/admin/api/launch-state" && request.method === "GET") {
      const launchRoot = resolve(controlDataRoot, "main-launch");
      const readOptional = async (name: string) => {
        try { return JSON.parse(await readFile(resolve(launchRoot, name), "utf8")); } catch { return undefined; }
      };
      const [prelaunch, armed, detected, postlaunch] = await Promise.all([
        readOptional("prelaunch.json"), readOptional("armed.json"),
        readOptional("detected.json"), readOptional("postlaunch.json"),
      ]);
      return jsonResponse(response, 200, {
        prelaunchRegistered: Boolean(prelaunch),
        creatorWallet: prelaunch?.ponsFeeCollector,
        armed: Boolean(armed) && !detected,
        detected,
        activated: Boolean(postlaunch),
      });
    }

    if (url.pathname === "/admin/api/governance-prepared" && request.method === "GET") {
      try {
        const body = JSON.parse(await readFile(resolve(controlDataRoot, "governance-prepared.json"), "utf8"));
        return jsonResponse(response, 200, body);
      } catch {
        return jsonResponse(response, 200, { status: "none" });
      }
    }

    if (url.pathname === "/admin/api/challenge" && request.method === "GET") {
      const challenge = adminChallenge(url.searchParams.get("action") || "");
      return challenge
        ? jsonResponse(response, 200, challenge)
        : jsonResponse(response, 400, { error: "action_not_allowed" });
    }


    if (url.pathname === "/admin/api/challenge" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (typeof body.action !== "string") return jsonResponse(response, 400, { error: "invalid_request" });
        const challenge = adminChallenge(body.action, body.payload);
        return challenge
          ? jsonResponse(response, 200, challenge)
          : jsonResponse(response, 400, { error: "action_not_allowed" });
      } catch {
        return jsonResponse(response, 400, { error: "invalid_request" });
      }
    }

    if (url.pathname === "/admin/api/action" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (typeof body.challengeId !== "string" || typeof body.signature !== "string") {
          return jsonResponse(response, 400, { error: "invalid_request" });
        }
        const queued = await queueAdminAction(body.challengeId, body.signature as Hex);
        return jsonResponse(response, 202, queued);
      } catch (error) {
        const code = error instanceof Error ? error.message : "action_failed";
        return jsonResponse(response, code === "SIGNATURE_INVALID" ? 403 : 400, { error: code.toLowerCase() });
      }
    }

    // Unknown legacy API paths must not fall through to the single-page app.
    if (url.pathname === "/admin/api" || url.pathname.startsWith("/admin/api/")) {
      throw new Error("NOT_FOUND");
    }

    if (adminPanelPath && url.pathname.replace(/\/$/, "") === adminPanelPath && request.method === "GET") {
      const template = await readFile(resolve(staticRoot, "index.html"), "utf8");
      const apiRoot = JSON.stringify(`${adminPanelPath}/api`);
      const body = template.replace("</head>", `<script>window.__FLYWHEEL_ADMIN__=true;window.__FLYWHEEL_ADMIN_API__=${apiRoot}</script></head>`);
      response.writeHead(200, {
        "content-type": mimeTypes[".html"],
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      return response.end(body);
    }

    const dynamic = url.pathname === "/config.json" || url.pathname.startsWith("/snapshots/")
      || (url.pathname.startsWith("/governance/") && url.pathname.endsWith(".json"))
      || url.pathname.startsWith("/status/");
    const root = dynamic ? publicDataRoot : staticRoot;
    const relative = dynamic ? url.pathname : (url.pathname === "/" ? "/index.html" : url.pathname);
    let path = safePath(root, relative);
    if (!path) throw new Error("UNSAFE_PATH");
    try {
      const body = await fileResponse(path);
      response.writeHead(200, {
        "content-type": mimeTypes[extname(path)] || "application/octet-stream",
        "cache-control": dynamic ? "no-store" : "public, max-age=300",
        "x-content-type-options": "nosniff",
      });
      return response.end(body);
    } catch {
      if (dynamic || extname(url.pathname)) throw new Error("NOT_FOUND");
      path = resolve(staticRoot, "index.html");
      const body = await fileResponse(path);
      response.writeHead(200, { "content-type": mimeTypes[".html"], "cache-control": "no-cache" });
      return response.end(body);
    }
  } catch {
    response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: "not_found" }));
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Web and public data server listening on :${port}`));
