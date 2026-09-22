import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { assertRewardPlanHash, buildRewardEpochPlan, type FinalizedHolderJournal } from "./epochPlanner";

describe("reward epoch planner", () => {
  it("builds a conserved immutable plan from finalized CAPITAL history", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const a = Keypair.generate().publicKey.toBase58();
    const b = Keypair.generate().publicKey.toBase58();
    const journal: FinalizedHolderJournal = {
      version: 1,
      epochId: "1",
      capitalMint: mint,
      windowStart: 1_000,
      windowEnd: 2_000,
      finalizedThroughSlot: 99,
      finalizedBlockhash: "final-block",
      transfers: [
        { signature: "a", slot: 2, instructionIndex: 0, timestamp: 1_000, to: a, rawAmount: "100" },
        { signature: "b", slot: 3, instructionIndex: 0, timestamp: 1_200, to: b, rawAmount: "100" },
      ],
    };
    const plan = buildRewardEpochPlan({ epochId: 1n, journal, fundedRawMstrx: 101n, excluded: [] });
    expect(plan.batches.flatMap((batch) => batch.allocations).reduce((sum, row) => sum + BigInt(row.rawMstrx), 0n)).toBe(101n);
    expect(assertRewardPlanHash(plan)).toBe(true);
    plan.batches[0].allocations[0].rawMstrx = "999";
    expect(() => assertRewardPlanHash(plan)).toThrow("REWARD_PLAN_HASH_MISMATCH");
  });
});
