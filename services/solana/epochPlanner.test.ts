import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { assertRewardPlanHash, buildRewardEpochPlan, type FinalizedHolderJournal } from "./epochPlanner";

const owedEscrow = {
  mstrxMint: Keypair.generate().publicKey.toBase58(),
  owedEscrowOwner: Keypair.generate().publicKey.toBase58(),
  owedEscrowAddress: Keypair.generate().publicKey.toBase58(),
};

describe("reward epoch planner", () => {
  it("builds a conserved immutable plan from finalized CAPITAL history", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const a = Keypair.generate().publicKey.toBase58();
    const b = Keypair.generate().publicKey.toBase58();
    const journal: FinalizedHolderJournal = {
      version: 3,
      epochId: "1",
      capitalMint: mint,
      launchSignature: "launch-tx",
      windowStart: 1_000,
      windowEnd: 2_000,
      finalizedThroughSlot: 99,
      finalizedBlockhash: "final-block",
      coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 2, throughSlot: 99, throughBlockhash: "final-block" },
      transfers: [
        { signature: "a", slot: 2, transactionIndex: 0, instructionIndex: 0, timestamp: 1_000, to: a, rawAmount: "100" },
        { signature: "b", slot: 3, transactionIndex: 0, instructionIndex: 0, timestamp: 1_200, to: b, rawAmount: "100" },
      ],
    };
    const plan = buildRewardEpochPlan({ epochId: 1n, journal, fundedRawMstrx: 101n, excluded: [], ...owedEscrow });
    expect(plan.batches.flatMap((batch) => batch.allocations).reduce((sum, row) => sum + BigInt(row.rawMstrx), 0n)).toBe(101n);
    expect(assertRewardPlanHash(plan)).toBe(true);
    for (const version of [1, 2]) {
      expect(() => assertRewardPlanHash({ ...plan, version } as unknown as typeof plan)).toThrow("REWARD_PLAN_VERSION_UNSUPPORTED");
      expect(() => buildRewardEpochPlan({ epochId: 1n, journal: { ...journal, version } as unknown as FinalizedHolderJournal, fundedRawMstrx: 101n, excluded: [], ...owedEscrow }))
        .toThrow("HOLDER_JOURNAL_INVALID");
    }
    expect(() => buildRewardEpochPlan({ epochId: 1n, journal: { ...journal, coverage: { ...journal.coverage, fromSlot: 100 } }, fundedRawMstrx: 101n, excluded: [], ...owedEscrow }))
      .toThrow("HOLDER_FULL_BLOCK_COVERAGE_INVALID");
    expect(() => assertRewardPlanHash({ ...plan, coverage: { ...plan.coverage, throughBlockhash: "wrong" } }))
      .toThrow("HOLDER_FULL_BLOCK_COVERAGE_INVALID");
    // Later epochs replay launch-to-date transfers to reconstruct held lots;
    // those historical events legitimately predate the next window start.
    expect(() => buildRewardEpochPlan({ epochId: 2n, journal: { ...journal, epochId: "2", windowStart: 1_500, windowEnd: 2_500 }, fundedRawMstrx: 101n, excluded: [], ...owedEscrow }))
      .not.toThrow();
    plan.batches[0].allocations[0].rawMstrx = "999";
    expect(() => assertRewardPlanHash(plan)).toThrow("REWARD_PLAN_HASH_MISMATCH");
  });

  it("rejects future or regressing block times in finalized slot and instruction order", () => {
    const a = Keypair.generate().publicKey.toBase58();
    const journal: FinalizedHolderJournal = {
      version: 3, epochId: "1", capitalMint: Keypair.generate().publicKey.toBase58(), launchSignature: "launch-tx",
      windowStart: 1_000, windowEnd: 2_000, finalizedThroughSlot: 20, finalizedBlockhash: "final-block",
      coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 2, throughSlot: 20, throughBlockhash: "final-block" },
      transfers: [
        { signature: "first", slot: 2, transactionIndex: 0, instructionIndex: 0, timestamp: 1_100, to: a, rawAmount: "100" },
        { signature: "second", slot: 3, transactionIndex: 0, instructionIndex: 0, timestamp: 1_200, from: a, to: a, rawAmount: "1" },
      ],
    };
    const plan = (source: FinalizedHolderJournal) => buildRewardEpochPlan({ epochId: 1n, journal: source, fundedRawMstrx: 100n, excluded: [], ...owedEscrow });
    expect(() => plan({ ...journal, transfers: [journal.transfers[0], { ...journal.transfers[1], timestamp: 2_001 }] }))
      .toThrow("HOLDER_TRANSFER_TIME_OUT_OF_WINDOW");
    expect(() => plan({ ...journal, transfers: [journal.transfers[0], { ...journal.transfers[1], timestamp: 1_099 }] }))
      .toThrow("HOLDER_TRANSFER_TIME_REGRESSION");
    expect(() => plan({ ...journal, transfers: [{ ...journal.transfers[0], timestamp: 999 }, journal.transfers[1]] }))
      .toThrow("HOLDER_TRANSFER_TIME_OUT_OF_WINDOW");
    expect(() => plan({ ...journal, transfers: [{ ...journal.transfers[0], transactionIndex: undefined }, journal.transfers[1]] }))
      .toThrow("HOLDER_TRANSFER_ORDER_INVALID");
  });
});
