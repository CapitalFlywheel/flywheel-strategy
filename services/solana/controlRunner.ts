import "dotenv/config";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { bondingCurvePda, bondingCurveV2Pda, canonicalPumpPoolPda, canonicalPumpPoolPdaWithQuote, pumpPoolAuthorityPda } from "@pump-fun/pump-sdk";
import { ExtensionType, getAccount, getExtensionTypes, getMint, getScaledUiAmountConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assertFixedMstrxPumpLaunch, verifyFixedMstrxPumpLaunch } from "./launchVerifier";
import { armDurableCreatorPumpLaunchScan, detectDurableAgreedCreatorPumpLaunch, resumeDurableCreatorPumpLaunchScan, type PumpCreateCandidate } from "./launchDetector";
import { createMstrxAtaInstruction, mstrxAta } from "./mstrxTransfers";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";
import { distributeRewardEpoch, finalizeRewardEpoch, loadCurrentRewardPlan, prepareRewardEpoch, retryOwedRewardPayments, type RewardPipelineEnvironment } from "./rewardPipeline";
import { loadKeypair, simulateAndSend } from "./transactions";
import { reconcilePendingFeeReceipt, recoverUncommittedCreatorFees, sweepCreatorFees, type FeeSettlementEnvironment } from "./feeSettlement";
import { writeDurableJson } from "./durableJson";
import { assertSolanaWalletRoles, sharedAdminCreatorEnabled } from "./walletRoles";
import { readCustomQuoteCreatorFeeBalances } from "./pumpFees";
import { SOLANA_GOVERNANCE_FINALIZE_RELEASED, SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED,
  SOLANA_GOVERNANCE_RESERVE_WITHDRAWAL_RELEASED,
  verifySignedSolanaControlAction, type SignedSolanaControlAction } from "./controlAuth";
import { writeControlRequestOutcome } from "./controlRequestStatus";
import { verifyGovernanceProposalStatus, type GovernanceProposalStatus } from "./governanceProposalStatus";
import { reconcileFreeWithdrawal, withdrawFreeReserve, type FreeWithdrawalEnvironment, type FreeWithdrawalLedger } from "./governanceFreeWithdrawal";
import { finalizeVote, reconcileFinalizeVote, type FinalizeVoteEnvironment, type FinalizeVoteLedger } from "./governanceFinalize";
import { createProposalControl, reconcileProposalControl, type ProposalControlEnvironment,
  type ProposalControlLedger } from "./governanceProposalControl";
import { publishOwnerGovernanceSnapshot } from "./governanceSnapshotControl";
import { executeLockDecision, reconcileLockExecution, type LockExecutionLedger } from "./governanceLockExecutionControl";
import { executeBuybackDecision, reconcileBuybackExecution, type BuybackExecutionLedger } from "./governanceBuybackExecutionControl";
import { executeMarketingDecision, reconcileMarketingExecution, type MarketingExecutionLedger } from "./governanceMarketingExecutionControl";
import { releaseMatureMstrxLock, reconcileLockRelease, type LockReleaseLedger,
  type SignedLockRelease } from "./governanceLockReleaseControl";
import { assertSolanaRunnerSingleton } from "./runnerSingleton";
import { requireGovernanceExecutionReleased, SOLANA_GOVERNANCE_EXECUTION_RELEASED } from "./releaseGates";
import { verifyGovernanceReserveRoute } from "./governanceVaultRoute";

interface ControlRequest extends SignedSolanaControlAction { id: string; requestedAt: number }
interface ControlStatus {
  network: "solana-mainnet-beta";
  automationState: "running" | "stopped" | "unknown";
  launch: { configured: boolean; executionReleased?: boolean; armed: boolean; armedAt?: number; detectedMint?: string; detectedSignature?: string; governanceBindState?: "pending" | "bound"; activated: boolean };
  services: Record<string, { ok: boolean; updatedAt: number; detail?: string }>;
  balances: { creatorMstrxRaw?: string; holderMstrxRaw?: string; reserveMstrxRaw?: string };
  governance?: {
    program: string;
    programCodeSha256: string;
    reserveMint: string;
    capitalTokenProgram: string;
    withdrawalReleased: boolean;
    vaultTokenAccount: string;
    boundCapitalMint: string | null;
    vaultBalanceRaw: string;
    committedRaw: string;
    freeRaw: string;
    lastProposalId: string;
    activeProposalId: string;
    updatedAt: number;
  };
  governanceWithdrawal?: { requestId: string; amountRaw: string; signature: string; state: string; updatedAt: number };
  governanceFinalization?: { requestId: string; proposalId: string; signature: string; state: string; updatedAt: number };
  governanceCreation?: { requestId: string; proposalId: string; mode: string; signature: string; state: string; updatedAt: number };
  governanceLockExecution?: { requestId: string; proposalId: string; signature: string; state: string; updatedAt: number };
  governanceBuybackExecution?: { requestId: string; proposalId: string; signature: string; state: string; updatedAt: number };
  governanceMarketingExecution?: { requestId: string; proposalId: string; signature: string; state: string; updatedAt: number };
  governanceLockRelease?: { requestId: string; proposalId: string; signature: string; state: string; updatedAt: number };
  governanceSnapshot?: { proposalId: string; merkleRoot: string; totalAvailableWeight: string;
    sourceSha256: string; snapshotSha256: string; publishedAtUnix: number; reused: boolean; updatedAt: number };
  governanceProposal?: GovernanceProposalStatus;
  conversionsPaused: boolean;
  rewardEpochOwnsPause?: boolean;
  updatedAt: number;
}

const controlRoot = resolve(process.env.CONTROL_DATA_ROOT || "data/control");
const requestRoot = resolve(controlRoot, "solana-requests");
const completedRoot = resolve(controlRoot, "solana-completed");
const failedRoot = resolve(controlRoot, "solana-failed");
// Web mounts this directory read-only; the runner's state and nonce ledger are
// deliberately outside the web container's writable volumes.
const statusPath = resolve(controlRoot, "solana-status-visible", "solana-status.json");
const legacyStatusPath = resolve(controlRoot, "solana-status.json");

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function rpcUrls() { return [required("SOLANA_RPC_PRIMARY_URL"), required("SOLANA_RPC_FALLBACK_URL")]; }
function mstrxMint() { return new PublicKey(required("SOLANA_MSTRX_MINT")); }

// Legacy governance reconciliation remains dormant; it is not part of the
// owner-wallet launch and fee route.
function governanceStatus(route: Awaited<ReturnType<typeof verifyGovernanceReserveRoute>>): NonNullable<ControlStatus["governance"]> {
  return {
    program: route.program,
    programCodeSha256: route.programCodeSha256,
    reserveMint: mstrxMint().toBase58(),
    capitalTokenProgram: route.capitalTokenProgram,
    withdrawalReleased: SOLANA_GOVERNANCE_RESERVE_WITHDRAWAL_RELEASED,
    vaultTokenAccount: route.ata,
    boundCapitalMint: route.boundMint,
    vaultBalanceRaw: route.vaultBalanceRaw.toString(),
    committedRaw: route.committedRaw.toString(),
    freeRaw: route.freeRaw.toString(),
    lastProposalId: route.lastProposalId.toString(),
    activeProposalId: route.activeProposalId.toString(),
    updatedAt: Date.now(),
  };
}

