import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { AccountState, ExtensionType, createInitializeAccount3Instruction, createTransferCheckedWithTransferHookInstruction, getAccount, getAccountLen, getAccountLenForMint, getAccountTypeOfMintType, getExtensionTypes, getMint, getDefaultAccountState, getPausableConfig, getTransferFeeConfig, getTransferHook, unpackAccount, TOKEN_2022_PROGRAM_ID, type Account, type Mint } from "@solana/spl-token";
import { assertFinalizedFullBlockCoverage, assertRewardPlanHash, buildRewardEpochPlan, owedEscrowSeed, type FinalizedHolderJournal, type RewardEpochPlan, type RewardSignedStep } from "./epochPlanner";
import { MSTRX_DECIMALS, createMstrxAtaInstruction, createMstrxTransfer, mstrxAta } from "./mstrxTransfers";
import { assertIndependentRpcProviders, finalizedConsensus, requireMatchingValues } from "./rpcConsensus";
import { broadcastPreparedTransaction, loadKeypair } from "./transactions";
import { readAgreedFinalizedTransaction, tokenAccountDelta } from "./finalizedTransfers";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { assertReadableTransactionVersion, MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION } from "./rpcTransactionVersion";

export interface RewardPipelineEnvironment {
  rpcUrls: readonly [string, string];
  stateRoot: string;
  publicDataRoot: string;
  journalPath: string;
  capitalMint: string;
  mstrxMint: string;
  operatorKeypairPath: string;
  holderKeypairPath: string;
  excluded: string[];
  minimumRawMstrx?: bigint;
}

interface RewardLaunchConfig {
  network?: string;
  projectMint?: string;
  launchedAtSlot?: number;
  launchedAtSignature?: string;
}

export function assertRewardLaunchBinding(
  subject: Pick<FinalizedHolderJournal, "capitalMint" | "launchSignature" | "coverage">,
  config: RewardLaunchConfig,
) {
  if (config?.network !== "solana-mainnet-beta"
    || !Number.isSafeInteger(config.launchedAtSlot) || (config.launchedAtSlot ?? 0) <= 0
    || typeof config.launchedAtSignature !== "string" || !config.launchedAtSignature
    || subject.coverage?.fromSlot !== config.launchedAtSlot
    || subject.launchSignature !== config.launchedAtSignature) {
    throw new Error("REWARD_LAUNCH_BINDING_MISMATCH");
  }
  try {
    if (new PublicKey(subject.capitalMint).toBase58() !== new PublicKey(config.projectMint ?? "").toBase58()) {
      throw new Error("REWARD_LAUNCH_BINDING_MISMATCH");
    }
  } catch {
    throw new Error("REWARD_LAUNCH_BINDING_MISMATCH");
  }
  return true;
}

async function loadRewardLaunchConfig(environment: RewardPipelineEnvironment) {
  const config = JSON.parse(await readFile(resolve(environment.publicDataRoot, "config.json"), "utf8")) as RewardLaunchConfig;
  return config;
}

interface HolderIndexerHeartbeat {
  service: string;
  ok: boolean;
  updatedAt: number;
}

export function assertHolderJournalReady(args: {
  journal: FinalizedHolderJournal;
  previous?: Pick<RewardEpochPlan, "epochId" | "windowEnd" | "finalized">;
  heartbeat: HolderIndexerHeartbeat;
  latestFinalizedTime: number;
  nowMs: number;
}) {
  const { journal, previous, heartbeat, latestFinalizedTime, nowMs } = args;
  assertHolderJournalProvenance(journal);
  if (heartbeat.service !== "solana-holder-indexer" || heartbeat.ok !== true || !Number.isSafeInteger(heartbeat.updatedAt)
    || heartbeat.updatedAt > nowMs + 60_000 || nowMs - heartbeat.updatedAt > 15 * 60_000) {
    throw new Error("HOLDER_INDEXER_UNHEALTHY");
  }
  if (!Number.isSafeInteger(journal.windowEnd) || !Number.isSafeInteger(latestFinalizedTime)
    || journal.windowEnd > latestFinalizedTime || latestFinalizedTime - journal.windowEnd > 30 * 60) {
    throw new Error("HOLDER_JOURNAL_STALE");
  }
  if (previous && (previous.finalized !== true || BigInt(journal.epochId) !== BigInt(previous.epochId) + 1n
    || journal.windowStart !== previous.windowEnd)) {
    throw new Error("HOLDER_JOURNAL_EPOCH_NOT_ADVANCED");
  }
}

export function assertHolderJournalProvenance(journal: FinalizedHolderJournal) {
  if (journal.version !== 3) throw new Error("HOLDER_JOURNAL_VERSION_UNSUPPORTED");
  assertFinalizedFullBlockCoverage(journal.coverage, journal.finalizedThroughSlot, journal.finalizedBlockhash);
}

function currentPlanPath(environment: RewardPipelineEnvironment) {
  return resolve(environment.stateRoot, "reward-epochs", "current.json");
}

async function savePlan(environment: RewardPipelineEnvironment, plan: RewardEpochPlan) {
  await writeDurableJson(currentPlanPath(environment), plan);
}

function owedLedgerPath(environment: RewardPipelineEnvironment, epochId: string) {
  return resolve(environment.stateRoot, "reward-epochs", `owed-epoch-${epochId}.json`);
}

function archivedPlanPath(environment: RewardPipelineEnvironment, epochId: string) {
  return resolve(environment.stateRoot, "reward-epochs", `plan-epoch-${epochId}.json`);
}

function owedPublicPath(environment: RewardPipelineEnvironment, epochId: string) {
  return resolve(environment.publicDataRoot, "snapshots", `solana-owed-epoch-${epochId}.json`);
}

async function assertOwedEscrowIdentity(environment: RewardPipelineEnvironment, plan: RewardEpochPlan) {
  const holder = await loadKeypair(environment.holderKeypairPath);
  if (plan.owedEscrow.owner !== holder.publicKey.toBase58()) throw new Error("REWARD_OWED_ESCROW_OWNER_MISMATCH");
  const derived = await PublicKey.createWithSeed(holder.publicKey, plan.owedEscrow.seed, TOKEN_2022_PROGRAM_ID);
  if (derived.toBase58() !== plan.owedEscrow.address || derived.equals(mstrxAta(holder.publicKey, new PublicKey(environment.mstrxMint)))) {
    throw new Error("REWARD_OWED_ESCROW_ADDRESS_MISMATCH");
  }
}

export async function loadCurrentRewardPlan(environment: RewardPipelineEnvironment) {
  const plan = JSON.parse(await readFile(currentPlanPath(environment), "utf8")) as RewardEpochPlan;
  assertRewardPlanHash(plan);
  assertRewardLaunchBinding(plan, await loadRewardLaunchConfig(environment));
  if (plan.mstrxMint !== environment.mstrxMint) throw new Error("REWARD_PLAN_ASSET_MISMATCH");
  await assertOwedEscrowIdentity(environment, plan);
  return plan;
}

async function verifyJournalFinality(environment: RewardPipelineEnvironment, journal: FinalizedHolderJournal) {
  const consensus = await finalizedConsensus(environment.rpcUrls);
  if (journal.finalizedThroughSlot > consensus.slot) throw new Error("HOLDER_JOURNAL_AHEAD_OF_FINALITY");
  const blocks = await Promise.all(environment.rpcUrls.map(async (url) => {
    const block = await new Connection(url, "finalized").getBlock(journal.finalizedThroughSlot, {
      commitment: "finalized",
      transactionDetails: "none",
      rewards: false,
      maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
    });
    if (!block || block.blockTime === null) throw new Error("HOLDER_FINALITY_BLOCK_MISSING");
    return { blockhash: block.blockhash, blockTime: block.blockTime };
  }));
  const block = requireMatchingValues(blocks, "HOLDER_FINALITY_RPC_DISAGREEMENT");
  if (block.blockhash !== journal.finalizedBlockhash || block.blockTime !== journal.windowEnd) throw new Error("HOLDER_FINALITY_BLOCKHASH_MISMATCH");
  const latestBlocks = await Promise.all(environment.rpcUrls.map(async (url) => {
    const latest = await new Connection(url, "finalized").getBlock(consensus.slot, {
      commitment: "finalized", transactionDetails: "none", rewards: false,
      maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
    });
    if (!latest || latest.blockTime === null) throw new Error("HOLDER_LATEST_FINALITY_BLOCK_MISSING");
    return { blockhash: latest.blockhash, blockTime: latest.blockTime };
  }));
  const latest = requireMatchingValues(latestBlocks, "HOLDER_LATEST_FINALITY_RPC_DISAGREEMENT");
  if (latest.blockhash !== consensus.blockhash) throw new Error("HOLDER_LATEST_FINALITY_BLOCKHASH_MISMATCH");
  return latest.blockTime;
}

