import "dotenv/config";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { ExtensionType, getAccount, getExtensionTypes, getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { buildCustomQuoteCreatorFeeSweepPlan, readCustomQuoteCreatorFeeBalances } from "./pumpFees";
import { verifyFixedMstrxPumpLaunch } from "./launchVerifier";
import { detectCreatorPumpLaunch } from "./launchDetector";
import { createMstrxAtaInstruction, createMstrxTransfer, mstrxAta, splitMstrx60_40 } from "./mstrxTransfers";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";
import { distributeRewardEpoch, finalizeRewardEpoch, loadCurrentRewardPlan, prepareRewardEpoch, type RewardPipelineEnvironment } from "./rewardPipeline";
import { loadKeypair, simulateAndSend } from "./transactions";

interface ControlRequest { id: string; network: string; action: string; signer: string; requestedAt: number }
interface ControlStatus {
  network: "solana-mainnet-beta";
  automationState: "running" | "stopped" | "unknown";
  launch: { configured: boolean; armed: boolean; armedAt?: number; detectedMint?: string; detectedSignature?: string; activated: boolean };
  services: Record<string, { ok: boolean; updatedAt: number; detail?: string }>;
  balances: { creatorMstrxRaw?: string; holderMstrxRaw?: string; reserveMstrxRaw?: string };
  conversionsPaused: boolean;
  rewardEpochOwnsPause?: boolean;
  updatedAt: number;
}

const controlRoot = resolve(process.env.CONTROL_DATA_ROOT || "data/control");
const requestRoot = resolve(controlRoot, "solana-requests");
const completedRoot = resolve(controlRoot, "solana-completed");
const failedRoot = resolve(controlRoot, "solana-failed");
const statusPath = resolve(controlRoot, "solana-status.json");

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function rpcUrls() { return [required("SOLANA_RPC_PRIMARY_URL"), required("SOLANA_RPC_FALLBACK_URL")]; }
function mstrxMint() { return new PublicKey(required("SOLANA_MSTRX_MINT")); }

function rewardEnvironment(status: ControlStatus): RewardPipelineEnvironment {
  const excluded = [
    required("SOLANA_CREATOR_PUBLIC_KEY"),
    required("SOLANA_OPERATOR_PUBLIC_KEY"),
    required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY"),
    required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"),
    required("SOLANA_RECOVERY_PUBLIC_KEY"),
    ...(process.env.SOLANA_EXCLUDED_HOLDER_ADDRESSES || "").split(",").map((value) => value.trim()).filter(Boolean),
  ];
  return {
    rpcUrls: rpcUrls() as [string, string],
    stateRoot: resolve(process.env.SOLANA_STATE_ROOT || "data/solana"),
    publicDataRoot: resolve(process.env.PUBLIC_DATA_ROOT || "data/public"),
    journalPath: resolve(required("SOLANA_HOLDER_JOURNAL_PATH")),
    capitalMint: status.launch.detectedMint || required("SOLANA_CAPITAL_MINT"),
    mstrxMint: required("SOLANA_MSTRX_MINT"),
    operatorKeypairPath: required("SOLANA_OPERATOR_KEYPAIR_PATH"),
    holderKeypairPath: required("SOLANA_HOLDER_SETTLEMENT_KEYPAIR_PATH"),
    excluded,
    minimumRawMstrx: BigInt(process.env.SOLANA_MIN_EPOCH_RAW_MSTRX || "100000"),
  };
}

async function readStatus(): Promise<ControlStatus> {
  try { return JSON.parse(await readFile(statusPath, "utf8")) as ControlStatus; } catch {
    return { network: "solana-mainnet-beta", automationState: "stopped", launch: { configured: false, armed: false, activated: false }, services: {}, balances: {}, conversionsPaused: false, updatedAt: 0 };
  }
}

async function saveStatus(status: ControlStatus) {
  status.updatedAt = Date.now();
  await mkdir(controlRoot, { recursive: true });
  await writeFile(statusPath, JSON.stringify(status, null, 2), { encoding: "utf8", mode: 0o600 });
}

async function saveHeartbeat(service: string, ok: boolean, detail?: string) {
  const root = resolve(process.env.PUBLIC_DATA_ROOT || "data/public", "status");
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, `${service}.json`), JSON.stringify({ service, ok, updatedAt: Date.now(), ...(detail ? { detail } : {}) }, null, 2), { encoding: "utf8", mode: 0o644, flush: true });
}