function freeWithdrawalEnvironment(status: ControlStatus): FreeWithdrawalEnvironment {
  if (!status.launch.activated || status.launch.governanceBindState !== "bound" || !status.launch.detectedMint) {
    throw new Error("GOVERNANCE_NOT_BOUND");
  }
  return {
    rpcUrls: rpcUrls() as [string, string],
    stateRoot: resolve(process.env.SOLANA_STATE_ROOT || "data/solana"),
    governanceProgram: required("SOLANA_GOVERNANCE_PROGRAM"),
    expectedProgramCodeSha256: required("SOLANA_GOVERNANCE_PROGRAM_CODE_SHA256"),
    reserveAuthority: required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"),
    reserveMint: required("SOLANA_MSTRX_MINT"),
    capitalMint: status.launch.detectedMint,
    admin: required("SOLANA_ADMIN_OWNER"),
    adminKeypairPath: process.env.SOLANA_ADMIN_KEYPAIR_PATH?.trim() || required("SOLANA_CREATOR_KEYPAIR_PATH"),
  };
}

function finalizeVoteEnvironment(status: ControlStatus): FinalizeVoteEnvironment {
  const withdrawal = freeWithdrawalEnvironment(status);
  return {
    rpcUrls: withdrawal.rpcUrls,
    stateRoot: withdrawal.stateRoot,
    governanceProgram: withdrawal.governanceProgram,
    expectedProgramCodeSha256: withdrawal.expectedProgramCodeSha256,
    reserveAuthority: withdrawal.reserveAuthority,
    reserveMint: withdrawal.reserveMint,
    capitalMint: withdrawal.capitalMint,
    admin: withdrawal.admin,
    adminKeypairPath: withdrawal.adminKeypairPath,
  };
}

function finalizationProgress(ledger: FinalizeVoteLedger): NonNullable<ControlStatus["governanceFinalization"]> {
  return { requestId: ledger.requestId, proposalId: ledger.intent.proposalId,
    signature: ledger.transaction.signature, state: ledger.state, updatedAt: ledger.updatedAt };
}

function proposalControlEnvironment(status: ControlStatus): ProposalControlEnvironment {
  const base = finalizeVoteEnvironment(status);
  return { rpcUrls: base.rpcUrls, stateRoot: base.stateRoot,
    publicDataRoot: resolve(process.env.PUBLIC_DATA_ROOT || "data/public"),
    governanceProgram: base.governanceProgram,
    expectedProgramCodeSha256: base.expectedProgramCodeSha256,
    reserveMint: base.reserveMint, capitalMint: base.capitalMint,
    admin: base.admin, adminKeypairPath: base.adminKeypairPath };
}

function proposalCreationProgress(ledger: ProposalControlLedger): NonNullable<ControlStatus["governanceCreation"]> {
  return { requestId: ledger.requestId,
    proposalId: ledger.authorization.proposalCreation!.proposalId,
    mode: ledger.authorization.proposalCreation!.request.mode,
    signature: ledger.transaction.signature, state: ledger.state, updatedAt: ledger.updatedAt };
}

function lockExecutionProgress(ledger: LockExecutionLedger): NonNullable<ControlStatus["governanceLockExecution"]> {
  return { requestId: ledger.requestId, proposalId: ledger.authorization.lockExecution!.proposalId,
    signature: ledger.transaction.signature, state: ledger.state, updatedAt: ledger.updatedAt };
}

function buybackExecutionProgress(ledger: BuybackExecutionLedger): NonNullable<ControlStatus["governanceBuybackExecution"]> {
  return { requestId: ledger.requestId, proposalId: ledger.authorization.buybackExecution!.proposalId,
    signature: ledger.transaction.signature, state: ledger.state, updatedAt: ledger.updatedAt };
}

function marketingExecutionProgress(ledger: MarketingExecutionLedger): NonNullable<ControlStatus["governanceMarketingExecution"]> {
  return { requestId: ledger.requestId, proposalId: ledger.authorization.marketingExecution!.proposalId,
    signature: ledger.transaction.signature, state: ledger.state, updatedAt: ledger.updatedAt };
}

function lockReleaseProgress(ledger: LockReleaseLedger): NonNullable<ControlStatus["governanceLockRelease"]> {
  return { requestId: ledger.requestId, proposalId: ledger.authorization.lockRelease.proposalId,
    signature: ledger.transaction.signature, state: ledger.state, updatedAt: ledger.updatedAt };
}

function withdrawalProgress(ledger: FreeWithdrawalLedger): NonNullable<ControlStatus["governanceWithdrawal"]> {
  return { requestId: ledger.requestId, amountRaw: ledger.intent.amountRaw,
    signature: ledger.transaction.signature, state: ledger.state, updatedAt: ledger.updatedAt };
}

function feeEnvironment(status: ControlStatus): FeeSettlementEnvironment {
  return {
    rpcUrls: rpcUrls() as [string, string],
    stateRoot: resolve(process.env.SOLANA_STATE_ROOT || "data/solana"),
    projectMint: status.launch.detectedMint || required("SOLANA_CAPITAL_MINT"),
    mint: required("SOLANA_MSTRX_MINT"),
    creator: required("SOLANA_CREATOR_PUBLIC_KEY"),
    holder: required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY"),
    reserve: required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"),
    recovery: required("SOLANA_RECOVERY_PUBLIC_KEY"),
    creatorKeypairPath: required("SOLANA_CREATOR_KEYPAIR_PATH"),
    operatorKeypairPath: required("SOLANA_OPERATOR_KEYPAIR_PATH"),
    minimumSweepRaw: BigInt(process.env.SOLANA_MIN_SWEEP_RAW_MSTRX || "10000"),
  };
}

function rewardEnvironment(status: ControlStatus): RewardPipelineEnvironment {
  const capitalMint = new PublicKey(status.launch.detectedMint || required("SOLANA_CAPITAL_MINT"));
  const quoteMint = mstrxMint();
  const excluded = [
    required("SOLANA_CREATOR_PUBLIC_KEY"),
    required("SOLANA_OPERATOR_PUBLIC_KEY"),
    required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY"),
    required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"),
    required("SOLANA_RECOVERY_PUBLIC_KEY"),
    bondingCurvePda(capitalMint).toBase58(),
    bondingCurveV2Pda(capitalMint).toBase58(),
    canonicalPumpPoolPda(capitalMint).toBase58(),
    canonicalPumpPoolPdaWithQuote(capitalMint, quoteMint).toBase58(),
    pumpPoolAuthorityPda(capitalMint).toBase58(),
    ...(process.env.SOLANA_EXCLUDED_HOLDER_ADDRESSES || "").split(",").map((value) => value.trim()).filter(Boolean),
  ];
  return {
    rpcUrls: rpcUrls() as [string, string],
    stateRoot: resolve(process.env.SOLANA_STATE_ROOT || "data/solana"),
    publicDataRoot: resolve(process.env.PUBLIC_DATA_ROOT || "data/public"),
    journalPath: resolve(required("SOLANA_HOLDER_JOURNAL_PATH")),
    capitalMint: capitalMint.toBase58(),
    mstrxMint: required("SOLANA_MSTRX_MINT"),
    operatorKeypairPath: required("SOLANA_OPERATOR_KEYPAIR_PATH"),
    holderKeypairPath: required("SOLANA_HOLDER_SETTLEMENT_KEYPAIR_PATH"),
    excluded,
    minimumRawMstrx: BigInt(process.env.SOLANA_MIN_EPOCH_RAW_MSTRX || "100000"),
  };
}