export function submittedBatchRetryDecision(args: {
  statuses: readonly ({ err: unknown } | null)[];
  finalizedHeights: readonly number[];
  lastValidBlockHeight: number;
}): "rebroadcast-same-transaction" | "wait-for-finality" {
  const { statuses, finalizedHeights, lastValidBlockHeight } = args;
  if (statuses.length !== 2 || finalizedHeights.length !== 2 || !Number.isSafeInteger(lastValidBlockHeight)
    || finalizedHeights.some((height) => !Number.isSafeInteger(height))) {
    throw new Error("REWARD_BATCH_RPC_EVIDENCE_INVALID");
  }
  if (statuses.some((status) => status?.err)) throw new Error("REWARD_BATCH_ONCHAIN_FAILURE");
  // A null status from two providers is not proof that a transaction was never
  // finalized: both can be pruned, unavailable or lagging. Never clear its
  // durable signed bytes and re-sign the same allocations with a fresh hash.
  if (finalizedHeights.every((height) => height > lastValidBlockHeight + 32)) {
    throw new Error("REWARD_BATCH_OUTCOME_UNPROVEN");
  }
  if (finalizedHeights.every((height) => height <= lastValidBlockHeight)) {
    return "rebroadcast-same-transaction";
  }
  return "wait-for-finality";
}

export function requiredOperatorPayoutLamports(rentPerAta: bigint, possibleNewAtas: number) {
  if (rentPerAta < 0n || !Number.isSafeInteger(possibleNewAtas) || possibleNewAtas < 0) {
    throw new Error("REWARD_OPERATOR_BUDGET_INPUT_INVALID");
  }
  // The instructions below do not request a priority fee. This floor covers
  // base transaction fees and leaves an operational margin after worst-case
  // ATA rent, even when every recipient's ATA must be created.
  return rentPerAta * BigInt(possibleNewAtas) + 1_000_000n;
}

interface RewardMintSafetySnapshot {
  initialized: boolean;
  decimals: number;
  hookProgram: string | null;
  hasTransferFee: boolean;
  paused: boolean;
  defaultAccountState: AccountState | null;
  extensionHash: string;
  escrowAccountLength: number;
  ataAccountLength: number;
}

export function rewardMintSafetySnapshot(mint: Mint): RewardMintSafetySnapshot {
  const accountExtensions = getExtensionTypes(mint.tlvData).map(getAccountTypeOfMintType);
  return {
    initialized: mint.isInitialized,
    decimals: mint.decimals,
    hookProgram: getTransferHook(mint)?.programId.toBase58() ?? null,
    hasTransferFee: getTransferFeeConfig(mint) !== null,
    paused: getPausableConfig(mint)?.paused === true,
    defaultAccountState: getDefaultAccountState(mint)?.state ?? null,
    extensionHash: createHash("sha256").update(mint.tlvData).digest("hex"),
    escrowAccountLength: getAccountLenForMint(mint),
    ataAccountLength: getAccountLen([...accountExtensions, ExtensionType.ImmutableOwner]),
  };
}

export function assertRewardMintCanPush(snapshot: RewardMintSafetySnapshot) {
  if (!snapshot.initialized || snapshot.decimals !== MSTRX_DECIMALS) throw new Error("REWARD_MSTRX_MINT_INVALID");
  // The deployed MSTRx has a disabled transfer hook. A future live hook, fee,
  // freeze-default or pause changes the transfer semantics and requires a new
  // reviewed rehearsal rather than silently changing payout instructions.
  if (snapshot.hookProgram !== PublicKey.default.toBase58() || snapshot.hasTransferFee
    || snapshot.paused || snapshot.defaultAccountState !== AccountState.Initialized) {
    throw new Error("REWARD_MSTRX_TRANSFER_SEMANTICS_UNSUPPORTED");
  }
  if (!Number.isSafeInteger(snapshot.escrowAccountLength) || snapshot.escrowAccountLength <= 0
    || !Number.isSafeInteger(snapshot.ataAccountLength) || snapshot.ataAccountLength <= 0) {
    throw new Error("REWARD_MSTRX_ACCOUNT_LENGTH_INVALID");
  }
}

async function readAgreedRewardMint(environment: RewardPipelineEnvironment, mint: PublicKey) {
  assertIndependentRpcProviders(environment.rpcUrls);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const mintState = await getMint(new Connection(url, "finalized"), mint, "finalized", TOKEN_2022_PROGRAM_ID);
    return rewardMintSafetySnapshot(mintState);
  }));
  const agreed = requireMatchingValues(observations, "REWARD_MSTRX_MINT_RPC_DISAGREEMENT");
  assertRewardMintCanPush(agreed);
  return agreed;
}

async function assertOperatorPayoutBudget(
  environment: RewardPipelineEnvironment, operator: PublicKey, mint: PublicKey, possibleNewAtas: number,
) {
  const mintState = await readAgreedRewardMint(environment, mint);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [balance, rentPerAta] = await Promise.all([
      connection.getBalance(operator, "finalized"),
      connection.getMinimumBalanceForRentExemption(mintState.ataAccountLength, "finalized"),
    ]);
    return { balance, rentPerAta };
  }));
  const agreed = requireMatchingValues(observations, "REWARD_OPERATOR_SOL_RPC_DISAGREEMENT");
  const required = requiredOperatorPayoutLamports(BigInt(agreed.rentPerAta), possibleNewAtas);
  if (BigInt(agreed.balance) < required) throw new Error("REWARD_OPERATOR_SOL_BELOW_REQUIRED");
}

