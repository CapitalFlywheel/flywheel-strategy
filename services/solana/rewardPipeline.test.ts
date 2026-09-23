import { describe, expect, it } from "vitest";
import { assertHolderJournalReady } from "./rewardPipeline";
import type { FinalizedHolderJournal } from "./epochPlanner";

const journal: FinalizedHolderJournal = {
  version: 1,
  epochId: "2",
  capitalMint: "test-mint",
  windowStart: 1_000,
  windowEnd: 4_600,
  finalizedThroughSlot: 100,
  finalizedBlockhash: "test-blockhash",
  transfers: [],
};
const heartbeat = { service: "solana-holder-indexer", ok: true, updatedAt: 5_000_000 };
const previous = { epochId: "1", windowEnd: 1_000, finalized: true };

function ready(overrides: Partial<Parameters<typeof assertHolderJournalReady>[0]> = {}) {
  return () => assertHolderJournalReady({
    journal, previous, heartbeat, latestFinalizedTime: 5_200, nowMs: 5_050_000,
    ...overrides,
  });
}

describe("holder journal payout gate", () => {
  it("accepts a fresh indexed epoch after a finalized predecessor", () => {
    expect(ready()).not.toThrow();
  });

  it("rejects an old or unhealthy indexer heartbeat", () => {
    expect(ready({ heartbeat: { ...heartbeat, ok: false } })).toThrow("HOLDER_INDEXER_UNHEALTHY");
    expect(ready({ heartbeat: { ...heartbeat, updatedAt: 4_000_000 } })).toThrow("HOLDER_INDEXER_UNHEALTHY");
    expect(ready({ heartbeat: { ...heartbeat, updatedAt: 6_000_000 } })).toThrow("HOLDER_INDEXER_UNHEALTHY");
  });

  it("rejects a stale or future-dated holder window", () => {
    expect(ready({ latestFinalizedTime: 6_401 })).toThrow("HOLDER_JOURNAL_STALE");
    expect(ready({ latestFinalizedTime: 4_599 })).toThrow("HOLDER_JOURNAL_STALE");
  });

  it("rejects replay of a paid epoch and a gap in epoch windows", () => {
    expect(ready({ journal: { ...journal, epochId: "1" } })).toThrow("HOLDER_JOURNAL_EPOCH_NOT_ADVANCED");
    expect(ready({ journal: { ...journal, windowStart: 1_001 } })).toThrow("HOLDER_JOURNAL_EPOCH_NOT_ADVANCED");
    expect(ready({ previous: { ...previous, finalized: false } })).toThrow("HOLDER_JOURNAL_EPOCH_NOT_ADVANCED");
  });
});