async function publishRuntimeConfig(status: ControlStatus, launchedAtSlot?: number) {
  if (!status.launch.detectedMint) throw new Error("DETECTED_MINT_REQUIRED");
  const mint = mstrxMint();
  const holder = new PublicKey(required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY"));
  const reserve = new PublicKey(required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"));
  const config = {
    network: "solana-mainnet-beta",
    projectMint: status.launch.detectedMint,
    mstrxMint: mint.toBase58(),
    creatorFeeRecipient: required("SOLANA_CREATOR_PUBLIC_KEY"),
    rewardVaultTokenAccount: mstrxAta(holder, mint).toBase58(),
    reserveVaultTokenAccount: mstrxAta(reserve, mint).toBase58(),
    ...(process.env.SOLANA_GOVERNANCE_PROGRAM?.trim() ? { governanceProgram: process.env.SOLANA_GOVERNANCE_PROGRAM.trim() } : {}),
    ...(process.env.SOLANA_MARKETING_PUBLIC_KEY?.trim() ? { marketingWallet: process.env.SOLANA_MARKETING_PUBLIC_KEY.trim() } : {}),
    ...(launchedAtSlot === undefined ? {} : { launchedAtSlot }),
  };
  const root = resolve(process.env.PUBLIC_DATA_ROOT || "data/public");
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "config.json"), JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o644, flush: true });
}