export async function prepareRewardEpoch(environment: RewardPipelineEnvironment) {
  let previous: RewardEpochPlan | undefined;
  try {
    previous = await loadCurrentRewardPlan(environment);
    if (!previous.finalized) throw new Error("REWARD_EPOCH_ALREADY_ACTIVE");
  } catch (error) {
    if (error instanceof Error && error.message === "REWARD_EPOCH_ALREADY_ACTIVE") throw error;
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const journal = JSON.parse(await readFile(environment.journalPath, "utf8")) as FinalizedHolderJournal;
  assertHolderJournalProvenance(journal);
  assertRewardLaunchBinding(journal, await loadRewardLaunchConfig(environment));
  if (new PublicKey(journal.capitalMint).toBase58() !== new PublicKey(environment.capitalMint).toBase58()) throw new Error("HOLDER_JOURNAL_MINT_MISMATCH");
  const latestFinalizedTime = await verifyJournalFinality(environment, journal);
  let heartbeat: HolderIndexerHeartbeat;
  try {
    heartbeat = JSON.parse(await readFile(resolve(environment.publicDataRoot, "status", "solana-holder-indexer.json"), "utf8")) as HolderIndexerHeartbeat;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error("HOLDER_INDEXER_HEARTBEAT_MISSING");
    throw error;
  }
  assertHolderJournalReady({ journal, previous, heartbeat, latestFinalizedTime, nowMs: Date.now() });
  const holder = await loadKeypair(environment.holderKeypairPath);
  const mint = new PublicKey(environment.mstrxMint);
  await readAgreedRewardMint(environment, mint);
  await assertAllOwedEscrowsBacked(environment);
  const amounts = await Promise.all(environment.rpcUrls.map(async (url) => {
    const source = await getAccount(new Connection(url, "finalized"), mstrxAta(holder.publicKey, mint), "finalized", TOKEN_2022_PROGRAM_ID);
    return source.amount.toString();
  }));
  const fundedRawMstrx = BigInt(requireMatchingValues(amounts, "HOLDER_FUNDING_RPC_DISAGREEMENT"));
  if (fundedRawMstrx < (environment.minimumRawMstrx ?? 1n)) throw new Error("HOLDER_INVENTORY_BELOW_MINIMUM");
  const escrowSeed = owedEscrowSeed(journal.capitalMint, BigInt(journal.epochId));
  const owedEscrowAddress = await PublicKey.createWithSeed(holder.publicKey, escrowSeed, TOKEN_2022_PROGRAM_ID);
  const plan = buildRewardEpochPlan({
    epochId: BigInt(journal.epochId),
    journal,
    fundedRawMstrx,
    excluded: environment.excluded,
    mstrxMint: environment.mstrxMint,
    owedEscrowOwner: holder.publicKey.toBase58(),
    owedEscrowAddress: owedEscrowAddress.toBase58(),
    batchSize: 3,
  });
  await savePlan(environment, plan);
  return plan;
}

type RewardBatch = RewardEpochPlan["batches"][number];
type RewardAllocation = RewardBatch["allocations"][number];
type Delivery = NonNullable<RewardAllocation["delivery"]>;

/** Requires a reviewed mainnet MSTRx Token-2022 hook/rent rehearsal before enabling new owed obligations. */
export const OWED_ESCROW_RELEASED = false;

export function assertOwedEscrowReleased() {
  if (!OWED_ESCROW_RELEASED) throw new Error("REWARD_OWED_ESCROW_UNRELEASED");
}

interface OwedReceipt {
  recipient: string;
  rawMstrx: string;
  escrowSignature: string;
  originalFailure: NonNullable<Delivery["rejection"]>;
  state: "owed" | "paid";
  ata: RewardSignedStep;
  transfer: RewardSignedStep;
  attempts: Array<{ stage: "ata" | "transfer"; evidence: "simulation" | "finalized"; signature?: string }>;
  retryCount: number;
  nextRetryAt: number;
}

interface OwedEpochLedger {
  version: 1;
  epochId: string;
  planHash: string;
  mstrxMint: string;
  escrowOwner: string;
  escrowAddress: string;
  fundedRawMstrx: string;
  originallyOwedRawMstrx: string;
  receipts: OwedReceipt[];
  deliveryEvents: Array<{
    recipient: string;
    rawMstrx: string;
    signature: string;
    finalizedSlot: number;
    finalizedBlockhash: string;
  }>;
}

function isDefiniteSimulationRejection(error: unknown) {
  return error instanceof Error && error.message === "REWARD_TRANSACTION_SIMULATION_REJECTED";
}

export function classifyRewardSimulations(errors: readonly unknown[]) {
  if (errors.length !== 2) throw new Error("REWARD_SIMULATION_UNCERTAIN");
  const [first, second] = errors;
  if (first == null && second == null) return "accepted" as const;
  if (first && second && JSON.stringify(first) === JSON.stringify(second)
    && typeof first === "object" && "InstructionError" in first) {
    return "rejected" as const;
  }
  throw new Error("REWARD_SIMULATION_UNCERTAIN");
}

async function prepareDualRpcRewardTransaction(environment: RewardPipelineEnvironment, args: {
  payer: Keypair;
  instructions: readonly TransactionInstruction[];
  additionalSigners?: readonly Keypair[];
}) {
  if (!args.instructions.length) throw new Error("REWARD_TRANSACTION_EMPTY");
  assertIndependentRpcProviders(environment.rpcUrls);
  let latest: Awaited<ReturnType<Connection["getLatestBlockhash"]>>;
  try {
    latest = await new Connection(environment.rpcUrls[0], "confirmed").getLatestBlockhash("confirmed");
  } catch {
    throw new Error("REWARD_BLOCKHASH_UNAVAILABLE");
  }
  const message = new TransactionMessage({
    payerKey: args.payer.publicKey, recentBlockhash: latest.blockhash, instructions: [...args.instructions],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([args.payer, ...(args.additionalSigners ?? [])]);
  let simulations: Awaited<ReturnType<Connection["simulateTransaction"]>>[];
  try {
    simulations = await Promise.all(environment.rpcUrls.map((url) =>
      new Connection(url, "confirmed").simulateTransaction(transaction, { commitment: "confirmed", sigVerify: true }),
    ));
  } catch {
    throw new Error("REWARD_SIMULATION_UNCERTAIN");
  }
  if (classifyRewardSimulations(simulations.map((simulation) => simulation.value.err)) === "rejected") {
    throw new Error("REWARD_TRANSACTION_SIMULATION_REJECTED");
  }
  return {
    signature: bs58.encode(transaction.signatures[0]),
    transactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

async function readAgreedFinalizedFailure(
  rpcUrls: readonly [string, string], signature: string,
): Promise<{ signature: string; slot: number; blockhash: string } | undefined> {
  assertIndependentRpcProviders(rpcUrls);
  const observations = await Promise.all(rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const transaction = await connection.getParsedTransaction(signature, {
      commitment: "finalized", maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
    });
    if (!transaction) return undefined;
    assertReadableTransactionVersion(transaction.version);
    if (!transaction.meta) throw new Error("REWARD_TRANSACTION_META_MISSING");
    const block = await connection.getBlock(transaction.slot, {
      commitment: "finalized", transactionDetails: "none", rewards: false,
      maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
    });
    if (!block) throw new Error("REWARD_TRANSACTION_BLOCK_MISSING");
    return { signature, slot: transaction.slot, blockhash: block.blockhash, error: transaction.meta.err };
  }));
  if (observations.some((observation) => !observation)) return undefined;
  const agreed = requireMatchingValues(observations as NonNullable<typeof observations[number]>[], "REWARD_TRANSACTION_RPC_DISAGREEMENT");
  return agreed.error ? { signature, slot: agreed.slot, blockhash: agreed.blockhash } : undefined;
}

async function readAgreedEscrowAccount(
  environment: RewardPipelineEnvironment, address: string, expectedOwner: string,
  minimumFinalizedSlot = 0, requireIsolatedCustody = false,
) {
  assertIndependentRpcProviders(environment.rpcUrls);
  const agreedHead = await finalizedConsensus(environment.rpcUrls);
  const minContextSlot = Math.max(agreedHead.slot, minimumFinalizedSlot);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const key = new PublicKey(address);
    const response = await connection.getAccountInfoAndContext(key, { commitment: "finalized", minContextSlot });
    if (response.context.slot < minContextSlot) throw new Error("REWARD_OWED_ESCROW_ACCOUNT_STALE");
    const account = unpackAccount(key, response.value, TOKEN_2022_PROGRAM_ID);
    if (requireIsolatedCustody) assertOwedEscrowAccountUsable(account, environment.mstrxMint, expectedOwner);
    return { mint: account.mint.toBase58(), owner: account.owner.toBase58(), amount: account.amount.toString() };
  }));
  const account = requireMatchingValues(observations, "REWARD_OWED_ESCROW_RPC_DISAGREEMENT");
  if (account.mint !== environment.mstrxMint || account.owner !== expectedOwner) throw new Error("REWARD_OWED_ESCROW_ACCOUNT_MISMATCH");
  return BigInt(account.amount);
}

export function assertOwedEscrowAccountUsable(account: Pick<Account,
  "mint" | "owner" | "isInitialized" | "isFrozen" | "delegate" | "delegatedAmount" | "closeAuthority"
>, expectedMint: string, expectedOwner: string) {
  if (account.mint.toBase58() !== expectedMint || account.owner.toBase58() !== expectedOwner
    || !account.isInitialized || account.isFrozen || account.delegate !== null
    || account.delegatedAmount !== 0n || account.closeAuthority !== null) {
    throw new Error("REWARD_OWED_ESCROW_ACCOUNT_UNSAFE");
  }
}

function assertOwedLedgerShape(ledger: OwedEpochLedger) {
  if (ledger.version !== 1 || !/^\d+$/.test(ledger.epochId) || !/^[a-f0-9]{64}$/.test(ledger.planHash)
    || !ledger.escrowAddress || !ledger.escrowOwner || !Array.isArray(ledger.receipts)
    || !Array.isArray(ledger.deliveryEvents)) {
    throw new Error("REWARD_OWED_LEDGER_INVALID");
  }
  const identities = new Set<string>();
  let original = 0n;
  for (const receipt of ledger.receipts) {
    if (identities.has(receipt.recipient) || !receipt.escrowSignature || BigInt(receipt.rawMstrx) <= 0n
      || !receipt.originalFailure || !["owed", "paid"].includes(receipt.state)
      || !Array.isArray(receipt.attempts) || !Number.isSafeInteger(receipt.retryCount)
      || receipt.retryCount < 0 || !Number.isSafeInteger(receipt.nextRetryAt)
      || receipt.nextRetryAt < 0 || receipt.attempts.length > 32) {
      throw new Error("REWARD_OWED_LEDGER_INVALID");
    }
    if (receipt.state === "paid" && (receipt.transfer.state !== "confirmed" || !receipt.transfer.signature)) {
      throw new Error("REWARD_OWED_PAID_RECEIPT_INVALID");
    }
    if (receipt.state === "owed" && receipt.transfer.state === "confirmed") throw new Error("REWARD_OWED_LEDGER_INVALID");
    identities.add(receipt.recipient);
    original += BigInt(receipt.rawMstrx);
  }
  if (original !== BigInt(ledger.originallyOwedRawMstrx) || original > BigInt(ledger.fundedRawMstrx)) {
    throw new Error("REWARD_OWED_LEDGER_NOT_CONSERVED");
  }
  const delivered = new Set<string>();
  for (const event of ledger.deliveryEvents) {
    const receipt = ledger.receipts.find((row) => row.recipient === event.recipient);
    if (!receipt || delivered.has(event.recipient) || event.rawMstrx !== receipt.rawMstrx
      || !Number.isSafeInteger(event.finalizedSlot) || event.finalizedSlot <= 0
      || !event.finalizedBlockhash || event.signature !== receipt.transfer.signature
      || receipt.state !== "paid") {
      throw new Error("REWARD_OWED_DELIVERY_EVENT_INVALID");
    }
    delivered.add(event.recipient);
  }
  if (ledger.receipts.some((receipt) => receipt.state === "paid" && !delivered.has(receipt.recipient))) {
    throw new Error("REWARD_OWED_DELIVERY_EVENT_MISSING");
  }
}

