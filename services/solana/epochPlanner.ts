import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { buildPushDistribution, SolanaHoldingEngine, type SolanaTransfer } from "./holderAccounting";
import { buildRewardMerkle } from "./rewardMerkle";

export interface FinalizedFullBlockCoverage {
  kind: "two-rpc-finalized-full-blocks";
  fromSlot: number;
  throughSlot: number;
  throughBlockhash: string;
}

export function assertFinalizedFullBlockCoverage(
  coverage: FinalizedFullBlockCoverage, finalizedThroughSlot: number, finalizedBlockhash: string,
) {
  if (coverage?.kind !== "two-rpc-finalized-full-blocks"
    || !Number.isSafeInteger(coverage.fromSlot) || coverage.fromSlot <= 0
    || !Number.isSafeInteger(coverage.throughSlot) || coverage.throughSlot < coverage.fromSlot
    || coverage.throughSlot !== finalizedThroughSlot
    || !coverage.throughBlockhash || coverage.throughBlockhash !== finalizedBlockhash) {
    throw new Error("HOLDER_FULL_BLOCK_COVERAGE_INVALID");
  }
  return true;
}

export interface FinalizedHolderJournal {
  version: 3;
  epochId: string;
  capitalMint: string;
  launchSignature: string;
  windowStart: number;
  windowEnd: number;
  finalizedThroughSlot: number;
  finalizedBlockhash: string;
  coverage: FinalizedFullBlockCoverage;
  transfers: Array<Omit<SolanaTransfer, "rawAmount"> & { rawAmount: string }>;
}

export interface RewardEpochPlan {
  version: 4;
  epochId: string;
  capitalMint: string;
  mstrxMint: string;
  launchSignature: string;
  windowStart: number;
  windowEnd: number;
  finalizedThroughSlot: number;
  finalizedBlockhash: string;
  coverage: FinalizedFullBlockCoverage;
  fundedRawMstrx: string;
  totalWeight: string;
  merkleRoot: string;
  planHash: string;
  finalized: boolean;
  owedEscrow: {
    owner: string;
    address: string;
    seed: string;
    state: "pending" | "submitted" | "confirmed";
    signature?: string;
    transactionBase64?: string;
    blockhash?: string;
    lastValidBlockHeight?: number;
  };
  batches: Array<{
    id: string;
    rawTotal: string;
    state: "pending" | "submitted" | "confirmed" | "isolating";
    signature?: string;
    transactionBase64?: string;
    blockhash?: string;
    lastValidBlockHeight?: number;
    ataState: "pending" | "submitted" | "confirmed" | "isolating";
    ataSignature?: string;
    ataTransactionBase64?: string;
    ataBlockhash?: string;
    ataLastValidBlockHeight?: number;
    originalFailure?: { kind: "ata" | "transfer"; evidence: "simulation" | "finalized"; signature?: string };
    allocations: Array<{
      recipient: string;
      rawMstrx: string;
      proof: string[];
      delivery?: {
        state: "pending" | "paid" | "owed";
        ata: RewardSignedStep;
        transfer: RewardSignedStep;
        escrow: RewardSignedStep;
        rejection?: { stage: "ata" | "transfer"; evidence: "simulation" | "finalized"; signature?: string };
      };
    }>;
  }>;
}

export interface RewardSignedStep {
  state: "pending" | "submitted" | "confirmed" | "rejected";
  signature?: string;
  transactionBase64?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
}

export function owedEscrowSeed(capitalMint: string, epochId: bigint) {
  if (epochId <= 0n) throw new Error("OWED_ESCROW_EPOCH_INVALID");
  return createHash("sha256").update(`flywheel-owed-v1:${new PublicKey(capitalMint).toBase58()}:${epochId}`).digest("hex").slice(0, 32);
}

function canonicalPlanPayload(plan: Omit<RewardEpochPlan, "planHash">) {
  return JSON.stringify({
    version: plan.version,
    epochId: plan.epochId,
    capitalMint: plan.capitalMint,
    mstrxMint: plan.mstrxMint,
    launchSignature: plan.launchSignature,
    windowStart: plan.windowStart,
    windowEnd: plan.windowEnd,
    finalizedThroughSlot: plan.finalizedThroughSlot,
    finalizedBlockhash: plan.finalizedBlockhash,
    coverage: plan.coverage,
    fundedRawMstrx: plan.fundedRawMstrx,
    totalWeight: plan.totalWeight,
    merkleRoot: plan.merkleRoot,
    owedEscrow: {
      owner: plan.owedEscrow.owner,
      address: plan.owedEscrow.address,
      seed: plan.owedEscrow.seed,
    },
    batches: plan.batches.map((batch) => ({
      id: batch.id,
      rawTotal: batch.rawTotal,
      allocations: batch.allocations.map(({ recipient, rawMstrx, proof }) => ({ recipient, rawMstrx, proof })),
    })),
  });
}