async function readStatus(): Promise<ControlStatus> {
  try { return JSON.parse(await readFile(statusPath, "utf8")) as ControlStatus; }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    try { return JSON.parse(await readFile(legacyStatusPath, "utf8")) as ControlStatus; }
    catch (legacyError) {
      if (!legacyError || typeof legacyError !== "object" || !("code" in legacyError) || legacyError.code !== "ENOENT") throw legacyError;
      return { network: "solana-mainnet-beta", automationState: "stopped", launch: { configured: false, armed: false, activated: false }, services: {}, balances: {}, conversionsPaused: false, updatedAt: 0 };
    }
  }
}

async function saveStatus(status: ControlStatus) {
  status.updatedAt = Date.now();
  // This file is mounted into web. Service details are not used by the panel
  // and may carry a legacy/raw RPC exception after an upgrade.
  const services = Object.fromEntries(Object.entries(status.services).map(([name, value]) => [
    name, { ok: value.ok, updatedAt: value.updatedAt },
  ]));
  await writeDurableJson(statusPath, {
    network: status.network,
    automationState: status.automationState,
    launch: {
      configured: status.launch.configured,
      executionReleased: true,
      armed: status.launch.armed,
      armedAt: status.launch.armedAt,
      detectedMint: status.launch.detectedMint,
      detectedSignature: status.launch.detectedSignature,
      governanceBindState: status.launch.governanceBindState,
      activated: status.launch.activated,
    },
    services,
    balances: {
      creatorMstrxRaw: status.balances.creatorMstrxRaw,
      holderMstrxRaw: status.balances.holderMstrxRaw,
      reserveMstrxRaw: status.balances.reserveMstrxRaw,
    },
    reserveWallet: process.env.SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY?.trim(),
    governance: status.governance,
    governanceFinalizeReleased: SOLANA_GOVERNANCE_FINALIZE_RELEASED,
    governanceProposalControlReleased: SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED,
    governanceWithdrawal: status.governanceWithdrawal,
    governanceFinalization: status.governanceFinalization,
    governanceCreation: status.governanceCreation,
    governanceLockExecution: status.governanceLockExecution,
    governanceBuybackExecution: status.governanceBuybackExecution,
    governanceMarketingExecution: status.governanceMarketingExecution,
    governanceLockRelease: status.governanceLockRelease,
    governanceSnapshot: status.governanceSnapshot,
    governanceProposal: status.governanceProposal,
    conversionsPaused: status.conversionsPaused,
    rewardEpochOwnsPause: status.rewardEpochOwnsPause,
    updatedAt: status.updatedAt,
  });
}

async function saveHeartbeat(service: string, ok: boolean, detail?: string) {
  const root = resolve(process.env.PUBLIC_DATA_ROOT || "data/public", "status");
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, `${service}.json`), JSON.stringify({ service, ok, updatedAt: Date.now(), ...(detail ? { detail } : {}) }, null, 2), { encoding: "utf8", mode: 0o644, flush: true });
}