async function readOwedLedgers(environment: RewardPipelineEnvironment) {
  const directory = resolve(environment.stateRoot, "reward-epochs");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const ledgers: OwedEpochLedger[] = [];
  for (const name of names.filter((value) => /^owed-epoch-\d+\.json$/.test(value)).sort()) {
    const ledger = JSON.parse(await readFile(resolve(directory, name), "utf8")) as OwedEpochLedger;
    assertOwedLedgerShape(ledger);
    if (name !== `owed-epoch-${ledger.epochId}.json` || ledger.mstrxMint !== environment.mstrxMint) throw new Error("REWARD_OWED_LEDGER_IDENTITY_MISMATCH");
    const archive = await readJsonIfExists<RewardEpochPlan>(archivedPlanPath(environment, ledger.epochId));
    if (!archive) throw new Error("REWARD_OWED_PLAN_ARCHIVE_MISSING");
    assertRewardPlanHash(archive);
    assertRewardLaunchBinding(archive, await loadRewardLaunchConfig(environment));
    if (archive.mstrxMint !== environment.mstrxMint) throw new Error("REWARD_OWED_PLAN_ASSET_MISMATCH");
    await assertOwedEscrowIdentity(environment, archive);
    const original = rewardEpochConservation(archive).owed;
    const identity = (receipt: OwedReceipt) => `${receipt.recipient}:${receipt.rawMstrx}:${receipt.escrowSignature}`;
    if (archive.planHash !== ledger.planHash || archive.owedEscrow.address !== ledger.escrowAddress
      || archive.owedEscrow.owner !== ledger.escrowOwner
      || archive.fundedRawMstrx !== ledger.fundedRawMstrx
      || rewardEpochConservation(archive).owedRaw.toString() !== ledger.originallyOwedRawMstrx
      || original.map(identity).join("|") !== ledger.receipts.map(identity).join("|")) {
      throw new Error("REWARD_OWED_LEDGER_ARCHIVE_MISMATCH");
    }
    ledgers.push(ledger);
  }
  return ledgers;
}

async function assertOwedLedgerBacked(environment: RewardPipelineEnvironment, ledger: OwedEpochLedger) {
  const sourceAta = mstrxAta(new PublicKey(ledger.escrowOwner), new PublicKey(environment.mstrxMint)).toBase58();
  let newestProofSlot = 0;
  for (const receipt of ledger.receipts) {
    const finalized = await readAgreedFinalizedTransaction(environment.rpcUrls, receipt.escrowSignature, environment.mstrxMint);
    if (!finalized || tokenAccountDelta(finalized, sourceAta) !== -BigInt(receipt.rawMstrx)
      || tokenAccountDelta(finalized, ledger.escrowAddress) !== BigInt(receipt.rawMstrx)) {
      throw new Error("REWARD_OWED_ESCROW_RECEIPT_UNPROVEN");
    }
    newestProofSlot = Math.max(newestProofSlot, finalized.slot);
  }
  for (const event of ledger.deliveryEvents) {
    const receipt = ledger.receipts.find((row) => row.recipient === event.recipient);
    if (!receipt) throw new Error("REWARD_OWED_DELIVERY_EVENT_INVALID");
    const finalized = await readAgreedFinalizedTransaction(environment.rpcUrls, event.signature, environment.mstrxMint);
    const recipientAta = mstrxAta(new PublicKey(event.recipient), new PublicKey(environment.mstrxMint)).toBase58();
    if (!finalized || finalized.slot !== event.finalizedSlot || finalized.blockhash !== event.finalizedBlockhash
      || tokenAccountDelta(finalized, ledger.escrowAddress) !== -BigInt(event.rawMstrx)
      || tokenAccountDelta(finalized, recipientAta) !== BigInt(event.rawMstrx)) {
      throw new Error("REWARD_OWED_DELIVERY_UNPROVEN");
    }
    newestProofSlot = Math.max(newestProofSlot, finalized.slot);
  }
  const balance = await readAgreedEscrowAccount(environment, ledger.escrowAddress, ledger.escrowOwner, newestProofSlot, true);
  const outstanding = ledger.receipts.filter((receipt) => receipt.state === "owed")
    .reduce((total, receipt) => total + BigInt(receipt.rawMstrx), 0n);
  if (balance < outstanding) throw new Error("REWARD_OWED_ESCROW_UNDERFUNDED");
  return { balance, outstanding };
}

async function assertAllOwedEscrowsBacked(environment: RewardPipelineEnvironment) {
  for (const ledger of await readOwedLedgers(environment)) {
    await reconcileOwedSubmitted(environment, ledger);
    await assertOwedLedgerBacked(environment, ledger);
    await saveOwedLedger(environment, ledger);
  }
}

async function saveOwedLedger(environment: RewardPipelineEnvironment, ledger: OwedEpochLedger) {
  assertOwedLedgerShape(ledger);
  await writeDurableJson(owedLedgerPath(environment, ledger.epochId), ledger);
  await writeDurableJson(owedPublicPath(environment, ledger.epochId), {
    version: ledger.version,
    epochId: ledger.epochId,
    planHash: ledger.planHash,
    mstrxMint: ledger.mstrxMint,
    escrowAddress: ledger.escrowAddress,
    originallyOwedRawMstrx: ledger.originallyOwedRawMstrx,
    outstandingRawMstrx: ledger.receipts.filter((receipt) => receipt.state === "owed")
      .reduce((total, receipt) => total + BigInt(receipt.rawMstrx), 0n).toString(),
    receipts: ledger.receipts.map((receipt) => ({
      recipient: receipt.recipient,
      rawMstrx: receipt.rawMstrx,
      escrowSignature: receipt.escrowSignature,
      payoutSignature: receipt.state === "paid" ? receipt.transfer.signature : undefined,
      state: receipt.state,
      originalFailure: receipt.originalFailure,
      retryCount: receipt.retryCount,
      nextRetryAt: receipt.state === "owed" ? receipt.nextRetryAt : undefined,
    })),
    deliveryEvents: ledger.deliveryEvents,
  });
}

function recordOwedRetryFailure(receipt: OwedReceipt, stage: "ata" | "transfer", evidence: "simulation" | "finalized", nowMs: number, signature?: string) {
  receipt.attempts.push({ stage, evidence, ...(signature ? { signature } : {}) });
  // Retain only recent diagnostics. The lifetime count remains durable.
  if (receipt.attempts.length > 32) receipt.attempts.splice(0, receipt.attempts.length - 32);
  receipt.retryCount = Math.min(Number.MAX_SAFE_INTEGER, receipt.retryCount + 1);
  receipt.nextRetryAt = owedRetryTime(receipt.retryCount, nowMs);
}

export function owedRetryTime(retryCount: number, nowMs: number) {
  if (!Number.isSafeInteger(retryCount) || retryCount < 1 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("REWARD_OWED_RETRY_TIME_INVALID");
  }
  const interval = 15 * 60_000 * 2 ** Math.min(retryCount - 1, 5);
  return Math.min(Number.MAX_SAFE_INTEGER, nowMs + Math.min(6 * 60 * 60_000, interval));
}