export function assertRewardPlanHash(plan: RewardEpochPlan) {
  if (plan.version !== 4) throw new Error("REWARD_PLAN_VERSION_UNSUPPORTED");
  assertFinalizedFullBlockCoverage(plan.coverage, plan.finalizedThroughSlot, plan.finalizedBlockhash);
  if (new PublicKey(plan.mstrxMint).toBase58() !== plan.mstrxMint
    || !plan.owedEscrow || new PublicKey(plan.owedEscrow.owner).toBase58() !== plan.owedEscrow.owner
    || new PublicKey(plan.owedEscrow.address).toBase58() !== plan.owedEscrow.address
    || plan.owedEscrow.seed !== owedEscrowSeed(plan.capitalMint, BigInt(plan.epochId))) {
    throw new Error("REWARD_OWED_ESCROW_IDENTITY_INVALID");
  }
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
  mstrxMint: string;
  owedEscrowOwner: string;
  owedEscrowAddress: string;
  batchSize?: number;
}): RewardEpochPlan {
  const { journal } = args;
  new PublicKey(journal.capitalMint);
  if (journal.version !== 3 || typeof journal.launchSignature !== "string" || !journal.launchSignature
    || !Number.isSafeInteger(journal.windowStart) || journal.windowStart < 0
    || !Number.isSafeInteger(journal.windowEnd) || journal.windowEnd <= journal.windowStart) {
    throw new Error("HOLDER_JOURNAL_INVALID");
  }
  if (BigInt(journal.epochId) <= 0n || BigInt(journal.epochId) !== args.epochId) throw new Error("HOLDER_EPOCH_ID_MISMATCH");
  if (!Number.isInteger(journal.finalizedThroughSlot) || journal.finalizedThroughSlot <= 0 || !journal.finalizedBlockhash) throw new Error("HOLDER_FINALITY_EVIDENCE_INVALID");
  assertFinalizedFullBlockCoverage(journal.coverage, journal.finalizedThroughSlot, journal.finalizedBlockhash);
  const engine = new SolanaHoldingEngine(journal.windowStart, journal.windowEnd, args.excluded);
  const transfers = journal.transfers.map((transfer) => ({ ...transfer, rawAmount: BigInt(transfer.rawAmount) }))
    .sort((a, b) => a.slot - b.slot || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) || a.instructionIndex - b.instructionIndex || a.signature.localeCompare(b.signature));
  if (transfers.some((transfer) => transfer.slot > journal.finalizedThroughSlot)) throw new Error("HOLDER_TRANSFER_NOT_FINALIZED");
  let previousTimestamp: number | undefined;
  for (const transfer of transfers) {
    if (!Number.isSafeInteger(transfer.slot) || transfer.slot <= 0
      || !Number.isSafeInteger(transfer.transactionIndex) || (transfer.transactionIndex ?? -1) < 0
      || !Number.isSafeInteger(transfer.instructionIndex) || transfer.instructionIndex < 0) {
      throw new Error("HOLDER_TRANSFER_ORDER_INVALID");
    }
    if (!Number.isSafeInteger(transfer.timestamp) || transfer.timestamp < 0
      || transfer.timestamp > journal.windowEnd
      || args.epochId === 1n && transfer.timestamp < journal.windowStart) {
      throw new Error("HOLDER_TRANSFER_TIME_OUT_OF_WINDOW");
    }
    if (previousTimestamp !== undefined && transfer.timestamp < previousTimestamp) {
      throw new Error("HOLDER_TRANSFER_TIME_REGRESSION");
    }
    previousTimestamp = transfer.timestamp;
    engine.apply(transfer);
  }
  const distribution = buildPushDistribution(engine.finalize(), args.fundedRawMstrx, args.batchSize ?? 3);
  const merkle = buildRewardMerkle(args.epochId, distribution.allocations);
  const proofByRecipient = new Map(merkle.payments.map((payment) => [payment.recipient, payment.proof.map((node) => node.toString("hex"))]));
  const base: Omit<RewardEpochPlan, "planHash"> = {
    version: 4,
    epochId: args.epochId.toString(),
    capitalMint: new PublicKey(journal.capitalMint).toBase58(),
    mstrxMint: new PublicKey(args.mstrxMint).toBase58(),
    launchSignature: journal.launchSignature,
    windowStart: journal.windowStart,
    windowEnd: journal.windowEnd,
    finalizedThroughSlot: journal.finalizedThroughSlot,
    finalizedBlockhash: journal.finalizedBlockhash,
    coverage: { ...journal.coverage },
    fundedRawMstrx: distribution.fundedRawMstrx.toString(),
    totalWeight: distribution.totalWeight.toString(),
    merkleRoot: merkle.root.toString("hex"),
    finalized: false,
    owedEscrow: {
      owner: new PublicKey(args.owedEscrowOwner).toBase58(),
      address: new PublicKey(args.owedEscrowAddress).toBase58(),
      seed: owedEscrowSeed(journal.capitalMint, args.epochId),
      state: "pending",
    },
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
