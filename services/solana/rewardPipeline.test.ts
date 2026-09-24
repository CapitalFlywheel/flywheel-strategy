import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildRewardEpochPlan, type FinalizedHolderJournal } from "./epochPlanner";
import { assertHolderJournalReady, finalizeRewardEpoch, type RewardPipelineEnvironment } from "./rewardPipeline";

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

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("public Solana reward epoch history", () => {
  it("publishes a finalized epoch beneath the public snapshots route", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-solana-reward-"));
    temporaryRoots.push(root);
    const stateRoot = join(root, "state");
    const publicDataRoot = join(root, "public");
    const journal: FinalizedHolderJournal = {
      version: 1,
      epochId: "1",
      capitalMint: Keypair.generate().publicKey.toBase58(),
      windowStart: 1_000,
      windowEnd: 2_000,
      finalizedThroughSlot: 99,
      finalizedBlockhash: "final-block",
      transfers: [{
        signature: "transfer",
        slot: 2,
        instructionIndex: 0,
        timestamp: 1_000,
        to: Keypair.generate().publicKey.toBase58(),
        rawAmount: "100",
      }],
    };
    const plan = buildRewardEpochPlan({ epochId: 1n, journal, fundedRawMstrx: 100n, excluded: [] });
    expect(plan.batches).toHaveLength(1);
    plan.batches[0].ataState = "confirmed";
    plan.batches[0].state = "confirmed";
    plan.batches[0].signature = "payout-signature";
    await mkdir(join(stateRoot, "reward-epochs"), { recursive: true });
    await writeFile(join(stateRoot, "reward-epochs", "current.json"), JSON.stringify(plan));
    const environment = { stateRoot, publicDataRoot } as RewardPipelineEnvironment;

    await finalizeRewardEpoch(environment);

    const detail = JSON.parse(await readFile(resolve(publicDataRoot, "snapshots", "solana-reward-epoch-1.json"), "utf8"));
    const history = JSON.parse(await readFile(resolve(publicDataRoot, "snapshots", "history.json"), "utf8"));
    expect(detail.epochId).toBe("1");
    expect(detail.fundedRawMstrx).toBe("100");
    expect(history).toMatchObject([{ epoch: 1, mstrxRewardRaw: "100", signature: "payout-signature" }]);
    expect((await readFile(join(stateRoot, "reward-epochs", "current.json"), "utf8"))).toContain('"finalized": true');
  });
});