async function reconcileOwedSignedStep(args: {
  environment: RewardPipelineEnvironment;
  ledger: OwedEpochLedger;
  receipt: OwedReceipt;
  stage: "ata" | "transfer";
  nowMs: number;
}) {
  const { environment, ledger, receipt, stage, nowMs } = args;
  const step = receipt[stage];
  if (step.state !== "submitted" || !step.signature || !step.transactionBase64 || !step.blockhash || !step.lastValidBlockHeight) {
    throw new Error("REWARD_OWED_RETRY_SIGNED_STATE_INVALID");
  }
  if (await readAgreedFinalizedFailure(environment.rpcUrls, step.signature)) {
    step.state = "rejected";
    recordOwedRetryFailure(receipt, stage, "finalized", nowMs, step.signature);
    await saveOwedLedger(environment, ledger);
    return "rejected" as const;
  }
  const finalized = await readAgreedFinalizedTransaction(environment.rpcUrls, step.signature, environment.mstrxMint);
  if (finalized) {
    if (stage === "transfer") {
      const recipientAta = mstrxAta(new PublicKey(receipt.recipient), new PublicKey(environment.mstrxMint)).toBase58();
      const amount = BigInt(receipt.rawMstrx);
      if (tokenAccountDelta(finalized, ledger.escrowAddress) !== -amount
        || tokenAccountDelta(finalized, recipientAta) !== amount) {
        throw new Error("REWARD_OWED_RETRY_DELTA_MISMATCH");
      }
      if (ledger.deliveryEvents.some((event) => event.recipient === receipt.recipient)) {
        throw new Error("REWARD_OWED_DELIVERY_EVENT_DUPLICATE");
      }
      ledger.deliveryEvents.push({
        recipient: receipt.recipient,
        rawMstrx: receipt.rawMstrx,
        signature: step.signature,
        finalizedSlot: finalized.slot,
        finalizedBlockhash: finalized.blockhash,
      });
      receipt.state = "paid";
    } else {
      const recipientAta = mstrxAta(new PublicKey(receipt.recipient), new PublicKey(environment.mstrxMint)).toBase58();
      await readAgreedEscrowAccount(environment, recipientAta, receipt.recipient, finalized.slot);
    }
    step.state = "confirmed";
    await saveOwedLedger(environment, ledger);
    return "confirmed" as const;
  }
  const statuses = await Promise.all(environment.rpcUrls.map(async (url) =>
    (await new Connection(url, "finalized").getSignatureStatuses([step.signature!], { searchTransactionHistory: true })).value[0],
  ));
  const heights = await Promise.all(environment.rpcUrls.map((url) => new Connection(url, "finalized").getBlockHeight("finalized")));
  if (submittedBatchRetryDecision({ statuses, finalizedHeights: heights, lastValidBlockHeight: step.lastValidBlockHeight }) === "rebroadcast-same-transaction") {
    await new Connection(environment.rpcUrls[0], "confirmed").sendRawTransaction(Buffer.from(step.transactionBase64, "base64"), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
  }
  return "submitted" as const;
}

async function reconcileOwedSubmitted(environment: RewardPipelineEnvironment, ledger: OwedEpochLedger) {
  for (const receipt of ledger.receipts) {
    if (receipt.state === "paid") continue;
    if (receipt.ata.state === "submitted") {
      const outcome = await reconcileOwedSignedStep({ environment, ledger, receipt, stage: "ata", nowMs: Date.now() });
      if (outcome === "submitted") throw new Error("REWARD_OWED_RETRY_OUTCOME_PENDING");
    }
    if (receipt.transfer.state === "submitted") {
      const outcome = await reconcileOwedSignedStep({ environment, ledger, receipt, stage: "transfer", nowMs: Date.now() });
      if (outcome === "submitted") throw new Error("REWARD_OWED_RETRY_OUTCOME_PENDING");
    }
  }
}

/** Retry only finalized, already-escrowed obligations. Caller must enforce active launch and pause policy. */
export async function retryOwedRewardPayments(
  environment: RewardPipelineEnvironment,
  options: { maxRecipients?: number; nowMs?: number } = {},
) {
  const maxRecipients = options.maxRecipients ?? 12;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 12 || !Number.isSafeInteger(nowMs)) {
    throw new Error("REWARD_OWED_RETRY_OPTIONS_INVALID");
  }
  const ledgers = await readOwedLedgers(environment);
  const operator = await loadKeypair(environment.operatorKeypairPath);
  const holder = await loadKeypair(environment.holderKeypairPath);
  const mint = new PublicKey(environment.mstrxMint);
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  let processed = 0;
  for (const ledger of ledgers) {
    await reconcileOwedSubmitted(environment, ledger);
    await assertOwedLedgerBacked(environment, ledger);
    // Heal a crash between the private ledger fsync and the public projection write.
    await saveOwedLedger(environment, ledger);
    for (const receipt of ledger.receipts) {
      if (receipt.state === "paid" || receipt.nextRetryAt > nowMs) continue;
      if (processed >= maxRecipients) return { processed, remaining: ledgers.flatMap((item) => item.receipts).filter((item) => item.state === "owed").length };
      processed += 1;
      if (receipt.ata.state === "rejected") receipt.ata = { state: "pending" };
      if (receipt.transfer.state === "rejected") receipt.transfer = { state: "pending" };
      if (receipt.ata.state === "pending") {
        await assertOperatorPayoutBudget(environment, operator.publicKey, mint, 1);
        let prepared: Awaited<ReturnType<typeof prepareDualRpcRewardTransaction>> | undefined;
        try {
          prepared = await prepareDualRpcRewardTransaction(environment, {
            payer: operator,
            instructions: [createMstrxAtaInstruction(operator.publicKey, new PublicKey(receipt.recipient), mint)],
          });
        } catch (error) {
          if (!isDefiniteSimulationRejection(error)) throw error;
          receipt.ata.state = "rejected";
          recordOwedRetryFailure(receipt, "ata", "simulation", nowMs);
          await saveOwedLedger(environment, ledger);
          continue;
        }
        Object.assign(receipt.ata, { state: "submitted", ...prepared });
        await saveOwedLedger(environment, ledger);
        await broadcastPreparedTransaction({ connection, ...prepared });
      }
      if (receipt.ata.state === "submitted") {
        const result = await reconcileOwedSignedStep({ environment, ledger, receipt, stage: "ata", nowMs });
        if (result !== "confirmed") continue;
      }
      if (receipt.ata.state !== "confirmed") throw new Error("REWARD_OWED_ATA_NOT_CONFIRMED");
      if (receipt.transfer.state === "pending") {
        await assertOperatorPayoutBudget(environment, operator.publicKey, mint, 0);
        const recipientAta = mstrxAta(new PublicKey(receipt.recipient), mint);
        const instruction = await createTransferCheckedWithTransferHookInstruction(
          connection, new PublicKey(ledger.escrowAddress), mint, recipientAta,
          holder.publicKey, BigInt(receipt.rawMstrx), MSTRX_DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
        );
        let prepared: Awaited<ReturnType<typeof prepareDualRpcRewardTransaction>> | undefined;
        try {
          prepared = await prepareDualRpcRewardTransaction(environment, { payer: operator, additionalSigners: [holder], instructions: [instruction] });
        } catch (error) {
          if (!isDefiniteSimulationRejection(error)) throw error;
          receipt.transfer.state = "rejected";
          recordOwedRetryFailure(receipt, "transfer", "simulation", nowMs);
          await saveOwedLedger(environment, ledger);
          continue;
        }
        Object.assign(receipt.transfer, { state: "submitted", ...prepared });
        await saveOwedLedger(environment, ledger);
        await broadcastPreparedTransaction({ connection, ...prepared });
      }
      if (receipt.transfer.state === "submitted") {
        const outcome = await reconcileOwedSignedStep({ environment, ledger, receipt, stage: "transfer", nowMs });
        if (outcome === "submitted") throw new Error("REWARD_OWED_RETRY_OUTCOME_PENDING");
      }
      await assertOwedLedgerBacked(environment, ledger);
    }
  }
  return { processed, remaining: ledgers.flatMap((ledger) => ledger.receipts).filter((receipt) => receipt.state === "owed").length };
}

async function escrowCreationRent(environment: RewardPipelineEnvironment, operator: PublicKey, mint: PublicKey) {
  const mintState = await readAgreedRewardMint(environment, mint);
  const observations = await Promise.all(environment.rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const [rent, balance] = await Promise.all([
      connection.getMinimumBalanceForRentExemption(mintState.escrowAccountLength, "finalized"),
      connection.getBalance(operator, "finalized"),
    ]);
    return { rent, balance };
  }));
  const agreed = requireMatchingValues(observations, "REWARD_OWED_ESCROW_RENT_RPC_DISAGREEMENT");
  if (BigInt(agreed.balance) < BigInt(agreed.rent) + 1_000_000n) throw new Error("REWARD_OPERATOR_SOL_BELOW_ESCROW_RENT");
  return { ...agreed, space: mintState.escrowAccountLength };
}

