import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { buildPushDistribution, SolanaHoldingEngine, type SolanaTransfer } from "./holderAccounting";
import { buildRewardMerkle } from "./rewardMerkle";

export interface FinalizedHolderJournal {
  version: 1;
  epochId: string;
  capitalMint: string;
  windowStart: number;
  windowEnd: number;
  finalizedThroughSlot: number;
  finalizedBlockhash: string;
  transfers: Array<Omit<SolanaTransfer, "rawAmount"> & { rawAmount: string }>;
}

export interface RewardEpochPlan {
  version: 1;
  epochId: string;
  capitalMint: string;
  windowStart: number;
  windowEnd: number;
  finalizedThroughSlot: number;
  finalizedBlockhash: string;
  fundedRawMstrx: string;
  totalWeight: string;
  merkleRoot: string;
  planHash: string;
  finalized: boolean;
  batches: Array<{
    id: string;
    rawTotal: string;
    state: "pending" | "submitted" | "confirmed";
    signature?: string;
    transactionBase64?: string;
    blockhash?: string;
    lastValidBlockHeight?: number;
    ataState: "pending" | "submitted" | "confirmed";
    ataSignature?: string;
    ataTransactionBase64?: string;
    ataBlockhash?: string;
    ataLastValidBlockHeight?: number;
    allocations: Array<{ recipient: string; rawMstrx: string; proof: string[] }>;
  }>;
}

function canonicalPlanPayload(plan: Omit<RewardEpochPlan, "planHash">) {
  return JSON.stringify({
    version: plan.version,
    epochId: plan.epochId,
    capitalMint: plan.capitalMint,
    windowStart: plan.windowStart,
    windowEnd: plan.windowEnd,
    finalizedThroughSlot: plan.finalizedThroughSlot,
    finalizedBlockhash: plan.finalizedBlockhash,
    fundedRawMstrx: plan.fundedRawMstrx,
    totalWeight: plan.totalWeight,
    merkleRoot: plan.merkleRoot,
    batches: plan.batches.map((batch) => ({
      id: batch.id,
      rawTotal: batch.rawTotal,
      allocations: batch.allocations,
    })),
  });
}

export function assertRewardPlanHash(plan: RewardEpochPlan) {
  const { planHash: _ignored, ...withoutHash } = plan;
  const expected = createHash("sha256").update(canonicalPlanPayload(withoutHash)).digest("hex");
  if (expected !== plan.planHash) throw new Error("REWARD_PLAN_HASH_MISMATCH");
  return true;
}

export function buildRewardEpochPlan(args: {
  epochId: bigint;
  journal: FinalizedHolderJournal;
  fundedRawMstrx: bigint;
  excluded: Iterable<string>;
  batchSize?: number;
}): RewardEpochPlan {
  const { journal } = args;
  new PublicKey(journal.capitalMint);
  if (journal.version !== 1 || journal.windowEnd <= journal.windowStart) throw new Error("HOLDER_JOURNAL_INVALID");
  if (BigInt(journal.epochId) <= 0n || BigInt(journal.epochId) !== args.epochId) throw new Error("HOLDER_EPOCH_ID_MISMATCH");
  if (!Number.isInteger(journal.finalizedThroughSlot) || journal.finalizedThroughSlot <= 0 || !journal.finalizedBlockhash) throw new Error("HOLDER_FINALITY_EVIDENCE_INVALID");
  const engine = new SolanaHoldingEngine(journal.windowStart, journal.windowEnd, args.excluded);
  const transfers = journal.transfers.map((transfer) => ({ ...transfer, rawAmount: BigInt(transfer.rawAmount) }))
    .sort((a, b) => a.slot - b.slot || a.instructionIndex - b.instructionIndex || a.signature.localeCompare(b.signature));
  if (transfers.some((transfer) => transfer.slot > journal.finalizedThroughSlot)) throw new Error("HOLDER_TRANSFER_NOT_FINALIZED");
  for (const transfer of transfers) engine.apply(transfer);
  const distribution = buildPushDistribution(engine.finalize(), args.fundedRawMstrx, args.batchSize ?? 3);
  const merkle = buildRewardMerkle(args.epochId, distribution.allocations);
  const proofByRecipient = new Map(merkle.payments.map((payment) => [payment.recipient, payment.proof.map((node) => node.toString("hex"))]));
  const base: Omit<RewardEpochPlan, "planHash"> = {
    version: 1,
    epochId: args.epochId.toString(),
    capitalMint: new PublicKey(journal.capitalMint).toBase58(),
    windowStart: journal.windowStart,
    windowEnd: journal.windowEnd,
    finalizedThroughSlot: journal.finalizedThroughSlot,
    finalizedBlockhash: journal.finalizedBlockhash,
    fundedRawMstrx: distribution.fundedRawMstrx.toString(),
    totalWeight: distribution.totalWeight.toString(),
    merkleRoot: merkle.root.toString("hex"),
    finalized: false,
    batches: distribution.batches.map((batch) => ({
      id: batch.id,
      rawTotal: batch.rawTotal.toString(),
      state: "pending",
      ataState: "pending",
      allocations: batch.allocations.map((allocation) => ({
        recipient: allocation.recipient,
        rawMstrx: allocation.rawMstrx.toString(),
        proof: proofByRecipient.get(allocation.recipient) ?? [],
      })),
    })),
  };
  const planHash = createHash("sha256").update(canonicalPlanPayload(base)).digest("hex");
  return { ...base, planHash };
}
