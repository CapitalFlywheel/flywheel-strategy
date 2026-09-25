import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizedConsensus } from "./rpcConsensus";
import { assertProposalNotCreated, type SnapshotControlEnvironment } from "./governanceSnapshotControl";

vi.mock("./rpcConsensus", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./rpcConsensus")>();
  return { ...original, finalizedConsensus: vi.fn() };
});

const address = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();
const roots: string[] = [];

async function environment(): Promise<SnapshotControlEnvironment> {
  const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-snapshot-control-"));
  roots.push(stateRoot);
  return { stateRoot, publicDataRoot: stateRoot,
    rpcUrls: ["https://one.invalid", "https://two.invalid"],
    governanceProgram: address(1), expectedProgramCodeSha256: "a".repeat(64),
    capitalMint: address(2), reserveMint: address(3), reserveAuthority: address(4),
    admin: address(5), excluded: [] };
}

beforeEach(() => {
  vi.mocked(finalizedConsensus).mockResolvedValue({ slot: 100, blockhash: address(6), providers: 2 });
  vi.spyOn(Connection.prototype, "getAccountInfoAndContext").mockResolvedValue({
    context: { slot: 100 }, value: null,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(finalizedConsensus).mockReset();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), "flywheel-snapshot-control-"))) {
      throw new Error("TEST_CLEANUP_TARGET_INVALID");
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("governance snapshot refresh gate", () => {
  it("allows an uncreated proposal only when both providers show an empty PDA", async () => {
    const env = await environment();
    await expect(assertProposalNotCreated(env, "1")).resolves.toBeUndefined();
    expect(vi.mocked(Connection.prototype.getAccountInfoAndContext)).toHaveBeenCalledTimes(4);
  });

  it("rejects an existing onchain proposal even before refreshing any published files", async () => {
    const env = await environment();
    vi.mocked(Connection.prototype.getAccountInfoAndContext).mockResolvedValue({
      context: { slot: 100 }, value: { data: Buffer.alloc(1) } as never,
    });
    await expect(assertProposalNotCreated(env, "1"))
      .rejects.toThrow("GOVERNANCE_SNAPSHOT_PROPOSAL_ALREADY_CREATED");
  });

  it("rejects a durable prepared create transaction even while both RPCs show no proposal", async () => {
    const env = await environment();
    await writeFile(join(env.stateRoot, "governance-proposal-control.json"), JSON.stringify({
      state: "prepared", authorization: { proposalCreation: { proposalId: "1" } },
    }));
    await expect(assertProposalNotCreated(env, "1"))
      .rejects.toThrow("GOVERNANCE_SNAPSHOT_CREATE_IN_FLIGHT");
    expect(vi.mocked(Connection.prototype.getAccountInfoAndContext)).not.toHaveBeenCalled();
  });
});
