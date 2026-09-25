import { createHash } from "node:crypto";
import { Connection, PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { governanceAddresses, governanceExecutionReceiptAddresses, governanceLockAddresses,
  inspectGovernanceExecutionReceipt, inspectGovernanceLock,
  parseGovernanceConfig, parseGovernanceProposal } from "../../apps/web/src/governanceClient";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";

const LOCK_DAYS = [30, 90, 180, 365, 730, 1095, 1825];
const ALLOWED_LOCK_SECONDS = new Set([...LOCK_DAYS.map((days) => days * 86_400), 0xffffffff]);
const ACTIVE_STATUSES = new Set([0, 1, 6, 7, 8]);
const CLOSED_STATUSES = new Set([2, 3, 4]);
const CONFIG_V3_LENGTH = 306;
const PROPOSAL_V3_LENGTH = 726;

export interface GovernanceProposalStatusRoute {
  program: string;
  admin: string;
  capitalMint: string;
  reserveMint: string;
  reserveVault: string;
  activeProposalId: bigint;
  committedRaw: bigint;
}

export interface GovernanceProposalStatus {
  id: string;
  status: number;
  /** Exact finalized Proposal account bytes, agreed by both providers. */
  proposalStateSha256: string;
  frozenRaw: string;
  fixedMarketingWallet: string;
  options: Array<{
    action: string;
    reserveRaw: string;
    minOutputRaw: string;
    recipient: string;
    lockDurationSeconds: number;
  }>;
  startsAt: number;
  endsAt: number;
  executableAt: number;
  winningAction?: string;
  // No execution transaction signature is stored in Proposal v3. Never infer
  // one from the status or from an unrelated wallet transaction.
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
  updatedAt: number;
}

function requiredAccount(account: AccountInfo<Buffer> | null, owner: PublicKey) {
  if (!account || !account.owner.equals(owner) || account.executable) throw new Error("GOVERNANCE_STATUS_ACCOUNT_INVALID");
  return account;
}

function expectedConfig(config: Awaited<ReturnType<typeof parseGovernanceConfig>>, route: GovernanceProposalStatusRoute) {
  if (config.admin !== route.admin || config.capitalMint !== route.capitalMint
    || config.reserveMint !== route.reserveMint || config.reserveVault !== route.reserveVault
    || config.activeProposalId !== route.activeProposalId || config.committedReserveRawMstrx !== route.committedRaw
    || config.lastProposalId < config.activeProposalId
    || (config.activeProposalId === 0n && config.committedReserveRawMstrx !== 0n)) {
    throw new Error("GOVERNANCE_STATUS_CONFIG_MISMATCH");
  }
  return config;
}

function assertProposal(
  proposal: Awaited<ReturnType<typeof parseGovernanceProposal>>,
  config: Awaited<ReturnType<typeof parseGovernanceConfig>>,
  configAddress: PublicKey,
  proposalBump: number,
  id: bigint,
) {
  const active = config.activeProposalId !== 0n;
  if (proposal.id !== id || proposal.config !== configAddress.toBase58()
    || proposal.capitalMint !== config.capitalMint || proposal.reserveVault !== config.reserveVault
    || proposal.bump !== proposalBump || proposal.frozenReserveRawMstrx <= 0n
    || proposal.startsAt < config.launchedAt || proposal.endsAt <= proposal.startsAt
    || proposal.executableAt !== proposal.endsAt + 300
    || proposal.windowEnd > proposal.startsAt
    || proposal.windowStart !== Math.max(config.launchedAt, proposal.windowEnd - 86_400)
    || proposal.finalizedThroughSlot <= 0n || proposal.leafCount <= 0n
    || proposal.totalAvailableWeight <= 0n
    || (active && (id !== config.activeProposalId || !ACTIVE_STATUSES.has(proposal.status)
      || proposal.frozenReserveRawMstrx !== config.committedReserveRawMstrx))
    || (!active && !CLOSED_STATUSES.has(proposal.status))) {
    throw new Error("GOVERNANCE_STATUS_PROPOSAL_MISMATCH");
  }
  const emptyRecipient = SystemProgram.programId.toBase58();
  const actions = new Set(proposal.options.map((option) => option.action));
  if (actions.size !== proposal.options.length || !actions.has("ACCUMULATE")) {
    throw new Error("GOVERNANCE_STATUS_OPTION_MISMATCH");
  }
  for (const option of proposal.options) {
    if (option.reserveRawMstrx !== (option.action === "ACCUMULATE" ? 0n : proposal.frozenReserveRawMstrx)
      || (option.action === "MARKETING_SALE" ? option.recipient !== config.marketingWallet : option.recipient !== emptyRecipient)
      || (["BUYBACK_LOCK", "LOCK_MSTRX"].includes(option.action)
        ? !ALLOWED_LOCK_SECONDS.has(option.lockDurationSeconds) : option.lockDurationSeconds !== 0)) {
      throw new Error("GOVERNANCE_STATUS_OPTION_MISMATCH");
    }
  }
}

/** Read-only, strict two-provider status for the private panel. Missing or
 * divergent finalized state throws so callers clear the previous summary. */
export async function verifyGovernanceProposalStatus(
  rpcUrls: readonly [string, string], route: GovernanceProposalStatusRoute,
): Promise<GovernanceProposalStatus | undefined> {
  const program = new PublicKey(route.program);
  const [configAddress] = PublicKey.findProgramAddressSync([Buffer.from("config")], program);
  const agreed = await finalizedConsensus(rpcUrls);
  const connections = rpcUrls.map((url) => new Connection(url, "finalized"));
  const initial = await Promise.all(connections.map(async (connection) => {
    const read = await connection.getMultipleAccountsInfoAndContext([configAddress], {
      commitment: "finalized", minContextSlot: agreed.slot,
    });
    if (read.context.slot < agreed.slot) throw new Error("GOVERNANCE_STATUS_RPC_STALE");
    const account = requiredAccount(read.value[0], program);
    if (account.data.length !== CONFIG_V3_LENGTH) throw new Error("GOVERNANCE_STATUS_CONFIG_LAYOUT_INVALID");
    const config = expectedConfig(await parseGovernanceConfig(account), route);
    return { config, bytes: account.data.toString("hex") };
  }));
  requireMatchingValues(initial, "GOVERNANCE_STATUS_RPC_DISAGREEMENT");
  const id = initial[0].config.activeProposalId || initial[0].config.lastProposalId;
  if (id === 0n) return undefined;
  const { proposal: proposalAddress } = governanceAddresses(program, id);
  const receiptAddresses = governanceExecutionReceiptAddresses(program, proposalAddress);
  const lockAddresses = governanceLockAddresses(program, proposalAddress, new PublicKey(route.reserveMint));
  const idSeed = Buffer.alloc(8);
  idSeed.writeBigUInt64LE(id);
  const [, proposalBump] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), idSeed], program);

  const snapshots = await Promise.all(connections.map(async (connection) => {
    const read = await connection.getMultipleAccountsInfoAndContext([
      configAddress, proposalAddress, receiptAddresses.buyback, receiptAddresses.marketing,
      lockAddresses.record, lockAddresses.escrow,
    ], {
      commitment: "finalized", minContextSlot: agreed.slot,
    });
    if (read.context.slot < agreed.slot) throw new Error("GOVERNANCE_STATUS_RPC_STALE");
    const configAccount = requiredAccount(read.value[0], program);
    const proposalAccount = requiredAccount(read.value[1], program);
    if (configAccount.data.length !== CONFIG_V3_LENGTH || proposalAccount.data.length !== PROPOSAL_V3_LENGTH) {
      throw new Error("GOVERNANCE_STATUS_ACCOUNT_LAYOUT_INVALID");
    }
    const config = expectedConfig(await parseGovernanceConfig(configAccount), route);
    if (configAccount.data.toString("hex") !== initial[0].bytes) throw new Error("GOVERNANCE_STATUS_CHANGED_DURING_READ");
    const proposal = await parseGovernanceProposal(proposalAddress.toBase58(), proposalAccount);
    assertProposal(proposal, config, configAddress, proposalBump, id);
    const chainTime = proposal.status === 4 ? await connection.getBlockTime(read.context.slot) : 0;
    if (chainTime === null || !Number.isSafeInteger(chainTime)) throw new Error("GOVERNANCE_STATUS_CHAIN_TIME_UNKNOWN");
    const receipt = await inspectGovernanceExecutionReceipt(program, configAddress, config, proposalAddress, proposal,
      read.value[2], read.value[3], chainTime);
    const needsLock = proposal.status === 4 && proposal.options[proposal.winningOption]?.action === "LOCK_MSTRX";
    if (needsLock ? (read.value[4] === null || read.value[5] === null) : read.value[4] !== null) {
      throw new Error("GOVERNANCE_STATUS_LOCK_STATE_MISMATCH");
    }
    // Anyone can pre-create and fund the canonical lock ATA before execution.
    // The onchain route handles its baseline; its mere presence is not proof of
    // execution and must not hide a valid PASSED decision from the panel.
    if (!needsLock && read.value[5] !== null) {
      const donated = unpackAccount(lockAddresses.escrow,
        requiredAccount(read.value[5], TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
      if (!donated.isInitialized || donated.isFrozen
        || !donated.mint.equals(new PublicKey(route.reserveMint))
        || !donated.owner.equals(lockAddresses.record)
        || donated.delegate !== null || donated.closeAuthority !== null) {
        throw new Error("GOVERNANCE_STATUS_PRECREATED_LOCK_ATA_INVALID");
      }
    }
    const lock = needsLock ? await inspectGovernanceLock(program, configAddress, config, proposalAddress,
      proposal, new PublicKey(route.reserveMint), read.value[4], read.value[5], chainTime) : undefined;
    return { proposal, receipt: receipt ? {
      address: receipt.address.toBase58(), kind: receipt.kind, action: receipt.action,
      inputRawMstrx: receipt.inputRawMstrx.toString(), votedMinOutputRaw: receipt.votedMinOutputRaw.toString(),
      actualOutputRaw: receipt.actualOutputRaw.toString(), executedAt: receipt.executedAt,
      destination: receipt.destination, venue: receipt.venue,
    } : undefined, lock: lock ? {
      address: lock.address.toBase58(), escrowAddress: lock.escrowAddress.toBase58(),
      amountRawMstrx: lock.record.amount.toString(), lockedAt: lock.record.lockedAt,
      releaseAt: lock.record.releaseAt, state: lock.state,
    } : undefined,
    buybackBytes: read.value[2]?.data.toString("hex") ?? null,
    marketingBytes: read.value[3]?.data.toString("hex") ?? null,
    lockRecordBytes: read.value[4]?.data.toString("hex") ?? null,
    lockEscrowBytes: read.value[5]?.data.toString("hex") ?? null,
    configBytes: configAccount.data.toString("hex"), proposalBytes: proposalAccount.data.toString("hex") };
  }));
  requireMatchingValues(snapshots, "GOVERNANCE_STATUS_RPC_DISAGREEMENT");
  const proposal = snapshots[0].proposal;
  const winningAction = proposal.winningOption < proposal.options.length
    ? proposal.options[proposal.winningOption].action : undefined;
  return {
    id: id.toString(), status: proposal.status, frozenRaw: proposal.frozenReserveRawMstrx.toString(),
    proposalStateSha256: createHash("sha256").update(Buffer.from(snapshots[0].proposalBytes, "hex")).digest("hex"),
    fixedMarketingWallet: initial[0].config.marketingWallet,
    options: proposal.options.map((option) => ({
      action: option.action,
      reserveRaw: option.reserveRawMstrx.toString(),
      minOutputRaw: option.minOutputRaw.toString(),
      recipient: option.recipient,
      lockDurationSeconds: option.lockDurationSeconds,
    })),
    startsAt: proposal.startsAt, endsAt: proposal.endsAt, executableAt: proposal.executableAt,
    ...(winningAction ? { winningAction } : {}),
    ...(snapshots[0].receipt ? { executionReceipt: snapshots[0].receipt } : {}), updatedAt: Date.now(),
    ...(snapshots[0].lock ? { executionLock: snapshots[0].lock } : {}),
  };
}