async function publishRuntimeConfig(status: ControlStatus, launchedAtSlot: number) {
  if (!status.launch.detectedMint || !status.launch.detectedSignature) throw new Error("DETECTED_LAUNCH_REQUIRED");
  const mint = mstrxMint();
  const holder = new PublicKey(required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY"));
  const reserve = new PublicKey(required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"));
  const config = {
    network: "solana-mainnet-beta",
    projectMint: status.launch.detectedMint,
    launchedAtSignature: status.launch.detectedSignature,
    mstrxMint: mint.toBase58(),
    creatorFeeRecipient: required("SOLANA_CREATOR_PUBLIC_KEY"),
    rewardVaultTokenAccount: mstrxAta(holder, mint).toBase58(),
    reserveVaultTokenAccount: mstrxAta(reserve, mint).toBase58(),
    reserveWallet: reserve.toBase58(),
    ...(process.env.SOLANA_MARKETING_PUBLIC_KEY?.trim() ? { marketingWallet: process.env.SOLANA_MARKETING_PUBLIC_KEY.trim() } : {}),
    launchedAtSlot,
  };
  const root = resolve(process.env.PUBLIC_DATA_ROOT || "data/public");
  await mkdir(root, { recursive: true });
  await writeDurableJson(resolve(root, "config.json"), config);
}

async function rawMstrxBalance(connection: Connection, owner: PublicKey) {
  return (await getAccount(connection, mstrxAta(owner, mstrxMint()), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
}

async function publishPublicBalances(status: ControlStatus) {
  if (!status.launch.activated) return false;
  const mint = mstrxMint();
  const holderAta = mstrxAta(new PublicKey(required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY")), mint);
  const reserveAta = mstrxAta(new PublicKey(required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY")), mint);
  const snapshots = await Promise.all(rpcUrls().map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [mintAccount, holder, reserve] = await Promise.all([
      getMint(connection, mint, "finalized", TOKEN_2022_PROGRAM_ID),
      connection.getTokenAccountBalance(holderAta, "finalized"),
      connection.getTokenAccountBalance(reserveAta, "finalized"),
    ]);
    const scaled = getScaledUiAmountConfig(mintAccount);
    const effective = scaled && BigInt(Math.floor(Date.now() / 1_000)) >= scaled.newMultiplierEffectiveTimestamp;
    return {
      holderRaw: holder.value.amount,
      reserveRaw: reserve.value.amount,
      holderDisplay: holder.value.uiAmountString ?? "0",
      reserveDisplay: reserve.value.uiAmountString ?? "0",
      multiplier: scaled ? effective ? scaled.newMultiplier : scaled.multiplier : 1,
    };
  }));
  const snapshot = requireMatchingValues(snapshots, "PUBLIC_VAULT_RPC_DISAGREEMENT");
  status.balances.holderMstrxRaw = snapshot.holderRaw;
  status.balances.reserveMstrxRaw = snapshot.reserveRaw;
  await writeDurableJson(resolve(process.env.PUBLIC_DATA_ROOT || "data/public", "snapshots", "solana-vaults.json"), { ...snapshot, updatedAt: Date.now() });
  return true;
}

async function verifyPrelaunch(status: ControlStatus) {
  const urls = rpcUrls();
  const consensus = await finalizedConsensus(urls);
  const owner = new PublicKey(required("SOLANA_ADMIN_OWNER"));
  const creator = await loadKeypair(required("SOLANA_CREATOR_KEYPAIR_PATH"));
  const admin = await loadKeypair(process.env.SOLANA_ADMIN_KEYPAIR_PATH?.trim() || required("SOLANA_CREATOR_KEYPAIR_PATH"));
  const operator = await loadKeypair(required("SOLANA_OPERATOR_KEYPAIR_PATH"));
  const holder = await loadKeypair(required("SOLANA_HOLDER_SETTLEMENT_KEYPAIR_PATH"));
  const reserve = new PublicKey(required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"));
  const recovery = new PublicKey(required("SOLANA_RECOVERY_PUBLIC_KEY"));
  if (!creator.publicKey.equals(new PublicKey(required("SOLANA_CREATOR_PUBLIC_KEY")))) throw new Error("CREATOR_KEYPAIR_MISMATCH");
  if (!admin.publicKey.equals(owner)) throw new Error("GOVERNANCE_ADMIN_KEYPAIR_MISMATCH");
  const expectedOperator = required("SOLANA_OPERATOR_PUBLIC_KEY");
  if (!operator.publicKey.equals(new PublicKey(expectedOperator))) throw new Error("OPERATOR_KEYPAIR_MISMATCH");
  if (!holder.publicKey.equals(new PublicKey(required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY")))) throw new Error("HOLDER_KEYPAIR_MISMATCH");
  assertSolanaWalletRoles(
    { owner, creator: creator.publicKey, operator: operator.publicKey, holder: holder.publicKey, reserve, recovery },
    sharedAdminCreatorEnabled(process.env.SOLANA_SHARED_ADMIN_CREATOR),
  );
  // The reserve is an ordinary owner-controlled wallet, not a deployed program vault.
  status.governance = undefined;

  const snapshots = await Promise.all(urls.map(async (url) => {
    const mint = await getMint(new Connection(url, "finalized"), mstrxMint(), "finalized", TOKEN_2022_PROGRAM_ID);
    return { decimals: mint.decimals, extensions: getExtensionTypes(mint.tlvData).sort((a, b) => a - b) };
  }));
  const snapshot = requireMatchingValues(snapshots, "MSTRX_RPC_DISAGREEMENT");
  if (snapshot.decimals !== 8) throw new Error("MSTRX_DECIMALS_MISMATCH");
  if (snapshot.extensions.includes(ExtensionType.TransferFeeConfig)) throw new Error("MSTRX_TRANSFER_FEE_UNSUPPORTED");
  if (!snapshot.extensions.includes(ExtensionType.TransferHook)) throw new Error("MSTRX_TRANSFER_HOOK_EXPECTED");
  if (!status.launch.activated) {
    const feeVaults = await Promise.all(urls.map(async (rpcUrl) => {
      const balances = await readCustomQuoteCreatorFeeBalances({
        rpcUrl, creator: creator.publicKey.toBase58(), quoteMint: mstrxMint().toBase58(),
        quoteTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      });
      return { curveRaw: balances.curveRaw.toString(), pumpSwapRaw: balances.pumpSwapRaw.toString() };
    }));
    const agreedFeeVaults = requireMatchingValues(feeVaults, "PUMP_FEE_VAULT_RPC_DISAGREEMENT");
    if (BigInt(agreedFeeVaults.curveRaw) !== 0n || BigInt(agreedFeeVaults.pumpSwapRaw) !== 0n) {
      throw new Error("CREATOR_MSTRX_FEE_VAULT_NOT_EMPTY");
    }
  }
  status.launch.configured = true;
  status.services["solana-control-runner"] = { ok: true, updatedAt: Date.now(), detail: `MSTRx custom-pair ready at finalized slot ${consensus.slot}` };
}

function distinctFeeOwners(owners: PublicKey[]) {
  return [...new Map(owners.map((owner) => [owner.toBase58(), owner])).values()];
}

async function ensureFeeAtas(connection: Connection) {
  const operator = await loadKeypair(required("SOLANA_OPERATOR_KEYPAIR_PATH"));
  const creator = new PublicKey(required("SOLANA_CREATOR_PUBLIC_KEY"));
  const holder = new PublicKey(required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY"));
  const reserve = new PublicKey(required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"));
  const recovery = new PublicKey(required("SOLANA_RECOVERY_PUBLIC_KEY"));
  // Creator and recovery intentionally share the dev wallet in single-wallet mode.
  // One ATA creation per owner avoids duplicate instructions in the same transaction.
  const destinations = distinctFeeOwners([creator, holder, reserve, recovery]);
  const atas = destinations.map((destination) => mstrxAta(destination, mstrxMint()));
  const accounts = await connection.getMultipleAccountsInfo(atas, "confirmed");
  const instructions = destinations.flatMap((destination, index) => accounts[index]
    ? []
    : [createMstrxAtaInstruction(operator.publicKey, destination, mstrxMint())]);
  if (!instructions.length) return;
  return simulateAndSend({
    connection,
    payer: operator,
    instructions,
  });
}

async function executeFeeSweep(status: ControlStatus, phase: "curve" | "pumpswap") {
  if (!status.launch.activated || status.conversionsPaused) throw new Error("AUTOMATION_NOT_ACTIVE");
  const connection = new Connection(required("SOLANA_RPC_PRIMARY_URL"), "finalized");
  const ataSignature = await ensureFeeAtas(connection);
  const result = await sweepCreatorFees(feeEnvironment(status), phase);
  if (!result.changed && !result.receipt) return false;
  status.balances.creatorMstrxRaw = (await rawMstrxBalance(connection, new PublicKey(required("SOLANA_CREATOR_PUBLIC_KEY")))).toString();
  status.balances.holderMstrxRaw = (await rawMstrxBalance(connection, new PublicKey(required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY")))).toString();
  status.balances.reserveMstrxRaw = (await rawMstrxBalance(connection, new PublicKey(required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY")))).toString();
  status.services["solana-fee-keeper"] = {
    ok: true,
    updatedAt: Date.now(),
    detail: `${result.receipt?.phase ?? phase}:ata=${ataSignature ?? "existing"}:collect=${result.receipt?.collection.signature}:state=${result.receipt?.state}:gross=${result.receipt?.collectedRaw ?? "pending"}:holder=${result.receipt?.holderRaw ?? "pending"}:reserve=${result.receipt?.reserveRaw ?? "pending"}`,
  };
  await saveHeartbeat("solana-fee-keeper", true, status.services["solana-fee-keeper"].detail);
  return result.changed;
}

async function completeLaunchActivation(
  status: ControlStatus,
  launch: { mint: string; slot: number; signature: string },
  steps: {
    ensureAtas: () => Promise<unknown>;
    publishConfig: (status: ControlStatus, slot: number) => Promise<unknown>;
    publishHeartbeat: (service: string, ok: boolean, detail: string) => Promise<unknown>;
  },
) {
  // Keep the armed status intact until every activation prerequisite has succeeded.
  // ATA creation and runtime publication are idempotent, so a failed attempt can retry.
  const pendingStatus: ControlStatus = {
    ...status,
    launch: { ...status.launch, detectedMint: launch.mint, detectedSignature: launch.signature, activated: false },
  };
  await steps.ensureAtas();
  await steps.publishConfig(pendingStatus, launch.slot);
  const detail = `${launch.mint}:${launch.signature || "manual"}`;
  await steps.publishHeartbeat("solana-launch-detector", true, detail);

  status.launch = { ...pendingStatus.launch, armed: false, governanceBindState: undefined, activated: true };
  status.governance = undefined;
  status.automationState = "running";
  status.services["solana-launch-detector"] = { ok: true, updatedAt: Date.now(), detail };
}

function markGovernanceBindPending(status: ControlStatus) {
  status.launch.governanceBindState = "pending";
  status.services["solana-launch-detector"] = { ok: true, updatedAt: Date.now(), detail: "governance-bind-pending" };
  // No part of the public runtime is marked activated until finalized binding.
  return false;
}

async function activateLaunch(status: ControlStatus, candidate: PumpCreateCandidate) {
  assertFixedMstrxPumpLaunch({
    ...candidate,
    expectedCreator: required("SOLANA_CREATOR_PUBLIC_KEY"),
    expectedQuoteMint: required("SOLANA_MSTRX_MINT"),
  });
  const facts = await verifyFixedMstrxPumpLaunch({
    rpcUrls: rpcUrls(),
    mint: candidate.mint,
    expectedCreator: required("SOLANA_CREATOR_PUBLIC_KEY"),
    expectedQuoteMint: required("SOLANA_MSTRX_MINT"),
  });
  if (facts.mint !== candidate.mint || facts.creator !== candidate.creator
    || facts.quoteMint !== candidate.quoteMint || facts.tokenProgram !== candidate.tokenProgram
    || candidate.slot > facts.finalizedSlot) throw new Error("PUMP_LAUNCH_EVENT_STATE_MISMATCH");
  await completeLaunchActivation(status, { mint: facts.mint, slot: candidate.slot, signature: candidate.signature }, {
    ensureAtas: () => ensureFeeAtas(new Connection(required("SOLANA_RPC_PRIMARY_URL"), "confirmed")),
    publishConfig: publishRuntimeConfig,
    publishHeartbeat: saveHeartbeat,
  });
  return true;
}

async function automaticLaunchTick(status: ControlStatus) {
  if (!status.launch.armed || status.launch.activated || !status.launch.armedAt) return false;
  const candidate = await detectDurableAgreedCreatorPumpLaunch({
    rpcUrls: rpcUrls() as [string, string],
    creator: required("SOLANA_CREATOR_PUBLIC_KEY"),
    armedAtMs: status.launch.armedAt,
    stateRoot: resolve(process.env.SOLANA_STATE_ROOT || "data/solana"),
  });
  if (!candidate) return false;
  await activateLaunch(status, candidate);
  return true;
}

async function automaticFeeTick(status: ControlStatus) {
  if (!status.launch.activated || status.automationState !== "running" || status.conversionsPaused) return false;
  const curve = await executeFeeSweep(status, "curve");
  const pumpSwap = await executeFeeSweep(status, "pumpswap");
  return curve || pumpSwap;
}

async function automaticRewardTick(status: ControlStatus) {
  if (process.env.SOLANA_AUTO_REWARDS === "false") return false;
  if (!status.launch.activated || status.automationState !== "running") return false;
  const environment = rewardEnvironment(status);
  let current: Awaited<ReturnType<typeof loadCurrentRewardPlan>> | undefined;
  try {
    current = await loadCurrentRewardPlan(environment);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  if (current?.finalized) {
    if (status.rewardEpochOwnsPause) {
      status.conversionsPaused = false;
      status.rewardEpochOwnsPause = false;
      await saveStatus(status);
    }
    let journal: { epochId: string };
    try {
      journal = JSON.parse(await readFile(environment.journalPath, "utf8")) as { epochId: string };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    if (BigInt(journal.epochId) <= BigInt(current.epochId)) return false;
    current = undefined;
  }

  if (!current) {
    try {
      if (!status.conversionsPaused) { status.conversionsPaused = true; status.rewardEpochOwnsPause = true; }
      current = await prepareRewardEpoch(environment);
      await saveStatus(status);
      status.services["solana-reward-publisher"] = { ok: true, updatedAt: Date.now(), detail: `prepared epoch ${current.epochId}:${current.planHash}` };
      await saveHeartbeat("solana-reward-publisher", true, status.services["solana-reward-publisher"].detail);
    } catch (error) {
      if (status.rewardEpochOwnsPause) { status.conversionsPaused = false; status.rewardEpochOwnsPause = false; }
      if (error instanceof Error && (error.message === "HOLDER_INVENTORY_BELOW_MINIMUM" || (error as NodeJS.ErrnoException).code === "ENOENT")) return false;
      throw error;
    }
  } else if (!status.conversionsPaused) {
    status.conversionsPaused = true;
    status.rewardEpochOwnsPause = true;
    await saveStatus(status);
  }

  const distributed = await distributeRewardEpoch(environment);
  const confirmed = distributed.batches.filter((batch) => batch.state === "confirmed").length;
  status.services["solana-distributor"] = { ok: true, updatedAt: Date.now(), detail: `epoch ${distributed.epochId}:${confirmed}/${distributed.batches.length} batches` };
  await saveHeartbeat("solana-distributor", true, status.services["solana-distributor"].detail);
  if (confirmed !== distributed.batches.length) {
    await saveStatus(status);
    return false;
  }
  const finalized = await finalizeRewardEpoch(environment);
  status.services["solana-distributor"] = { ok: true, updatedAt: Date.now(), detail: `finalized epoch ${finalized.epochId}:${finalized.fundedRawMstrx} raw MSTRx` };
  await saveHeartbeat("solana-distributor", true, status.services["solana-distributor"].detail);
  if (status.rewardEpochOwnsPause) { status.conversionsPaused = false; status.rewardEpochOwnsPause = false; }
  return true;
}

async function automaticOwedRetryTick(status: ControlStatus) {
  if (process.env.SOLANA_AUTO_REWARDS === "false") return false;
  if (!status.launch.activated || status.automationState !== "running" || status.conversionsPaused) return false;
  const result = await retryOwedRewardPayments(rewardEnvironment(status));
  status.services["solana-owed-reward-retry"] = {
    ok: true, updatedAt: Date.now(), detail: `processed ${result.processed}; outstanding ${result.remaining}`,
  };
  await saveHeartbeat("solana-owed-reward-retry", true, status.services["solana-owed-reward-retry"].detail);
  // Persist the healthy/no-debt state too, so a previous retry failure cannot
  // remain visible as an indefinitely stale service status.
  return true;
}

function parkUnreleasedLaunch(status: ControlStatus) {
  return status;
}

async function recoverCreatorMstrx(status: ControlStatus) {
  if (!status.conversionsPaused) throw new Error("PAUSE_REQUIRED");
  await ensureFeeAtas(new Connection(required("SOLANA_RPC_PRIMARY_URL"), "confirmed"));
  const result = await recoverUncommittedCreatorFees(feeEnvironment(status));
  status.balances.creatorMstrxRaw = (await rawMstrxBalance(new Connection(required("SOLANA_RPC_PRIMARY_URL"), "finalized"), new PublicKey(required("SOLANA_CREATOR_PUBLIC_KEY")))).toString();
  const recoveryRoute = "alreadyAtRecovery" in result && result.alreadyAtRecovery
    ? "already-in-dev-wallet" : result.signature ?? "pending";
  status.services["solana-fee-keeper"] = { ok: true, updatedAt: Date.now(), detail: `recover-uncommitted:${result.amount}:${recoveryRoute}:${result.pending ? "pending" : "finalized"}` };
}

async function consumeControlNonce(request: ControlRequest) {
  // The nonce ledger must not be mounted into the public web container.
  // Consume before dispatch so a restart cannot repeat an authorized action.
  const root = resolve(process.env.SOLANA_STATE_ROOT || "data/solana", "control-nonces");
  await mkdir(root, { recursive: true });
  try {
    await writeFile(resolve(root, `${request.nonce}.json`), JSON.stringify({
      requestId: request.id, action: request.action, signer: request.signer, consumedAt: Date.now(),
    }), { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error("CONTROL_NONCE_REPLAY");
    throw error;
  }
}

async function dispatch(request: ControlRequest, status: ControlStatus) {
  verifySignedSolanaControlAction(request, required("SOLANA_ADMIN_OWNER"));
  if (["withdraw_free_reserve", "finalize_vote", "create_proposal", "create_revote", "publish_snapshot",
    "execute_lock_mstrx", "execute_buyback", "execute_marketing_sale", "release_lock_mstrx"].includes(request.action)) {
    requireGovernanceExecutionReleased();
  }
  if (request.action === "withdraw_free_reserve" && !SOLANA_GOVERNANCE_RESERVE_WITHDRAWAL_RELEASED) {
    throw new Error("RESERVE_WITHDRAWAL_NOT_RELEASED");
  }
  if (request.action === "finalize_vote" && !SOLANA_GOVERNANCE_FINALIZE_RELEASED) {
    throw new Error("GOVERNANCE_FINALIZE_NOT_RELEASED");
  }
  if (["create_proposal", "create_revote", "publish_snapshot"].includes(request.action)
    && !SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED) {
    throw new Error("GOVERNANCE_PROPOSAL_NOT_RELEASED");
  }
  await consumeControlNonce(request);
  switch (request.action) {
    case "verify_launch_config": await verifyPrelaunch(status); break;
    case "arm_launch_detection":
      if (status.launch.armed || status.launch.activated) throw new Error("DETECTOR_ALREADY_ARMED");
      await verifyPrelaunch(status);
      {
        const creator = required("SOLANA_CREATOR_PUBLIC_KEY");
        const stateRoot = resolve(process.env.SOLANA_STATE_ROOT || "data/solana");
        const previous = await resumeDurableCreatorPumpLaunchScan({
          creator, stateRoot, expectedArmedAtMs: status.launch.armedAt,
        });
        if (previous !== undefined) status.launch.armedAt = previous;
        else {
          if (status.launch.armedAt !== undefined) throw new Error("PUMP_LAUNCH_SCAN_STATE_MISSING");
          status.launch.armedAt = Date.now();
          await armDurableCreatorPumpLaunchScan({
            rpcUrls: rpcUrls() as [string, string], creator,
            armedAtMs: status.launch.armedAt, stateRoot,
          });
        }
      }
      status.launch.armed = true;
      break;
    // Disarm pauses scanning, but the original boundary survives for a safe
    // owner-controlled resume. Re-anchoring would skip a token minted meanwhile.
    case "disarm_launch_detection": status.launch.armed = false; break;
    case "activate_postlaunch": {
      if (!status.launch.armed || !status.launch.armedAt) throw new Error("DETECTOR_NOT_ARMED");
      const candidate = await detectDurableAgreedCreatorPumpLaunch({
        rpcUrls: rpcUrls() as [string, string],
        creator: required("SOLANA_CREATOR_PUBLIC_KEY"),
        armedAtMs: status.launch.armedAt,
        stateRoot: resolve(process.env.SOLANA_STATE_ROOT || "data/solana"),
      });
      if (!candidate) throw new Error("PUMP_LAUNCH_NOT_FINALIZED");
      // The detector activates automatically after both RPCs verify the mint.
      await activateLaunch(status, candidate);
      break;
    }
    case "sweep_curve_fees": await executeFeeSweep(status, "curve"); break;
    case "sweep_pumpswap_fees": await executeFeeSweep(status, "pumpswap"); break;
    case "pause_conversions": status.conversionsPaused = true; break;
    case "reconcile_fee_receipts": {
      if (!status.conversionsPaused) throw new Error("PAUSE_REQUIRED");
      const result = await reconcilePendingFeeReceipt(feeEnvironment(status));
      status.services["solana-fee-keeper"] = { ok: !result.pending, updatedAt: Date.now(), detail: result.signature ? `${result.signature}:${result.state}` : "no pending receipts" };
      break;
    }
    case "resume_conversions":
      if (!status.launch.configured) throw new Error("LAUNCH_NOT_CONFIGURED");
      await finalizedConsensus(rpcUrls());
      status.conversionsPaused = false;
      break;
    case "recover_uncommitted": await recoverCreatorMstrx(status); break;
    case "withdraw_free_reserve": {
      if (!request.withdrawal) throw new Error("RESERVE_WITHDRAWAL_INTENT_REQUIRED");
      const ledger = await withdrawFreeReserve(freeWithdrawalEnvironment(status), {
        requestId: request.id, nonce: request.nonce, intent: request.withdrawal,
      });
      status.governanceWithdrawal = withdrawalProgress(ledger);
      // Until both RPCs finalize, the old free balance must not be offered as
      // an actionable quote in the owner panel.
      if (status.governance) status.governance.updatedAt = 0;
      break;
    }
    case "finalize_vote": {
      if (!request.finalization) throw new Error("GOVERNANCE_FINALIZE_INTENT_REQUIRED");
      const ledger = await finalizeVote(finalizeVoteEnvironment(status), {
        requestId: request.id, nonce: request.nonce, intent: request.finalization,
      });
      status.governanceFinalization = finalizationProgress(ledger);
      status.governanceProposal = undefined;
      if (status.governance) status.governance.updatedAt = 0;
      break;
    }
    case "create_proposal":
    case "create_revote": {
      if (!request.proposalCreation) throw new Error("GOVERNANCE_PROPOSAL_INTENT_REQUIRED");
      const ledger = await createProposalControl(proposalControlEnvironment(status), {
        requestId: request.id, authorization: request,
      });
      status.governanceCreation = proposalCreationProgress(ledger);
      status.governanceProposal = undefined;
      if (status.governance) status.governance.updatedAt = 0;
      break;
    }
    case "publish_snapshot": {
      if (!request.snapshotPublication) throw new Error("GOVERNANCE_SNAPSHOT_INTENT_REQUIRED");
      if (!status.launch.activated || status.launch.governanceBindState !== "bound"
        || !status.launch.detectedMint) throw new Error("GOVERNANCE_NOT_BOUND");
      const base = proposalControlEnvironment(status);
      const summary = await publishOwnerGovernanceSnapshot({
        rpcUrls: base.rpcUrls, governanceProgram: base.governanceProgram,
        expectedProgramCodeSha256: base.expectedProgramCodeSha256,
        capitalMint: base.capitalMint, reserveMint: base.reserveMint,
        reserveAuthority: required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"), admin: base.admin,
        stateRoot: base.stateRoot, publicDataRoot: base.publicDataRoot,
        excluded: rewardEnvironment(status).excluded,
      }, request.snapshotPublication);
      status.governanceSnapshot = summary;
      break;
    }
    case "execute_lock_mstrx": {
      if (!request.lockExecution) throw new Error("GOVERNANCE_LOCK_INTENT_REQUIRED");
      const ledger = await executeLockDecision(freeWithdrawalEnvironment(status), {
        requestId: request.id, authorization: request,
      });
      status.governanceLockExecution = lockExecutionProgress(ledger);
      status.governanceProposal = undefined;
      if (status.governance) status.governance.updatedAt = 0;
      break;
    }
    case "execute_buyback": {
      if (!request.buybackExecution) throw new Error("GOVERNANCE_BUYBACK_INTENT_REQUIRED");
      const ledger = await executeBuybackDecision(freeWithdrawalEnvironment(status), {
        requestId: request.id, authorization: request as SignedSolanaControlAction & {
          action: "execute_buyback"; buybackExecution: NonNullable<SignedSolanaControlAction["buybackExecution"]> },
      });
      status.governanceBuybackExecution = buybackExecutionProgress(ledger);
      status.governanceProposal = undefined;
      if (status.governance) status.governance.updatedAt = 0;
      break;
    }
    case "execute_marketing_sale": {
      if (!request.marketingExecution) throw new Error("GOVERNANCE_MARKETING_INTENT_REQUIRED");
      const ledger = await executeMarketingDecision(freeWithdrawalEnvironment(status), {
        requestId: request.id, authorization: request,
      });
      status.governanceMarketingExecution = marketingExecutionProgress(ledger);
      status.governanceProposal = undefined;
      if (status.governance) status.governance.updatedAt = 0;
      break;
    }
    case "release_lock_mstrx": {
      if (!request.lockRelease) throw new Error("GOVERNANCE_LOCK_RELEASE_INTENT_REQUIRED");
      const ledger = await releaseMatureMstrxLock(freeWithdrawalEnvironment(status), {
        requestId: request.id, authorization: request as SignedLockRelease,
      });
      status.governanceLockRelease = lockReleaseProgress(ledger);
      status.governanceProposal = undefined;
      if (status.governance) status.governance.updatedAt = 0;
      break;
    }
    case "prepare_reward_epoch": {
      if (!status.launch.activated) throw new Error("AUTOMATION_NOT_ACTIVE");
      if (!status.conversionsPaused) { status.conversionsPaused = true; status.rewardEpochOwnsPause = true; }
      const plan = await prepareRewardEpoch(rewardEnvironment(status));
      status.services["solana-reward-publisher"] = { ok: true, updatedAt: Date.now(), detail: `prepared epoch ${plan.epochId}:${plan.planHash}` };
      break;
    }
    case "distribute_reward_epoch": {
      if (!status.conversionsPaused) throw new Error("FEE_ROUTING_MUST_BE_PAUSED");
      const plan = await distributeRewardEpoch(rewardEnvironment(status));
      const confirmed = plan.batches.filter((batch) => batch.state === "confirmed").length;
      status.services["solana-distributor"] = { ok: true, updatedAt: Date.now(), detail: `epoch ${plan.epochId}:${confirmed}/${plan.batches.length} batches` };
      break;
    }
    case "finalize_reward_epoch": {
      const plan = await finalizeRewardEpoch(rewardEnvironment(status));
      status.services["solana-distributor"] = { ok: true, updatedAt: Date.now(), detail: `finalized epoch ${plan.epochId}:${plan.fundedRawMstrx} raw MSTRx` };
      if (status.rewardEpochOwnsPause) { status.conversionsPaused = false; status.rewardEpochOwnsPause = false; }
      break;
    }
    default: throw new Error("ACTION_NOT_IMPLEMENTED");
  }
  await saveStatus(status);
}

async function processOnce() {
  await Promise.all([requestRoot, completedRoot, failedRoot].map((path) => mkdir(path, { recursive: true })));
  const names = (await readdir(requestRoot)).filter((name) => /^\d+-[a-f0-9]{16}\.json$/.test(name)).sort();
  if (!names.length) return false;
  const name = names[0];
  const requestId = name.slice(0, -5);
  const source = resolve(requestRoot, name);
  if (!source.startsWith(`${requestRoot}${sep}`)) throw new Error("REQUEST_PATH_INVALID");
  let request: ControlRequest | undefined;
  let failureCode: string | undefined;
  try {
    request = JSON.parse(await readFile(source, "utf8")) as ControlRequest;
    await dispatch(request, await readStatus());
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    failureCode = /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : "ACTION_FAILED";
  }
  if (failureCode) {
    try {
      await writeFile(resolve(failedRoot, name), JSON.stringify({
        id: requestId, action: request?.action, signer: request?.signer, failedAt: Date.now(), error: failureCode,
      }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      // A crash after writing the private failure record but before moving the
      // request can safely resume the same move on restart.
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    await rename(source, resolve(failedRoot, `${name}.request`));
    await writeControlRequestOutcome(controlRoot, requestId, "failed");
  } else {
    await rename(source, resolve(completedRoot, name));
    await writeControlRequestOutcome(controlRoot, requestId, "processed");
  }
  return true;
}

async function restoreRequestOutcomeMarkers() {
  for (const [state, root] of [["processed", completedRoot], ["failed", failedRoot]] as const) {
    await mkdir(root, { recursive: true });
    for (const name of await readdir(root)) {
      if (/^\d+-[a-f0-9]{16}\.json$/.test(name)) await writeControlRequestOutcome(controlRoot, name.slice(0, -5), state);
    }
  }
}

async function main() {
  assertSolanaRunnerSingleton("control-runner");
  const initialStatus = await readStatus();
  // A cached proposal result is never carried across process restarts before
  // a new pair of finalized provider reads verifies it again.
  initialStatus.governanceProposal = undefined;
  parkUnreleasedLaunch(initialStatus);
  await saveStatus(initialStatus);
  await restoreRequestOutcomeMarkers();
  let lastLaunchTick = 0;
  let lastFeeTick = 0;
  let lastRewardTick = 0;
  let lastOwedRetryTick = 0;
  let lastPublicBalanceTick = 0;
  let lastGovernanceWithdrawalTick = 0;
  let lastGovernanceFinalizeTick = 0;
  let lastGovernanceCreationTick = 0;
  let lastGovernanceLockTick = 0;
  let lastGovernanceBuybackTick = 0;
  let lastGovernanceMarketingTick = 0;
  let lastGovernanceLockReleaseTick = 0;
  while (true) {
    const processed = await processOnce();
    const now = Date.now();
    if (!processed && now - lastLaunchTick >= Number(process.env.SOLANA_LAUNCH_DETECT_INTERVAL_MS || "2000")) {
      lastLaunchTick = now;
      const status = await readStatus();
      try {
        if (await automaticLaunchTick(status)) await saveStatus(status);
      } catch {
        // This state is web-readable. RPC clients can embed authenticated URLs
        // in exception strings, so publish only a fixed diagnostic code.
        const detail = "LAUNCH_DETECTOR_FAILED";
        status.services["solana-launch-detector"] = { ok: false, updatedAt: Date.now(), detail };
        await Promise.all([saveStatus(status), saveHeartbeat("solana-launch-detector", false, detail)]);
      }
    }
    if (!processed && now - lastFeeTick >= Number(process.env.SOLANA_FEE_SWEEP_INTERVAL_MS || "30000")) {
      lastFeeTick = now;
      const status = await readStatus();
      try {
        if (await automaticFeeTick(status)) await saveStatus(status);
      } catch {
        const detail = "FEE_KEEPER_FAILED";
        status.services["solana-fee-keeper"] = { ok: false, updatedAt: Date.now(), detail };
        await Promise.all([saveStatus(status), saveHeartbeat("solana-fee-keeper", false, detail)]);
      }
    }
    if (!processed && now - lastRewardTick >= Number(process.env.SOLANA_REWARD_TICK_MS || "15000")) {
      lastRewardTick = now;
      const status = await readStatus();
      try {
        if (await automaticRewardTick(status)) await saveStatus(status);
      } catch {
        const detail = "REWARD_DISTRIBUTOR_FAILED";
        status.services["solana-distributor"] = { ok: false, updatedAt: Date.now(), detail };
        await Promise.all([saveStatus(status), saveHeartbeat("solana-distributor", false, detail)]);
      }
    }
    if (!processed && now - lastOwedRetryTick >= 15 * 60_000) {
      lastOwedRetryTick = now;
      const status = await readStatus();
      try {
        if (await automaticOwedRetryTick(status)) await saveStatus(status);
      } catch {
        const detail = "OWED_REWARD_RETRY_FAILED";
        status.services["solana-owed-reward-retry"] = { ok: false, updatedAt: Date.now(), detail };
        await Promise.all([saveStatus(status), saveHeartbeat("solana-owed-reward-retry", false, detail)]);
      }
    }
    if (!processed && now - lastPublicBalanceTick >= 60_000) {
      lastPublicBalanceTick = now;
      const status = await readStatus();
      try {
        if (await publishPublicBalances(status)) {
          await saveStatus(status);
          await saveHeartbeat("solana-public-snapshot", true);
        }
      }
      catch {
        status.governanceProposal = undefined;
        if (status.governance) status.governance.updatedAt = 0;
        await saveStatus(status);
        await saveHeartbeat("solana-public-snapshot", false, "PUBLIC_SNAPSHOT_FAILED");
      }
    }
    if (!processed && SOLANA_GOVERNANCE_EXECUTION_RELEASED && now - lastGovernanceWithdrawalTick >= 15_000) {
      lastGovernanceWithdrawalTick = now;
      const status = await readStatus();
      if (SOLANA_GOVERNANCE_RESERVE_WITHDRAWAL_RELEASED
        && status.launch.activated && status.launch.governanceBindState === "bound") {
        try {
          const ledger = await reconcileFreeWithdrawal(freeWithdrawalEnvironment(status));
          if (ledger && (!status.governanceWithdrawal || status.governanceWithdrawal.state !== ledger.state)) {
            status.governanceWithdrawal = withdrawalProgress(ledger);
            if (ledger.state === "finalized") {
              const verified = await verifyGovernanceReserveRoute(rpcUrls() as [string, string], {
                governanceProgram: required("SOLANA_GOVERNANCE_PROGRAM"),
                expectedProgramCodeSha256: required("SOLANA_GOVERNANCE_PROGRAM_CODE_SHA256"),
                reserveAuthority: required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"),
                reserveMint: required("SOLANA_MSTRX_MINT"),
                capitalMint: status.launch.detectedMint!,
                admin: required("SOLANA_ADMIN_OWNER"),
              });
              status.governance = governanceStatus(verified);
            }
            await saveStatus(status);
          }
        } catch {
          status.services["solana-governance-withdrawal"] = { ok: false, updatedAt: Date.now(), detail: "WITHDRAWAL_RECONCILIATION_FAILED" };
          await saveStatus(status);
        }
      }
    }
    if (!processed && SOLANA_GOVERNANCE_EXECUTION_RELEASED && now - lastGovernanceFinalizeTick >= 15_000) {
      lastGovernanceFinalizeTick = now;
      const status = await readStatus();
      if (SOLANA_GOVERNANCE_FINALIZE_RELEASED
        && status.launch.activated && status.launch.governanceBindState === "bound") {
        try {
          const ledger = await reconcileFinalizeVote(finalizeVoteEnvironment(status));
          if (ledger && (!status.governanceFinalization || status.governanceFinalization.state !== ledger.state)) {
            status.governanceFinalization = finalizationProgress(ledger);
            status.governanceProposal = undefined;
            if (status.governance) status.governance.updatedAt = 0;
            await saveStatus(status);
          }
        } catch {
          status.services["solana-governance-finalize"] = {
            ok: false, updatedAt: Date.now(), detail: "GOVERNANCE_FINALIZE_RECONCILIATION_FAILED",
          };
          await saveStatus(status);
        }
      }
    }
    if (!processed && SOLANA_GOVERNANCE_EXECUTION_RELEASED && now - lastGovernanceCreationTick >= 15_000) {
      lastGovernanceCreationTick = now;
      const status = await readStatus();
      if (SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED
        && status.launch.activated && status.launch.governanceBindState === "bound") {
        try {
          const ledger = await reconcileProposalControl(proposalControlEnvironment(status));
          if (ledger && (!status.governanceCreation || status.governanceCreation.state !== ledger.state)) {
            status.governanceCreation = proposalCreationProgress(ledger);
            status.governanceProposal = undefined;
            if (status.governance) status.governance.updatedAt = 0;
            await saveStatus(status);
          }
        } catch {
          status.services["solana-governance-proposal"] = {
            ok: false, updatedAt: Date.now(), detail: "GOVERNANCE_PROPOSAL_RECONCILIATION_FAILED",
          };
          await saveStatus(status);
        }
      }
    }
    if (!processed && SOLANA_GOVERNANCE_EXECUTION_RELEASED && now - lastGovernanceLockTick >= 15_000) {
      lastGovernanceLockTick = now;
      const status = await readStatus();
      if (SOLANA_GOVERNANCE_EXECUTION_RELEASED
        && status.launch.activated && status.launch.governanceBindState === "bound") {
        try {
          const ledger = await reconcileLockExecution(freeWithdrawalEnvironment(status));
          if (ledger && (!status.governanceLockExecution || status.governanceLockExecution.state !== ledger.state)) {
            status.governanceLockExecution = lockExecutionProgress(ledger);
            status.governanceProposal = undefined;
            if (status.governance) status.governance.updatedAt = 0;
            await saveStatus(status);
          }
        } catch {
          status.services["solana-governance-lock"] = {
            ok: false, updatedAt: Date.now(), detail: "GOVERNANCE_LOCK_RECONCILIATION_FAILED",
          };
          await saveStatus(status);
        }
      }
    }
    if (!processed && SOLANA_GOVERNANCE_EXECUTION_RELEASED && now - lastGovernanceBuybackTick >= 15_000) {
      lastGovernanceBuybackTick = now;
      const status = await readStatus();
      if (SOLANA_GOVERNANCE_EXECUTION_RELEASED
        && status.launch.activated && status.launch.governanceBindState === "bound") {
        try {
          const ledger = await reconcileBuybackExecution(freeWithdrawalEnvironment(status));
          if (ledger && (!status.governanceBuybackExecution || status.governanceBuybackExecution.state !== ledger.state)) {
            status.governanceBuybackExecution = buybackExecutionProgress(ledger);
            status.governanceProposal = undefined;
            if (status.governance) status.governance.updatedAt = 0;
            await saveStatus(status);
          }
        } catch {
          status.services["solana-governance-buyback"] = {
            ok: false, updatedAt: Date.now(), detail: "GOVERNANCE_BUYBACK_RECONCILIATION_FAILED",
          };
          await saveStatus(status);
        }
      }
    }
    if (!processed && SOLANA_GOVERNANCE_EXECUTION_RELEASED && now - lastGovernanceMarketingTick >= 15_000) {
      lastGovernanceMarketingTick = now;
      const status = await readStatus();
      if (SOLANA_GOVERNANCE_EXECUTION_RELEASED
        && status.launch.activated && status.launch.governanceBindState === "bound") {
        try {
          const ledger = await reconcileMarketingExecution(freeWithdrawalEnvironment(status));
          if (ledger && (!status.governanceMarketingExecution || status.governanceMarketingExecution.state !== ledger.state)) {
            status.governanceMarketingExecution = marketingExecutionProgress(ledger);
            status.governanceProposal = undefined;
            if (status.governance) status.governance.updatedAt = 0;
            await saveStatus(status);
          }
        } catch {
          status.services["solana-governance-marketing"] = {
            ok: false, updatedAt: Date.now(), detail: "GOVERNANCE_MARKETING_RECONCILIATION_FAILED",
          };
          await saveStatus(status);
        }
      }
    }
    if (!processed && SOLANA_GOVERNANCE_EXECUTION_RELEASED && now - lastGovernanceLockReleaseTick >= 15_000) {
      lastGovernanceLockReleaseTick = now;
      const status = await readStatus();
      if (SOLANA_GOVERNANCE_EXECUTION_RELEASED
        && status.launch.activated && status.launch.governanceBindState === "bound") {
        try {
          const ledger = await reconcileLockRelease(freeWithdrawalEnvironment(status));
          if (ledger && (!status.governanceLockRelease || status.governanceLockRelease.state !== ledger.state)) {
            status.governanceLockRelease = lockReleaseProgress(ledger);
            status.governanceProposal = undefined;
            if (status.governance) status.governance.updatedAt = 0;
            await saveStatus(status);
          }
        } catch {
          status.services["solana-governance-lock-release"] = {
            ok: false, updatedAt: Date.now(), detail: "GOVERNANCE_LOCK_RELEASE_RECONCILIATION_FAILED",
          };
          await saveStatus(status);
        }
      }
    }
    if (!processed) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
}

if (process.argv[1]?.endsWith("controlRunner.ts")) void main();

export { automaticFeeTick, automaticLaunchTick, automaticOwedRetryTick, automaticRewardTick, completeLaunchActivation, distinctFeeOwners, dispatch, markGovernanceBindPending, parkUnreleasedLaunch, processOnce };