async function rawMstrxBalance(connection: Connection, owner: PublicKey) {
  return (await getAccount(connection, mstrxAta(owner, mstrxMint()), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
}

async function verifyPrelaunch(status: ControlStatus) {
  const urls = rpcUrls();
  const consensus = await finalizedConsensus(urls);
  const owner = new PublicKey(required("SOLANA_ADMIN_OWNER"));
  const creator = await loadKeypair(required("SOLANA_CREATOR_KEYPAIR_PATH"));
  const operator = await loadKeypair(required("SOLANA_OPERATOR_KEYPAIR_PATH"));
  const holder = await loadKeypair(required("SOLANA_HOLDER_SETTLEMENT_KEYPAIR_PATH"));
  const reserve = await loadKeypair(required("SOLANA_RESERVE_SETTLEMENT_KEYPAIR_PATH"));
  const recovery = new PublicKey(required("SOLANA_RECOVERY_PUBLIC_KEY"));
  if (!creator.publicKey.equals(new PublicKey(required("SOLANA_CREATOR_PUBLIC_KEY")))) throw new Error("CREATOR_KEYPAIR_MISMATCH");
  const expectedOperator = process.env.SOLANA_OPERATOR_PUBLIC_KEY?.trim();
  if (expectedOperator && !operator.publicKey.equals(new PublicKey(expectedOperator))) throw new Error("OPERATOR_KEYPAIR_MISMATCH");
  if (!holder.publicKey.equals(new PublicKey(required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY")))) throw new Error("HOLDER_KEYPAIR_MISMATCH");
  if (!reserve.publicKey.equals(new PublicKey(required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY")))) throw new Error("RESERVE_KEYPAIR_MISMATCH");
  if (holder.publicKey.equals(reserve.publicKey) || holder.publicKey.equals(recovery) || reserve.publicKey.equals(recovery)) throw new Error("OPERATIONAL_DESTINATION_DUPLICATE");
  if ([creator.publicKey, operator.publicKey, holder.publicKey, reserve.publicKey].some((key) => key.equals(owner))) throw new Error("OPERATIONAL_ROLE_NOT_ISOLATED");

  const snapshots = await Promise.all(urls.map(async (url) => {
    const mint = await getMint(new Connection(url, "finalized"), mstrxMint(), "finalized", TOKEN_2022_PROGRAM_ID);
    return { decimals: mint.decimals, extensions: getExtensionTypes(mint.tlvData).sort((a, b) => a - b) };
  }));
  const snapshot = requireMatchingValues(snapshots, "MSTRX_RPC_DISAGREEMENT");
  if (snapshot.decimals !== 8) throw new Error("MSTRX_DECIMALS_MISMATCH");
  if (snapshot.extensions.includes(ExtensionType.TransferFeeConfig)) throw new Error("MSTRX_TRANSFER_FEE_UNSUPPORTED");
  if (!snapshot.extensions.includes(ExtensionType.TransferHook)) throw new Error("MSTRX_TRANSFER_HOOK_EXPECTED");
  status.launch.configured = true;
  status.services["solana-control-runner"] = { ok: true, updatedAt: Date.now(), detail: `MSTRx custom-pair ready at finalized slot ${consensus.slot}` };
}

async function ensureFeeAtas(connection: Connection) {
  const operator = await loadKeypair(required("SOLANA_OPERATOR_KEYPAIR_PATH"));
  const creator = new PublicKey(required("SOLANA_CREATOR_PUBLIC_KEY"));
  const holder = new PublicKey(required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY"));
  const reserve = new PublicKey(required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"));
  const recovery = new PublicKey(required("SOLANA_RECOVERY_PUBLIC_KEY"));
  const destinations = [creator, holder, reserve, recovery];
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

async function routeCreatorMstrx(connection: Connection, rawAmount: bigint) {
  const operator = await loadKeypair(required("SOLANA_OPERATOR_KEYPAIR_PATH"));
  const creator = await loadKeypair(required("SOLANA_CREATOR_KEYPAIR_PATH"));
  const holder = new PublicKey(required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY"));
  const reserve = new PublicKey(required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY"));
  const available = await rawMstrxBalance(connection, creator.publicKey);
  if (rawAmount > available) throw new Error("COLLECTED_MSTRX_BALANCE_MISMATCH");
  const split = splitMstrx60_40(rawAmount);
  const holderTransfer = await createMstrxTransfer({ connection, sourceOwner: creator.publicKey, destinationOwner: holder, mint: mstrxMint(), rawAmount: split.holderRaw });
  const reserveTransfer = await createMstrxTransfer({ connection, sourceOwner: creator.publicKey, destinationOwner: reserve, mint: mstrxMint(), rawAmount: split.reserveRaw });
  const signature = await simulateAndSend({ connection, payer: operator, additionalSigners: [creator], instructions: [holderTransfer, reserveTransfer] });
  return { ...split, signature };
}

async function executeFeeSweep(status: ControlStatus, phase: "curve" | "pumpswap") {
  if (!status.launch.activated || status.conversionsPaused) throw new Error("AUTOMATION_NOT_ACTIVE");
  const connection = new Connection(required("SOLANA_RPC_PRIMARY_URL"), "confirmed");
  const operator = await loadKeypair(required("SOLANA_OPERATOR_KEYPAIR_PATH"));
  const ataSignature = await ensureFeeAtas(connection);
  const beforeRaw = await rawMstrxBalance(connection, new PublicKey(required("SOLANA_CREATOR_PUBLIC_KEY")));
  const vaults = await readCustomQuoteCreatorFeeBalances({
    rpcUrl: required("SOLANA_RPC_PRIMARY_URL"),
    creator: required("SOLANA_CREATOR_PUBLIC_KEY"),
    quoteMint: required("SOLANA_MSTRX_MINT"),
    quoteTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
  });
  const pendingRaw = phase === "curve" ? vaults.curveRaw : vaults.pumpSwapRaw;
  const minimumRaw = BigInt(process.env.SOLANA_MIN_SWEEP_RAW_MSTRX || "10000");
  if (pendingRaw < minimumRaw) return false;
  const plan = await buildCustomQuoteCreatorFeeSweepPlan({
    rpcUrl: required("SOLANA_RPC_PRIMARY_URL"),
    creator: required("SOLANA_CREATOR_PUBLIC_KEY"),
    quoteMint: required("SOLANA_MSTRX_MINT"),
    quoteTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    feePayer: operator.publicKey.toBase58(),
  });
  const instructions = phase === "curve" ? plan.curve : plan.pumpSwap;
  if (!instructions.length) throw new Error("NO_SWEEP_INSTRUCTION_AVAILABLE");
  const collectionSignature = await simulateAndSend({ connection, payer: operator, instructions });
  const afterRaw = await rawMstrxBalance(connection, new PublicKey(required("SOLANA_CREATOR_PUBLIC_KEY")));
  const collectedRaw = afterRaw - beforeRaw;
  if (collectedRaw <= 0n || collectedRaw > pendingRaw) throw new Error("PUMP_COLLECTION_DELTA_INVALID");
  const routed = await routeCreatorMstrx(connection, collectedRaw);
  status.balances.creatorMstrxRaw = (await rawMstrxBalance(connection, new PublicKey(required("SOLANA_CREATOR_PUBLIC_KEY")))).toString();
  status.balances.holderMstrxRaw = (await rawMstrxBalance(connection, new PublicKey(required("SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY")))).toString();
  status.balances.reserveMstrxRaw = (await rawMstrxBalance(connection, new PublicKey(required("SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY")))).toString();
  status.services["solana-fee-keeper"] = {
    ok: true,
    updatedAt: Date.now(),
    detail: `${phase}:ata=${ataSignature ?? "existing"}:collect=${collectionSignature}:route=${routed.signature}:gross=${routed.grossRaw}:holder=${routed.holderRaw}:reserve=${routed.reserveRaw}`,
  };
  await saveHeartbeat("solana-fee-keeper", true, status.services["solana-fee-keeper"].detail);
  return true;
}

async function activateLaunch(status: ControlStatus, mint: string, slot?: number, signature?: string) {
  const facts = await verifyFixedMstrxPumpLaunch({
    rpcUrls: rpcUrls(),
    mint,
    expectedCreator: required("SOLANA_CREATOR_PUBLIC_KEY"),
    expectedQuoteMint: required("SOLANA_MSTRX_MINT"),
  });
  status.launch.detectedMint = facts.mint;
  status.launch.detectedSignature = signature;
  status.launch.activated = true;
  status.launch.armed = false;
  status.automationState = "running";
  await ensureFeeAtas(new Connection(required("SOLANA_RPC_PRIMARY_URL"), "confirmed"));
  await publishRuntimeConfig(status, slot);
  status.services["solana-launch-detector"] = { ok: true, updatedAt: Date.now(), detail: `${facts.mint}:${signature ?? "manual"}` };
  await saveHeartbeat("solana-launch-detector", true, status.services["solana-launch-detector"].detail);
}

async function automaticLaunchTick(status: ControlStatus) {
  if (!status.launch.armed || status.launch.activated || !status.launch.armedAt) return false;
  const candidate = await detectCreatorPumpLaunch({
    rpcUrl: required("SOLANA_RPC_PRIMARY_URL"),
    creator: required("SOLANA_CREATOR_PUBLIC_KEY"),
    armedAtMs: status.launch.armedAt,
  });
  if (!candidate) return false;
  await activateLaunch(status, candidate.mint, candidate.slot, candidate.signature);
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
  }

  const distributed = await distributeRewardEpoch(environment);
  const confirmed = distributed.batches.filter((batch) => batch.state === "confirmed").length;
  status.services["solana-distributor"] = { ok: true, updatedAt: Date.now(), detail: `epoch ${distributed.epochId}:${confirmed}/${distributed.batches.length} batches` };
  await saveHeartbeat("solana-distributor", true, status.services["solana-distributor"].detail);
  const finalized = await finalizeRewardEpoch(environment);
  status.services["solana-distributor"] = { ok: true, updatedAt: Date.now(), detail: `finalized epoch ${finalized.epochId}:${finalized.fundedRawMstrx} raw MSTRx` };
  await saveHeartbeat("solana-distributor", true, status.services["solana-distributor"].detail);
  if (status.rewardEpochOwnsPause) { status.conversionsPaused = false; status.rewardEpochOwnsPause = false; }
  return true;
}

async function recoverCreatorMstrx(status: ControlStatus) {
  if (!status.conversionsPaused) throw new Error("PAUSE_REQUIRED");
  const connection = new Connection(required("SOLANA_RPC_PRIMARY_URL"), "confirmed");
  const operator = await loadKeypair(required("SOLANA_OPERATOR_KEYPAIR_PATH"));
  const creator = await loadKeypair(required("SOLANA_CREATOR_KEYPAIR_PATH"));
  const recovery = new PublicKey(required("SOLANA_RECOVERY_PUBLIC_KEY"));
  await ensureFeeAtas(connection);
  const amount = await rawMstrxBalance(connection, creator.publicKey);
  const transfer = await createMstrxTransfer({ connection, sourceOwner: creator.publicKey, destinationOwner: recovery, mint: mstrxMint(), rawAmount: amount });
  const signature = await simulateAndSend({ connection, payer: operator, additionalSigners: [creator], instructions: [transfer] });
  status.balances.creatorMstrxRaw = "0";
  status.services["solana-fee-keeper"] = { ok: true, updatedAt: Date.now(), detail: `recovered-uncommitted:${amount}:${signature}` };
}

async function dispatch(request: ControlRequest, status: ControlStatus) {
  if (request.network !== "solana-mainnet-beta" || request.signer !== required("SOLANA_ADMIN_OWNER")) throw new Error("REQUEST_SIGNER_INVALID");
  switch (request.action) {
    case "verify_launch_config": await verifyPrelaunch(status); break;
    case "arm_launch_detection": if (!status.launch.configured) throw new Error("LAUNCH_NOT_CONFIGURED"); status.launch.armed = true; status.launch.armedAt = Date.now(); break;
    case "disarm_launch_detection": status.launch.armed = false; status.launch.armedAt = undefined; break;
    case "activate_postlaunch": {
      if (!status.launch.armed) throw new Error("DETECTOR_NOT_ARMED");
      await activateLaunch(status, status.launch.detectedMint || required("SOLANA_CAPITAL_MINT"));
      break;
    }
    case "sweep_curve_fees": await executeFeeSweep(status, "curve"); break;
    case "sweep_pumpswap_fees": await executeFeeSweep(status, "pumpswap"); break;
    case "pause_conversions": status.conversionsPaused = true; break;
    case "resume_conversions": if (!status.launch.configured) throw new Error("LAUNCH_NOT_CONFIGURED"); status.conversionsPaused = false; break;
    case "recover_uncommitted": await recoverCreatorMstrx(status); break;
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
  const names = (await readdir(requestRoot)).filter((name) => /^\d+-[a-f0-9]+\.json$/.test(name)).sort();
  if (!names.length) return false;
  const name = names[0];
  const source = resolve(requestRoot, name);
  if (!source.startsWith(`${requestRoot}${sep}`)) throw new Error("REQUEST_PATH_INVALID");
  const request = JSON.parse(await readFile(source, "utf8")) as ControlRequest;
  const status = await readStatus();
  try {
    await dispatch(request, status);
    await rename(source, resolve(completedRoot, name));
  } catch (error) {
    const failure = { ...request, failedAt: Date.now(), error: error instanceof Error ? error.message : "UNKNOWN" };
    await writeFile(resolve(failedRoot, name), JSON.stringify(failure, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(source, resolve(failedRoot, `${name}.request`));
  }
  return true;
}

async function main() {
  let lastLaunchTick = 0;
  let lastFeeTick = 0;
  let lastRewardTick = 0;
  while (true) {
    const processed = await processOnce();
    const now = Date.now();
    if (!processed && now - lastLaunchTick >= Number(process.env.SOLANA_LAUNCH_DETECT_INTERVAL_MS || "2000")) {
      lastLaunchTick = now;
      const status = await readStatus();
      try {
        if (await automaticLaunchTick(status)) await saveStatus(status);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "UNKNOWN";
        status.services["solana-launch-detector"] = { ok: false, updatedAt: Date.now(), detail };
        await Promise.all([saveStatus(status), saveHeartbeat("solana-launch-detector", false, detail)]);
      }
    }
    if (!processed && now - lastFeeTick >= Number(process.env.SOLANA_FEE_SWEEP_INTERVAL_MS || "30000")) {
      lastFeeTick = now;
      const status = await readStatus();
      try {
        if (await automaticFeeTick(status)) await saveStatus(status);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "UNKNOWN";
        status.services["solana-fee-keeper"] = { ok: false, updatedAt: Date.now(), detail };
        await Promise.all([saveStatus(status), saveHeartbeat("solana-fee-keeper", false, detail)]);
      }
    }
    if (!processed && now - lastRewardTick >= Number(process.env.SOLANA_REWARD_TICK_MS || "15000")) {
      lastRewardTick = now;
      const status = await readStatus();
      try {
        if (await automaticRewardTick(status)) await saveStatus(status);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "UNKNOWN";
        status.services["solana-distributor"] = { ok: false, updatedAt: Date.now(), detail };
        await Promise.all([saveStatus(status), saveHeartbeat("solana-distributor", false, detail)]);
      }
    }
    if (!processed) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
}

if (process.argv[1]?.endsWith("controlRunner.ts")) void main();

export { automaticFeeTick, automaticLaunchTick, automaticRewardTick, dispatch, processOnce };