async function ensureOwedEscrow(environment: RewardPipelineEnvironment, plan: RewardEpochPlan) {
  assertOwedEscrowReleased();
  const escrow = plan.owedEscrow;
  const holder = await loadKeypair(environment.holderKeypairPath);
  const operator = await loadKeypair(environment.operatorKeypairPath);
  const mint = new PublicKey(environment.mstrxMint);
  await assertOwedEscrowIdentity(environment, plan);
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  if (escrow.state === "submitted") {
    if (!escrow.signature || !escrow.transactionBase64 || !escrow.blockhash || !escrow.lastValidBlockHeight) throw new Error("REWARD_OWED_ESCROW_SIGNED_STATE_INVALID");
    if (await readAgreedFinalizedFailure(environment.rpcUrls, escrow.signature)) throw new Error("REWARD_OWED_ESCROW_CREATION_FAILED");
    const finalized = await readAgreedFinalizedTransaction(environment.rpcUrls, escrow.signature, environment.mstrxMint);
    if (finalized) {
      const balance = await readAgreedEscrowAccount(environment, escrow.address, escrow.owner, finalized.slot, true);
      if (balance !== 0n) throw new Error("REWARD_OWED_ESCROW_CREATED_NONEMPTY");
      escrow.state = "confirmed";
      await savePlan(environment, plan);
    } else {
      const statuses = await Promise.all(environment.rpcUrls.map(async (url) =>
        (await new Connection(url, "finalized").getSignatureStatuses([escrow.signature!], { searchTransactionHistory: true })).value[0],
      ));
      const heights = await Promise.all(environment.rpcUrls.map((url) => new Connection(url, "finalized").getBlockHeight("finalized")));
      if (submittedBatchRetryDecision({ statuses, finalizedHeights: heights, lastValidBlockHeight: escrow.lastValidBlockHeight }) === "rebroadcast-same-transaction") {
        await connection.sendRawTransaction(Buffer.from(escrow.transactionBase64, "base64"), {
          skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
        });
      }
    }
  }
  if (escrow.state === "pending") {
    const existing = await Promise.all(environment.rpcUrls.map((url) => new Connection(url, "finalized").getAccountInfo(new PublicKey(escrow.address), "finalized")));
    if (existing.some((account) => account)) throw new Error("REWARD_OWED_ESCROW_UNEXPECTED_EXISTING_ACCOUNT");
    const { space, rent } = await escrowCreationRent(environment, operator.publicKey, mint);
    const instructions: TransactionInstruction[] = [
      SystemProgram.createAccountWithSeed({
        fromPubkey: operator.publicKey, basePubkey: holder.publicKey, seed: escrow.seed,
        newAccountPubkey: new PublicKey(escrow.address), lamports: rent, space, programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeAccount3Instruction(new PublicKey(escrow.address), mint, holder.publicKey, TOKEN_2022_PROGRAM_ID),
    ];
    const prepared = await prepareDualRpcRewardTransaction(environment, { payer: operator, additionalSigners: [holder], instructions });
    Object.assign(escrow, { state: "submitted", ...prepared });
    await savePlan(environment, plan);
    await broadcastPreparedTransaction({ connection, ...prepared });
    return ensureOwedEscrow(environment, plan);
  }
  return escrow.state === "confirmed";
}

async function reconcileSignedStep(args: {
  environment: RewardPipelineEnvironment;
  plan: RewardEpochPlan;
  step: RewardSignedStep;
  expectedDeltas?: ReadonlyArray<{ account: string; rawDelta: bigint }>;
  accountCheck?: { address: string; owner: string };
  allowFinalizedFailure: boolean;
}) {
  const { environment, plan, step } = args;
  if (step.state !== "submitted" || !step.signature || !step.transactionBase64 || !step.blockhash || !step.lastValidBlockHeight) {
    throw new Error("REWARD_SIGNED_STEP_INVALID");
  }
  if (await readAgreedFinalizedFailure(environment.rpcUrls, step.signature)) {
    if (!args.allowFinalizedFailure) throw new Error("REWARD_OWED_ESCROW_TRANSFER_FAILED");
    step.state = "rejected";
    await savePlan(environment, plan);
    return "rejected" as const;
  }
  const finalized = await readAgreedFinalizedTransaction(environment.rpcUrls, step.signature, environment.mstrxMint);
  if (finalized) {
    for (const expected of args.expectedDeltas ?? []) {
      if (tokenAccountDelta(finalized, expected.account) !== expected.rawDelta) throw new Error("REWARD_SIGNED_STEP_DELTA_MISMATCH");
    }
    if (args.accountCheck) await readAgreedEscrowAccount(environment, args.accountCheck.address, args.accountCheck.owner, finalized.slot);
    step.state = "confirmed";
    await savePlan(environment, plan);
    return "confirmed" as const;
  }
  const statuses = await Promise.all(environment.rpcUrls.map(async (url) =>
    (await new Connection(url, "finalized").getSignatureStatuses([step.signature!], { searchTransactionHistory: true })).value[0],
  ));
  const heights = await Promise.all(environment.rpcUrls.map((url) => new Connection(url, "finalized").getBlockHeight("finalized")));
  if (submittedBatchRetryDecision({ statuses, finalizedHeights: heights, lastValidBlockHeight: step.lastValidBlockHeight }) === "rebroadcast-same-transaction") {
    await new Connection(environment.rpcUrls[0], "confirmed").sendRawTransaction(Buffer.from(step.transactionBase64, "base64"), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
  }
  return "submitted" as const;
}

async function persistAndBroadcastStep(
  environment: RewardPipelineEnvironment, plan: RewardEpochPlan, step: RewardSignedStep,
  prepared: Awaited<ReturnType<typeof prepareDualRpcRewardTransaction>>,
) {
  Object.assign(step, { state: "submitted", ...prepared });
  await savePlan(environment, plan);
  await broadcastPreparedTransaction({ connection: new Connection(environment.rpcUrls[0], "confirmed"), ...prepared });
}

function startIsolation(batch: RewardBatch, kind: "ata" | "transfer", evidence: "simulation" | "finalized", signature?: string) {
  if (batch.originalFailure) throw new Error("REWARD_BATCH_FAILURE_ALREADY_CLASSIFIED");
  batch.originalFailure = { kind, evidence, ...(signature ? { signature } : {}) };
  if (kind === "ata") batch.ataState = "isolating";
  batch.state = "isolating";
  for (const allocation of batch.allocations) {
    allocation.delivery = {
      state: "pending",
      ata: { state: kind === "transfer" ? "confirmed" : "pending" },
      transfer: { state: "pending" },
      escrow: { state: "pending" },
    };
  }
}

function isIsolating(batch: RewardBatch) {
  return batch.state === "isolating";
}

async function processIsolatedBatch(
  environment: RewardPipelineEnvironment, plan: RewardEpochPlan, batch: RewardBatch,
  operator: Awaited<ReturnType<typeof loadKeypair>>, holder: Awaited<ReturnType<typeof loadKeypair>>,
  mint: PublicKey,
) {
  assertOwedEscrowReleased();
  if (batch.state !== "isolating" || !batch.originalFailure) throw new Error("REWARD_BATCH_NOT_ISOLATING");
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  const sourceAta = mstrxAta(holder.publicKey, mint).toBase58();
  for (const allocation of batch.allocations) {
    const delivery = allocation.delivery;
    if (!delivery) throw new Error("REWARD_ALLOCATION_PROGRESS_MISSING");
    if (delivery.state === "paid" || delivery.state === "owed") continue;
    const recipient = new PublicKey(allocation.recipient);
    const recipientAta = mstrxAta(recipient, mint).toBase58();
    const rawAmount = BigInt(allocation.rawMstrx);
    if (delivery.ata.state === "pending") {
      await assertOperatorPayoutBudget(environment, operator.publicKey, mint, 1);
      let prepared: Awaited<ReturnType<typeof prepareDualRpcRewardTransaction>> | undefined;
      try {
        prepared = await prepareDualRpcRewardTransaction(environment, {
          payer: operator, instructions: [createMstrxAtaInstruction(operator.publicKey, recipient, mint)],
        });
      } catch (error) {
        if (!isDefiniteSimulationRejection(error)) throw error;
        delivery.ata.state = "rejected";
        delivery.rejection = { stage: "ata", evidence: "simulation" };
        await savePlan(environment, plan);
      }
      if (prepared) await persistAndBroadcastStep(environment, plan, delivery.ata, prepared);
    }
    if (delivery.ata.state === "submitted") {
      const outcome = await reconcileSignedStep({
        environment, plan, step: delivery.ata, allowFinalizedFailure: true,
        accountCheck: { address: recipientAta, owner: allocation.recipient },
      });
      if (outcome === "submitted") return false;
      if (outcome === "rejected") {
        delivery.rejection = { stage: "ata", evidence: "finalized", signature: delivery.ata.signature };
        await savePlan(environment, plan);
      }
    }
    if (delivery.ata.state === "confirmed") {
      if (delivery.transfer.state === "pending") {
        await assertOperatorPayoutBudget(environment, operator.publicKey, mint, 0);
        const instruction = await createMstrxTransfer({
          connection, sourceOwner: holder.publicKey, destinationOwner: recipient, mint, rawAmount,
        });
        let prepared: Awaited<ReturnType<typeof prepareDualRpcRewardTransaction>> | undefined;
        try {
          prepared = await prepareDualRpcRewardTransaction(environment, { payer: operator, additionalSigners: [holder], instructions: [instruction] });
        } catch (error) {
          if (!isDefiniteSimulationRejection(error)) throw error;
          delivery.transfer.state = "rejected";
          delivery.rejection = { stage: "transfer", evidence: "simulation" };
          await savePlan(environment, plan);
        }
        if (prepared) await persistAndBroadcastStep(environment, plan, delivery.transfer, prepared);
      }
      if (delivery.transfer.state === "submitted") {
        const outcome = await reconcileSignedStep({
          environment, plan, step: delivery.transfer, allowFinalizedFailure: true,
          expectedDeltas: [{ account: sourceAta, rawDelta: -rawAmount }, { account: recipientAta, rawDelta: rawAmount }],
        });
        if (outcome === "submitted") return false;
        if (outcome === "rejected") {
          delivery.rejection = { stage: "transfer", evidence: "finalized", signature: delivery.transfer.signature };
          await savePlan(environment, plan);
        }
      }
      if (delivery.transfer.state === "confirmed") {
        delivery.state = "paid";
        await savePlan(environment, plan);
        continue;
      }
    }
    if (!delivery.rejection || (delivery.ata.state !== "rejected" && delivery.transfer.state !== "rejected")) {
      throw new Error("REWARD_ALLOCATION_ISOLATION_EVIDENCE_MISSING");
    }
    if (!await ensureOwedEscrow(environment, plan)) return false;
    if (delivery.escrow.state === "pending") {
      await assertOperatorPayoutBudget(environment, operator.publicKey, mint, 0);
      const instruction = await createTransferCheckedWithTransferHookInstruction(
        connection, new PublicKey(sourceAta), mint, new PublicKey(plan.owedEscrow.address),
        holder.publicKey, rawAmount, MSTRX_DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
      );
      const prepared = await prepareDualRpcRewardTransaction(environment, { payer: operator, additionalSigners: [holder], instructions: [instruction] });
      await persistAndBroadcastStep(environment, plan, delivery.escrow, prepared);
    }
    if (delivery.escrow.state === "submitted") {
      const outcome = await reconcileSignedStep({
        environment, plan, step: delivery.escrow, allowFinalizedFailure: false,
        expectedDeltas: [
          { account: sourceAta, rawDelta: -rawAmount },
          { account: plan.owedEscrow.address, rawDelta: rawAmount },
        ],
      });
      if (outcome === "submitted") return false;
    }
    if (delivery.escrow.state !== "confirmed") throw new Error("REWARD_ALLOCATION_ESCROW_NOT_FINALIZED");
    delivery.state = "owed";
    await savePlan(environment, plan);
  }
  if (batch.allocations.some((allocation) => !["paid", "owed"].includes(allocation.delivery?.state ?? "pending"))) return false;
  batch.state = "confirmed";
  await savePlan(environment, plan);
  return true;
}

async function reconcileSubmitted(args: {
  environment: RewardPipelineEnvironment;
  plan: RewardEpochPlan;
  batchIndex: number;
  kind: "ata" | "transfer";
}) {
  const { environment, plan, batchIndex, kind } = args;
  const batch = plan.batches[batchIndex];
  const signature = kind === "ata" ? batch.ataSignature : batch.signature;
  const transactionBase64 = kind === "ata" ? batch.ataTransactionBase64 : batch.transactionBase64;
  const blockhash = kind === "ata" ? batch.ataBlockhash : batch.blockhash;
  const lastValidBlockHeight = kind === "ata" ? batch.ataLastValidBlockHeight : batch.lastValidBlockHeight;
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  if (!signature || !transactionBase64 || !blockhash || !lastValidBlockHeight) throw new Error("SUBMITTED_BATCH_STATE_INVALID");
  if (await readAgreedFinalizedFailure(environment.rpcUrls, signature)) {
    startIsolation(batch, kind, "finalized", signature);
    await savePlan(environment, plan);
    return;
  }
  const finalized = await readAgreedFinalizedTransaction(environment.rpcUrls, signature, environment.mstrxMint);
  if (finalized) {
    if (kind === "transfer") {
      const sourceAta = mstrxAta((await loadKeypair(environment.holderKeypairPath)).publicKey, new PublicKey(environment.mstrxMint)).toBase58();
      if (tokenAccountDelta(finalized, sourceAta) !== -BigInt(batch.rawTotal)) throw new Error("REWARD_BATCH_SOURCE_DELTA_MISMATCH");
      for (const allocation of batch.allocations) {
        const recipientAta = mstrxAta(new PublicKey(allocation.recipient), new PublicKey(environment.mstrxMint)).toBase58();
        if (tokenAccountDelta(finalized, recipientAta) !== BigInt(allocation.rawMstrx)) throw new Error("REWARD_BATCH_RECIPIENT_DELTA_MISMATCH");
      }
    } else {
      for (const allocation of batch.allocations) {
        const recipientAta = mstrxAta(new PublicKey(allocation.recipient), new PublicKey(environment.mstrxMint)).toBase58();
        await readAgreedEscrowAccount(environment, recipientAta, allocation.recipient, finalized.slot);
      }
    }
    if (kind === "ata") batch.ataState = "confirmed"; else batch.state = "confirmed";
    await savePlan(environment, plan);
    return;
  }
  const statuses = await Promise.all(environment.rpcUrls.map(async (url) =>
    (await new Connection(url, "finalized").getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0],
  ));
  const heights = await Promise.all(environment.rpcUrls.map((url) => new Connection(url, "finalized").getBlockHeight("finalized")));
  if (submittedBatchRetryDecision({ statuses, finalizedHeights: heights, lastValidBlockHeight }) === "rebroadcast-same-transaction") {
    await connection.sendRawTransaction(Buffer.from(transactionBase64, "base64"), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  }
}

export async function distributeRewardEpoch(environment: RewardPipelineEnvironment) {
  const plan = await loadCurrentRewardPlan(environment);
  if (plan.finalized) throw new Error("REWARD_EPOCH_ALREADY_FINALIZED");
  const operator = await loadKeypair(environment.operatorKeypairPath);
  const holder = await loadKeypair(environment.holderKeypairPath);
  const mint = new PublicKey(environment.mstrxMint);
  const connection = new Connection(environment.rpcUrls[0], "confirmed");

  for (let index = 0; index < plan.batches.length; index += 1) {
    const batch = plan.batches[index];
    if (batch.ataState === "submitted") await reconcileSubmitted({ environment, plan, batchIndex: index, kind: "ata" });
    if (isIsolating(batch)) {
      if (!await processIsolatedBatch(environment, plan, batch, operator, holder, mint)) return plan;
      continue;
    }
    if (batch.ataState === "pending") {
      await assertOperatorPayoutBudget(environment, operator.publicKey, mint, batch.allocations.length);
      try {
        const prepared = await prepareDualRpcRewardTransaction(environment, {
          payer: operator,
          instructions: batch.allocations.map((allocation) => createMstrxAtaInstruction(operator.publicKey, new PublicKey(allocation.recipient), mint)),
        });
        batch.ataState = "submitted";
        batch.ataSignature = prepared.signature;
        batch.ataTransactionBase64 = prepared.transactionBase64;
        batch.ataBlockhash = prepared.blockhash;
        batch.ataLastValidBlockHeight = prepared.lastValidBlockHeight;
        await savePlan(environment, plan);
        await broadcastPreparedTransaction({ connection, ...prepared });
        await reconcileSubmitted({ environment, plan, batchIndex: index, kind: "ata" });
      } catch (error) {
        if (!isDefiniteSimulationRejection(error) || batch.ataState !== "pending") throw error;
        startIsolation(batch, "ata", "simulation");
        await savePlan(environment, plan);
      }
    }
    if (isIsolating(batch)) {
      if (!await processIsolatedBatch(environment, plan, batch, operator, holder, mint)) return plan;
      continue;
    }
    if (batch.ataState !== "confirmed") return plan;

    if (batch.state === "submitted") await reconcileSubmitted({ environment, plan, batchIndex: index, kind: "transfer" });
    if (isIsolating(batch)) {
      if (!await processIsolatedBatch(environment, plan, batch, operator, holder, mint)) return plan;
      continue;
    }
    if (batch.state === "pending") {
      await assertOperatorPayoutBudget(environment, operator.publicKey, mint, 0);
      const instructions: TransactionInstruction[] = [];
      for (const allocation of batch.allocations) {
        instructions.push(await createMstrxTransfer({
          connection,
          sourceOwner: holder.publicKey,
          destinationOwner: new PublicKey(allocation.recipient),
          mint,
          rawAmount: BigInt(allocation.rawMstrx),
        }));
      }
      try {
        const prepared = await prepareDualRpcRewardTransaction(environment, { payer: operator, additionalSigners: [holder], instructions });
        batch.state = "submitted";
        batch.signature = prepared.signature;
        batch.transactionBase64 = prepared.transactionBase64;
        batch.blockhash = prepared.blockhash;
        batch.lastValidBlockHeight = prepared.lastValidBlockHeight;
        await savePlan(environment, plan);
        await broadcastPreparedTransaction({ connection, ...prepared });
        await reconcileSubmitted({ environment, plan, batchIndex: index, kind: "transfer" });
      } catch (error) {
        if (!isDefiniteSimulationRejection(error) || batch.state !== "pending") throw error;
        startIsolation(batch, "transfer", "simulation");
        await savePlan(environment, plan);
      }
    }
    if (isIsolating(batch)) {
      if (!await processIsolatedBatch(environment, plan, batch, operator, holder, mint)) return plan;
      continue;
    }
    if (batch.state !== "confirmed") return plan;
  }
  return plan;
}

export function rewardEpochConservation(plan: RewardEpochPlan) {
  assertRewardPlanHash(plan);
  let paidRaw = 0n;
  let owedRaw = 0n;
  const owed: OwedReceipt[] = [];
  const seenRecipients = new Set<string>();
  for (const batch of plan.batches) {
    if (batch.state !== "confirmed") throw new Error("REWARD_BATCHES_INCOMPLETE");
    if (!batch.originalFailure) {
      if (batch.ataState !== "confirmed" || !batch.signature) throw new Error("REWARD_BATCH_CONFIRMATION_INVALID");
      paidRaw += BigInt(batch.rawTotal);
      continue;
    }
    let batchTotal = 0n;
    for (const allocation of batch.allocations) {
      const delivery = allocation.delivery;
      if (!delivery || seenRecipients.has(allocation.recipient)) throw new Error("REWARD_ISOLATED_ALLOCATION_INVALID");
      seenRecipients.add(allocation.recipient);
      const amount = BigInt(allocation.rawMstrx);
      batchTotal += amount;
      if (delivery.state === "paid") {
        if (delivery.transfer.state !== "confirmed" || !delivery.transfer.signature) throw new Error("REWARD_PAID_RECEIPT_INVALID");
        paidRaw += amount;
      } else if (delivery.state === "owed") {
        if (delivery.escrow.state !== "confirmed" || !delivery.escrow.signature || !delivery.rejection) {
          throw new Error("REWARD_OWED_RECEIPT_INVALID");
        }
        owedRaw += amount;
        owed.push({
          recipient: allocation.recipient,
          rawMstrx: allocation.rawMstrx,
          escrowSignature: delivery.escrow.signature,
          originalFailure: delivery.rejection,
          state: "owed",
          ata: { state: delivery.ata.state === "confirmed" ? "confirmed" : "pending" },
          transfer: { state: "pending" },
          attempts: [],
          retryCount: 0,
          nextRetryAt: 0,
        });
      } else {
        throw new Error("REWARD_ISOLATED_ALLOCATION_INCOMPLETE");
      }
    }
    if (batchTotal !== BigInt(batch.rawTotal)) throw new Error("REWARD_BATCH_NOT_CONSERVED");
  }
  if (paidRaw + owedRaw !== BigInt(plan.fundedRawMstrx)) throw new Error("REWARD_EPOCH_NOT_CONSERVED");
  return { paidRaw, owedRaw, owed };
}

async function verifyRewardPlanOnchain(environment: RewardPipelineEnvironment, plan: RewardEpochPlan) {
  const mint = new PublicKey(environment.mstrxMint);
  const holder = await loadKeypair(environment.holderKeypairPath);
  const sourceAta = mstrxAta(holder.publicKey, mint).toBase58();
  for (const batch of plan.batches) {
    if (!batch.originalFailure) {
      if (!batch.signature) throw new Error("REWARD_BATCH_SIGNATURE_MISSING");
      const finalized = await readAgreedFinalizedTransaction(environment.rpcUrls, batch.signature, environment.mstrxMint);
      if (!finalized || tokenAccountDelta(finalized, sourceAta) !== -BigInt(batch.rawTotal)) {
        throw new Error("REWARD_BATCH_FINALITY_UNPROVEN");
      }
      for (const allocation of batch.allocations) {
        const recipientAta = mstrxAta(new PublicKey(allocation.recipient), mint).toBase58();
        if (tokenAccountDelta(finalized, recipientAta) !== BigInt(allocation.rawMstrx)) throw new Error("REWARD_BATCH_FINALITY_UNPROVEN");
      }
      continue;
    }
    for (const allocation of batch.allocations) {
      const delivery = allocation.delivery!;
      const signature = delivery.state === "paid" ? delivery.transfer.signature : delivery.escrow.signature;
      if (!signature) throw new Error("REWARD_ISOLATED_SIGNATURE_MISSING");
      const finalized = await readAgreedFinalizedTransaction(environment.rpcUrls, signature, environment.mstrxMint);
      const destination = delivery.state === "paid"
        ? mstrxAta(new PublicKey(allocation.recipient), mint).toBase58() : plan.owedEscrow.address;
      if (!finalized || tokenAccountDelta(finalized, sourceAta) !== -BigInt(allocation.rawMstrx)
        || tokenAccountDelta(finalized, destination) !== BigInt(allocation.rawMstrx)) {
        throw new Error("REWARD_ISOLATED_FINALITY_UNPROVEN");
      }
      if (delivery.rejection?.evidence === "finalized"
        && (!delivery.rejection.signature || !await readAgreedFinalizedFailure(environment.rpcUrls, delivery.rejection.signature))) {
        throw new Error("REWARD_ISOLATED_FAILURE_UNPROVEN");
      }
    }
  }
}

async function persistOwedLedger(environment: RewardPipelineEnvironment, plan: RewardEpochPlan, receipts: OwedReceipt[]) {
  const owedRaw = receipts.reduce((total, receipt) => total + BigInt(receipt.rawMstrx), 0n);
  if (!owedRaw) return;
  const ledger: OwedEpochLedger = {
    version: 1,
    epochId: plan.epochId,
    planHash: plan.planHash,
    mstrxMint: environment.mstrxMint,
    escrowOwner: plan.owedEscrow.owner,
    escrowAddress: plan.owedEscrow.address,
    fundedRawMstrx: plan.fundedRawMstrx,
    originallyOwedRawMstrx: owedRaw.toString(),
    receipts,
    deliveryEvents: [],
  };
  assertOwedLedgerShape(ledger);
  const archived = await readJsonIfExists<RewardEpochPlan>(archivedPlanPath(environment, plan.epochId));
  if (archived) {
    assertRewardPlanHash(archived);
    if (archived.planHash !== plan.planHash || rewardEpochConservation(archived).owed
      .map((receipt) => `${receipt.recipient}:${receipt.rawMstrx}:${receipt.escrowSignature}`).join("|")
      !== receipts.map((receipt) => `${receipt.recipient}:${receipt.rawMstrx}:${receipt.escrowSignature}`).join("|")) {
      throw new Error("REWARD_OWED_PLAN_ARCHIVE_CONFLICT");
    }
  } else {
    await writeDurableJson(archivedPlanPath(environment, plan.epochId), plan);
  }
  const path = owedLedgerPath(environment, plan.epochId);
  let existing: OwedEpochLedger | undefined;
  try {
    existing = JSON.parse(await readFile(path, "utf8")) as OwedEpochLedger;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (existing) {
    assertOwedLedgerShape(existing);
    const originalIdentity = (row: OwedReceipt) => `${row.recipient}:${row.rawMstrx}:${row.escrowSignature}`;
    if (existing.planHash !== ledger.planHash || existing.escrowAddress !== ledger.escrowAddress
      || existing.receipts.map(originalIdentity).join("|") !== receipts.map(originalIdentity).join("|")) {
      throw new Error("REWARD_OWED_LEDGER_CONFLICT");
    }
    await assertOwedLedgerBacked(environment, existing);
    await saveOwedLedger(environment, existing);
    return;
  }
  await assertOwedLedgerBacked(environment, ledger);
  await saveOwedLedger(environment, ledger);
}

export async function finalizeRewardEpoch(environment: RewardPipelineEnvironment) {
  const plan = await loadCurrentRewardPlan(environment);
  const { paidRaw, owedRaw, owed } = rewardEpochConservation(plan);
  await verifyRewardPlanOnchain(environment, plan);
  if (owedRaw > 0n) {
    if (plan.owedEscrow.state !== "confirmed") throw new Error("REWARD_OWED_ESCROW_NOT_READY");
    await persistOwedLedger(environment, plan, owed);
  }
  const publicPlan = {
    epochId: plan.epochId,
    launchSignature: plan.launchSignature,
    windowStart: plan.windowStart,
    windowEnd: plan.windowEnd,
    finalizedThroughSlot: plan.finalizedThroughSlot,
    finalizedBlockhash: plan.finalizedBlockhash,
    coverage: plan.coverage,
    fundedRawMstrx: plan.fundedRawMstrx,
    paidRawMstrx: paidRaw.toString(),
    owedRawMstrx: owedRaw.toString(),
    owedEscrowAddress: owedRaw > 0n ? plan.owedEscrow.address : undefined,
    owedStatusPath: owedRaw > 0n ? `/snapshots/solana-owed-epoch-${plan.epochId}.json` : undefined,
    merkleRoot: plan.merkleRoot,
    planHash: plan.planHash,
    batches: plan.batches.map((batch) => ({
      id: batch.id, rawTotal: batch.rawTotal, signature: batch.signature,
      allocations: batch.allocations.map((allocation) => ({
        recipient: allocation.recipient, rawMstrx: allocation.rawMstrx, proof: allocation.proof,
        status: allocation.delivery?.state ?? "paid",
        signature: allocation.delivery?.state === "paid" ? allocation.delivery.transfer.signature
          : allocation.delivery?.state === "owed" ? allocation.delivery.escrow.signature : batch.signature,
      })),
    })),
  };
  const historyRoot = resolve(environment.publicDataRoot, "snapshots");
  await mkdir(historyRoot, { recursive: true });
  await writeDurableJson(resolve(historyRoot, `solana-reward-epoch-${plan.epochId}.json`), publicPlan);
  const historyPath = resolve(historyRoot, "history.json");
  let history: Array<{ epoch: number; windowEnd: number; mstrxRewardRaw: string; paidRawMstrx?: string; owedRawMstrx?: string; signature?: string; recipientCount: number }> = [];
  try {
    const parsed = JSON.parse(await readFile(historyPath, "utf8")) as typeof history;
    if (Array.isArray(parsed)) history = parsed;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const entry = {
    epoch: Number(plan.epochId),
    windowEnd: plan.windowEnd,
    mstrxRewardRaw: plan.fundedRawMstrx,
    paidRawMstrx: paidRaw.toString(),
    owedRawMstrx: owedRaw.toString(),
    signature: plan.batches.at(-1)?.signature,
    recipientCount: plan.batches.reduce((count, batch) => count + batch.allocations.length, 0),
  };
  history = [entry, ...history.filter((item) => item.epoch !== entry.epoch)].slice(0, 50);
  await writeDurableJson(historyPath, history);
  plan.finalized = true;
  await savePlan(environment, plan);
  return plan;
}
