import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { getAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assertRewardPlanHash, buildRewardEpochPlan, type FinalizedHolderJournal, type RewardEpochPlan } from "./epochPlanner";
import { createMstrxAtaInstruction, createMstrxTransfer, mstrxAta } from "./mstrxTransfers";
import { finalizedConsensus, requireMatchingValues } from "./rpcConsensus";
import { broadcastPreparedTransaction, loadKeypair, prepareSignedTransaction } from "./transactions";

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

function currentPlanPath(environment: RewardPipelineEnvironment) {
  return resolve(environment.stateRoot, "reward-epochs", "current.json");
}

async function savePlan(environment: RewardPipelineEnvironment, plan: RewardEpochPlan) {
  await mkdir(resolve(environment.stateRoot, "reward-epochs"), { recursive: true });
  await writeFile(currentPlanPath(environment), JSON.stringify(plan, null, 2), { encoding: "utf8", mode: 0o600, flush: true });
}

export async function loadCurrentRewardPlan(environment: RewardPipelineEnvironment) {
  const plan = JSON.parse(await readFile(currentPlanPath(environment), "utf8")) as RewardEpochPlan;
  assertRewardPlanHash(plan);
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
      maxSupportedTransactionVersion: 0,
    });
    if (!block) throw new Error("HOLDER_FINALITY_BLOCK_MISSING");
    return block.blockhash;
  }));
  const blockhash = requireMatchingValues(blocks, "HOLDER_FINALITY_RPC_DISAGREEMENT");
  if (blockhash !== journal.finalizedBlockhash) throw new Error("HOLDER_FINALITY_BLOCKHASH_MISMATCH");
}

export async function prepareRewardEpoch(environment: RewardPipelineEnvironment) {
  try {
    const current = await loadCurrentRewardPlan(environment);
    if (!current.finalized) throw new Error("REWARD_EPOCH_ALREADY_ACTIVE");
  } catch (error) {
    if (error instanceof Error && error.message === "REWARD_EPOCH_ALREADY_ACTIVE") throw error;
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const journal = JSON.parse(await readFile(environment.journalPath, "utf8")) as FinalizedHolderJournal;
  if (new PublicKey(journal.capitalMint).toBase58() !== new PublicKey(environment.capitalMint).toBase58()) throw new Error("HOLDER_JOURNAL_MINT_MISMATCH");
  await verifyJournalFinality(environment, journal);
  const holder = await loadKeypair(environment.holderKeypairPath);
  const mint = new PublicKey(environment.mstrxMint);
  const connection = new Connection(environment.rpcUrls[0], "confirmed");
  const source = await getAccount(connection, mstrxAta(holder.publicKey, mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  if (source.amount < (environment.minimumRawMstrx ?? 1n)) throw new Error("HOLDER_INVENTORY_BELOW_MINIMUM");
  const plan = buildRewardEpochPlan({
    epochId: BigInt(journal.epochId),
    journal,
    fundedRawMstrx: source.amount,
    excluded: environment.excluded,
    batchSize: 3,
  });
  await savePlan(environment, plan);
  return plan;
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
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (status?.err) throw new Error(`REWARD_BATCH_FAILED:${JSON.stringify(status.err)}`);
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
    if (kind === "ata") batch.ataState = "confirmed"; else batch.state = "confirmed";
    await savePlan(environment, plan);
    return;
  }
  if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
    if (kind === "ata") {
      batch.ataState = "pending"; batch.ataSignature = undefined; batch.ataTransactionBase64 = undefined; batch.ataBlockhash = undefined; batch.ataLastValidBlockHeight = undefined;
    } else {
      batch.state = "pending"; batch.signature = undefined; batch.transactionBase64 = undefined; batch.blockhash = undefined; batch.lastValidBlockHeight = undefined;
    }
    await savePlan(environment, plan);
    return;
  }
  await broadcastPreparedTransaction({ connection, transactionBase64, signature, blockhash, lastValidBlockHeight });
  if (kind === "ata") batch.ataState = "confirmed"; else batch.state = "confirmed";
  await savePlan(environment, plan);
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
    if (batch.ataState === "pending") {
      const prepared = await prepareSignedTransaction({
        connection,
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
      batch.ataState = "confirmed";
      await savePlan(environment, plan);
    }

    if (batch.state === "submitted") await reconcileSubmitted({ environment, plan, batchIndex: index, kind: "transfer" });
    if (batch.state === "pending") {
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
      const prepared = await prepareSignedTransaction({ connection, payer: operator, additionalSigners: [holder], instructions });
      batch.state = "submitted";
      batch.signature = prepared.signature;
      batch.transactionBase64 = prepared.transactionBase64;
      batch.blockhash = prepared.blockhash;
      batch.lastValidBlockHeight = prepared.lastValidBlockHeight;
      await savePlan(environment, plan);
      await broadcastPreparedTransaction({ connection, ...prepared });
      batch.state = "confirmed";
      await savePlan(environment, plan);
    }
  }
  return plan;
}

export async function finalizeRewardEpoch(environment: RewardPipelineEnvironment) {
  const plan = await loadCurrentRewardPlan(environment);
  if (plan.batches.some((batch) => batch.state !== "confirmed")) throw new Error("REWARD_BATCHES_INCOMPLETE");
  const distributed = plan.batches.reduce((total, batch) => total + BigInt(batch.rawTotal), 0n);
  if (distributed !== BigInt(plan.fundedRawMstrx)) throw new Error("REWARD_EPOCH_NOT_CONSERVED");
  plan.finalized = true;
  await savePlan(environment, plan);
  const publicPlan = {
    epochId: plan.epochId,
    windowStart: plan.windowStart,
    windowEnd: plan.windowEnd,
    finalizedThroughSlot: plan.finalizedThroughSlot,
    fundedRawMstrx: plan.fundedRawMstrx,
    merkleRoot: plan.merkleRoot,
    planHash: plan.planHash,
    batches: plan.batches.map((batch) => ({ id: batch.id, rawTotal: batch.rawTotal, signature: batch.signature, allocations: batch.allocations })),
  };
  await mkdir(environment.publicDataRoot, { recursive: true });
  await writeFile(resolve(environment.publicDataRoot, `solana-reward-epoch-${plan.epochId}.json`), JSON.stringify(publicPlan, null, 2), { encoding: "utf8", mode: 0o644, flush: true });
  const historyRoot = resolve(environment.publicDataRoot, "snapshots");
  const historyPath = resolve(historyRoot, "history.json");
  let history: Array<{ epoch: number; windowEnd: number; mstrxRewardRaw: string; signature?: string; recipientCount: number }> = [];
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
    signature: plan.batches.at(-1)?.signature,
    recipientCount: plan.batches.reduce((count, batch) => count + batch.allocations.length, 0),
  };
  history = [entry, ...history.filter((item) => item.epoch !== entry.epoch)].slice(0, 50);
  await mkdir(historyRoot, { recursive: true });
  await writeFile(historyPath, JSON.stringify(history, null, 2), { encoding: "utf8", mode: 0o644, flush: true });
  return plan;
}
