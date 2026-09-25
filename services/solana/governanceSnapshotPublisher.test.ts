import { mkdtemp, mkdir, readdir, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizedConsensus } from "./rpcConsensus";
import { readAgreedFinalizedTransaction } from "./finalizedTransfers";
import { holderCacheDigest } from "./holderJournal";
import { prepareAndPublishSolanaGovernanceSnapshot, type GovernanceTransferCache } from "./governanceSnapshotPublisher";
import { verifyGovernancePublicationDirectory } from "../../scripts/verify-governance-publication";

vi.mock("./rpcConsensus", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./rpcConsensus")>();
  return { ...original, finalizedConsensus: vi.fn() };
});

vi.mock("./finalizedTransfers", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./finalizedTransfers")>();
  return { ...original, readAgreedFinalizedTransaction: vi.fn() };
});

const address = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();
const mint = address(1);
const program = address(2);
const a = address(3);
const b = address(4);
const launchHash = address(5);
const transferHash = address(6);
const tipHash = address(7);
const consensusHash = address(8);
const nowMs = 1_800_000_000_000;
const launchTime = Math.floor(nowMs / 1_000) - 400;
const tipTime = Math.floor(nowMs / 1_000) - 100;
const rpcUrls = ["https://one.invalid", "https://two.invalid"] as const;
const roots: string[] = [];

function cache(): GovernanceTransferCache {
  const payload: Omit<GovernanceTransferCache, "digest"> = {
    version: 3, mint, launchSlot: 10, launchSignature: "launch", launchTime,
    indexedThroughSlot: 20, indexedThroughTime: tipTime,
    coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 10, throughSlot: 20, throughBlockhash: tipHash },
    transactions: [
      {
        signature: "launch", slot: 10, transactionIndex: 0, blockTime: launchTime, blockhash: launchHash,
        transfers: [{ signature: "launch", slot: 10, transactionIndex: 0, instructionIndex: 0,
          timestamp: launchTime, to: a, rawAmount: "100" }],
      },
      {
        signature: "transfer", slot: 11, transactionIndex: 1, blockTime: launchTime + 100, blockhash: transferHash,
        transfers: [{ signature: "transfer", slot: 11, transactionIndex: 1, instructionIndex: 0,
          timestamp: launchTime + 100, from: a, to: b, rawAmount: "30" }],
      },
    ],
  };
  return { ...payload, digest: holderCacheDigest(payload) };
}

function resignCache(cache: GovernanceTransferCache) {
  const { digest: _old, ...payload } = cache;
  cache.digest = holderCacheDigest(payload);
  return cache;
}

async function fixture(overrides: { cache?: GovernanceTransferCache; heartbeat?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "flywheel-governance-pub-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  const publicDataRoot = join(root, "public");
  await mkdir(join(publicDataRoot, "status"), { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  const indexed = overrides.cache ?? cache();
  await writeFile(join(stateRoot, "capital-transfers.json"), JSON.stringify(indexed));
  await writeFile(join(publicDataRoot, "config.json"), JSON.stringify({
    network: "solana-mainnet-beta", projectMint: mint, launchedAtSlot: 10, launchedAtSignature: "launch",
  }));
  await writeFile(join(publicDataRoot, "status", "solana-holder-indexer.json"), JSON.stringify(overrides.heartbeat ?? {
    service: "solana-holder-indexer", ok: true, updatedAt: nowMs - 1_000,
    detail: `finalized-slot=${indexed.indexedThroughSlot}:transactions=${indexed.transactions.length}:journal=waiting`,
  }));
  return { stateRoot, publicDataRoot };
}

function environment(roots: Awaited<ReturnType<typeof fixture>>, discover = vi.fn(async () => [
  { signature: "transfer", slot: 11, transactionIndex: 1 },
])) {
  return {
    governanceProgram: program, proposalId: 1n, windowStart: launchTime, excluded: [],
    rpcUrls, source: { discover }, ...roots, nowMs,
  };
}

beforeEach(() => {
  vi.mocked(finalizedConsensus).mockResolvedValue({ slot: 30, blockhash: consensusHash, providers: 2 });
  vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_urls, signature) => {
    if (signature === "launch") return {
      signature, slot: 10, blockTime: launchTime, blockhash: launchHash,
      transactionIndex: 0,
      deltas: [{ account: address(11), owner: a, rawAmount: "100" }],
      movements: [{ instructionIndex: 0, to: a, rawAmount: "100" }],
    };
    if (signature === "transfer") return {
      signature, slot: 11, blockTime: launchTime + 100, blockhash: transferHash,
      transactionIndex: 1,
      deltas: [
        { account: address(11), owner: a, rawAmount: "-30" },
        { account: address(12), owner: b, rawAmount: "30" },
      ],
      movements: [{ instructionIndex: 0, from: a, to: b, rawAmount: "30" }],
    };
    return undefined;
  });
  vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async (slot) => ({
    blockhash: slot === 10 ? launchHash : slot === 11 ? transferHash : tipHash,
    blockTime: slot === 10 ? launchTime : slot === 11 ? launchTime + 100 : tipTime,
    previousBlockhash: address(9), parentSlot: slot - 1,
    transactions: (slot === 10 ? ["launch"] : slot === 11 ? ["other", "transfer"] : [])
      .map((signature) => ({ version: 1, transaction: { accountKeys: [], signatures: [signature] } })),
  } as never));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(finalizedConsensus).mockReset();
  vi.mocked(readAgreedFinalizedTransaction).mockReset();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), "flywheel-governance-pub-"))) throw new Error("TEST_CLEANUP_TARGET_INVALID");
    await rm(root, { recursive: true, force: true });
  }
});

describe("governance snapshot publication from live transfer cache", () => {
  it("verifies the full-block cache against both finalized RPCs, then atomically publishes source, snapshot and wallet proofs", async () => {
    const roots = await fixture();
    const args = environment(roots);
    const result = await prepareAndPublishSolanaGovernanceSnapshot(args);
    expect(result.reused).toBe(false);
    expect(result.snapshot.entries).toHaveLength(2);
    expect(args.source.discover).not.toHaveBeenCalled();
    const published = resolve(roots.publicDataRoot, "governance", "proposals", "1");
    const snapshot = JSON.parse(await readFile(join(published, "snapshot.json"), "utf8"));
    const source = JSON.parse(await readFile(join(published, "source.json"), "utf8"));
    expect(result.manifest.version).toBe(2);
    expect(result.manifest.publishedAtUnix).toBe(Math.floor(nowMs / 1_000));
    expect(snapshot.merkleRoot).toBe(result.manifest.merkleRoot);
    expect(source.coverage.indexedThroughBlockhash).toBe(tipHash);
    expect(await verifyGovernancePublicationDirectory(published)).toMatchObject({
      proposalId: "1", merkleRoot: result.manifest.merkleRoot,
      sourceSha256: result.manifest.sourceSha256, snapshotSha256: result.manifest.snapshotSha256,
    });
    for (const entry of result.snapshot.entries) {
      const proof = JSON.parse(await readFile(join(published, "proofs", `${entry.account}.json`), "utf8"));
      expect(proof).toMatchObject({ account: entry.account, weight: entry.weight, merkleRoot: snapshot.merkleRoot });
    }
    expect((await prepareAndPublishSolanaGovernanceSnapshot(args)).reused).toBe(true);
  });

  it("refreshes a 25-minute-old uncommitted bundle and retains the complete earlier version", async () => {
    const roots = await fixture();
    const original = await prepareAndPublishSolanaGovernanceSnapshot(environment(roots));
    const laterMs = nowMs + 26 * 60_000;
    const laterTime = Math.floor(laterMs / 1_000) - 100;
    const laterHash = address(13);
    const advanced = cache();
    advanced.indexedThroughSlot = 21;
    advanced.indexedThroughTime = laterTime;
    advanced.coverage.throughSlot = 21;
    advanced.coverage.throughBlockhash = laterHash;
    resignCache(advanced);
    await writeFile(join(roots.stateRoot, "capital-transfers.json"), JSON.stringify(advanced));
    await writeFile(join(roots.publicDataRoot, "status", "solana-holder-indexer.json"), JSON.stringify({
      service: "solana-holder-indexer", ok: true, updatedAt: laterMs - 1_000,
      detail: "finalized-slot=21:transactions=2:journal=waiting",
    }));
    vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async (slot) => ({
      blockhash: slot === 10 ? launchHash : slot === 11 ? transferHash : laterHash,
      blockTime: slot === 10 ? launchTime : slot === 11 ? launchTime + 100 : laterTime,
      previousBlockhash: address(9), parentSlot: slot - 1,
      transactions: (slot === 10 ? ["launch"] : slot === 11 ? ["other", "transfer"] : [])
        .map((signature) => ({ version: 1, transaction: { accountKeys: [], signatures: [signature] } })),
    } as never));
    const assertUncommittedRefresh = vi.fn(async () => undefined);
    const refreshed = await prepareAndPublishSolanaGovernanceSnapshot({
      ...environment(roots), nowMs: laterMs, assertUncommittedRefresh,
    });
    expect(refreshed.reused).toBe(false);
    expect(refreshed.manifest.publishedAtUnix).toBe(Math.floor(laterMs / 1_000));
    expect(refreshed.manifest.merkleRoot).not.toBe(original.manifest.merkleRoot);
    expect(assertUncommittedRefresh).toHaveBeenCalledTimes(2);
    const archives = join(roots.publicDataRoot, "governance", "archives", "1");
    const names = await readdir(archives);
    expect(names).toHaveLength(1);
    expect((await verifyGovernancePublicationDirectory(join(archives, names[0]))).merkleRoot)
      .toBe(original.manifest.merkleRoot);
    expect((await verifyGovernancePublicationDirectory(refreshed.publishedPath)).merkleRoot)
      .toBe(refreshed.manifest.merkleRoot);
  });

  it("cannot replace a published bundle when the proposal-create guard rejects", async () => {
    const roots = await fixture();
    const original = await prepareAndPublishSolanaGovernanceSnapshot(environment(roots));
    const assertUncommittedRefresh = vi.fn(async () => { throw new Error("GOVERNANCE_SNAPSHOT_CREATE_IN_FLIGHT"); });
    await expect(prepareAndPublishSolanaGovernanceSnapshot({ ...environment(roots), excluded: [a],
      assertUncommittedRefresh })).rejects.toThrow("GOVERNANCE_SNAPSHOT_CREATE_IN_FLIGHT");
    expect(assertUncommittedRefresh).toHaveBeenCalledTimes(1);
    expect((await verifyGovernancePublicationDirectory(original.publishedPath)).merkleRoot)
      .toBe(original.manifest.merkleRoot);
  });

  it("rejects a future publication timestamp or changed source bytes", async () => {
    const roots = await fixture();
    const args = environment(roots);
    await prepareAndPublishSolanaGovernanceSnapshot(args);
    const target = resolve(roots.publicDataRoot, "governance", "proposals", "1");
    const manifestPath = join(target, "manifest.json");
    const original = await readFile(manifestPath, "utf8");
    const altered = JSON.parse(original);
    altered.publishedAtUnix += 60;
    await writeFile(manifestPath, `${JSON.stringify(altered, null, 2)}\n`);
    await expect(prepareAndPublishSolanaGovernanceSnapshot(args))
      .rejects.toThrow("GOVERNANCE_PUBLICATION_TIME_INVALID");
    await writeFile(manifestPath, original);
    const sourcePath = join(target, "source.json");
    await writeFile(sourcePath, "{}\n");
    await expect(prepareAndPublishSolanaGovernanceSnapshot(args))
      .rejects.toThrow("GOVERNANCE_PUBLISHED_FILES_MISMATCH");
    await expect(verifyGovernancePublicationDirectory(target)).rejects.toThrow("GOVERNANCE_PUBLICATION_INVALID");
  });

  it("refuses a locally changed or missing wallet proof even when manifest and snapshot still hash correctly", async () => {
    const roots = await fixture();
    const published = await prepareAndPublishSolanaGovernanceSnapshot(environment(roots));
    const target = resolve(roots.publicDataRoot, "governance", "proposals", "1");
    const proofPath = join(target, "proofs", `${published.snapshot.entries[0].account}.json`);
    const original = await readFile(proofPath, "utf8");
    const altered = JSON.parse(original);
    altered.weight = "999";
    await writeFile(proofPath, `${JSON.stringify(altered, null, 2)}\n`);
    await expect(verifyGovernancePublicationDirectory(target)).rejects.toThrow("GOVERNANCE_PUBLICATION_PROOFS_INVALID");
    await writeFile(proofPath, original);
    await unlink(proofPath);
    await expect(verifyGovernancePublicationDirectory(target)).rejects.toThrow("GOVERNANCE_PUBLICATION_PROOFS_INVALID");
  });

  it("cleans a failed staging directory without touching a colliding proposal, then permits a retry", async () => {
    const roots = await fixture();
    const proposals = resolve(roots.publicDataRoot, "governance", "proposals");
    const target = join(proposals, "1");
    await mkdir(target, { recursive: true });
    const marker = join(target, "do-not-touch.txt");
    await writeFile(marker, "existing proposal");

    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(roots))).rejects.toThrow();
    expect(await readdir(proposals)).toEqual(["1"]);
    expect(await readFile(marker, "utf8")).toBe("existing proposal");

    await unlink(marker);
    await rmdir(target);
    const result = await prepareAndPublishSolanaGovernanceSnapshot(environment(roots));
    expect(result.reused).toBe(false);
    expect(await readdir(proposals)).toEqual(["1"]);
    expect((await readFile(join(target, "manifest.json"), "utf8")).length).toBeGreaterThan(0);
  });

  it("requires the exact governance lookback start derived from the verified finalized tip", async () => {
    const roots = await fixture();
    await expect(prepareAndPublishSolanaGovernanceSnapshot({
      ...environment(roots), windowStart: launchTime + 1,
    })).rejects.toThrow("GOVERNANCE_WINDOW_START_MISMATCH");
    expect(finalizedConsensus).toHaveBeenCalled();
    expect(readAgreedFinalizedTransaction).not.toHaveBeenCalled();
  });

  it("rejects a forged cached token amount or recipient despite matching block signatures", async () => {
    const amount = cache();
    amount.transactions[1].transfers[0].rawAmount = "31";
    const amountRoots = await fixture({ cache: resignCache(amount) });
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(amountRoots)))
      .rejects.toThrow("GOVERNANCE_CACHED_MOVEMENT_MISMATCH");

    const recipient = cache();
    recipient.transactions[1].transfers[0].to = address(13);
    const recipientRoots = await fixture({ cache: resignCache(recipient) });
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(recipientRoots)))
      .rejects.toThrow("GOVERNANCE_CACHED_MOVEMENT_MISMATCH");
    expect(readAgreedFinalizedTransaction).toHaveBeenCalledWith(rpcUrls, "transfer", mint, { includeOrderedMovements: true });
  });

  it("fails closed when an old cached transaction cannot be re-read from both finalized RPCs", async () => {
    vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_urls, signature) =>
      signature === "transfer" ? undefined : {
        signature, slot: 10, blockTime: launchTime, blockhash: launchHash,
        transactionIndex: 0,
        deltas: [{ account: address(11), owner: a, rawAmount: "100" }],
        movements: [{ instructionIndex: 0, to: a, rawAmount: "100" }],
      });
    const roots = await fixture();
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(roots)))
      .rejects.toThrow("GOVERNANCE_CACHED_TRANSACTION_UNVERIFIED");
  });

  it("does not depend on an incomplete vendor transfer feed once full-block provenance is verified", async () => {
    const roots = await fixture();
    const args = environment(roots, vi.fn(async () => []));
    const result = await prepareAndPublishSolanaGovernanceSnapshot(args);
    expect(result.reused).toBe(false);
    expect(args.source.discover).not.toHaveBeenCalled();
    expect((await readFile(resolve(roots.publicDataRoot, "governance", "proposals", "1", "manifest.json"), "utf8")).length)
      .toBeGreaterThan(0);
  });

  it("rejects pre-full-scan caches and forged coverage provenance", async () => {
    for (const version of [1, 2]) {
      const old = { ...cache(), version } as unknown as GovernanceTransferCache;
      const roots = await fixture({ cache: old });
      await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(roots)))
        .rejects.toThrow("HOLDER_INDEX_CACHE_INTEGRITY_INVALID");
    }
    const forged = cache();
    forged.coverage.throughSlot = 19;
    const roots = await fixture({ cache: forged });
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(roots)))
      .rejects.toThrow("HOLDER_INDEX_CACHE_INTEGRITY_INVALID");
    expect(readAgreedFinalizedTransaction).not.toHaveBeenCalled();
  });

  it("rejects a pre-digest or tampered v3 cache before any RPC publication work", async () => {
    const undigested = cache();
    delete (undigested as Partial<GovernanceTransferCache>).digest;
    const oldRoots = await fixture({ cache: undigested });
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(oldRoots)))
      .rejects.toThrow("HOLDER_INDEX_CACHE_INTEGRITY_INVALID");

    const tampered = cache();
    tampered.transactions[1].transfers[0].rawAmount = "999";
    const tamperedRoots = await fixture({ cache: tampered });
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(tamperedRoots)))
      .rejects.toThrow("HOLDER_INDEX_CACHE_DIGEST_MISMATCH");
    expect(finalizedConsensus).not.toHaveBeenCalled();
  });

  it("rejects a later canonical transaction whose block time rewinds holder age", async () => {
    const regressed = cache();
    regressed.transactions.push({
      signature: "later", slot: 12, transactionIndex: 0,
      blockTime: launchTime + 50, blockhash: address(14),
      transfers: [{ signature: "later", slot: 12, transactionIndex: 0, instructionIndex: 0,
        timestamp: launchTime + 50, from: b, to: a, rawAmount: "1" }],
    });
    const roots = await fixture({ cache: resignCache(regressed) });
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(roots)))
      .rejects.toThrow("GOVERNANCE_TRANSFER_CACHE_INVALID");
    expect(readAgreedFinalizedTransaction).not.toHaveBeenCalled();
  });

  it("rejects stale or mismatched indexer coverage before RPC work", async () => {
    const roots = await fixture({ heartbeat: {
      service: "solana-holder-indexer", ok: true, updatedAt: nowMs - 13 * 60_000,
      detail: "finalized-slot=20:transactions=2:journal=waiting",
    } });
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(roots)))
      .rejects.toThrow("GOVERNANCE_INDEXER_COVERAGE_UNVERIFIED");
    expect(finalizedConsensus).not.toHaveBeenCalled();
  });

  it("rejects stale transfer coverage even with a fresh heartbeat", async () => {
    const laterMs = nowMs + 26 * 60_000;
    const roots = await fixture({ heartbeat: {
      service: "solana-holder-indexer", ok: true, updatedAt: laterMs - 1_000,
      detail: "finalized-slot=20:transactions=2:journal=waiting",
    } });
    await expect(prepareAndPublishSolanaGovernanceSnapshot({ ...environment(roots), nowMs: laterMs }))
      .rejects.toThrow("GOVERNANCE_TRANSFER_CACHE_STALE");
    expect(finalizedConsensus).not.toHaveBeenCalled();
  });

  it("requires both RPC providers to agree on every cached transaction block", async () => {
    let transferBlockReads = 0;
    vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async (slot) => ({
      blockhash: slot === 10 ? launchHash : slot === 11 && ++transferBlockReads === 2 ? address(10)
        : slot === 11 ? transferHash : tipHash,
      blockTime: slot === 10 ? launchTime : slot === 11 ? launchTime + 100 : tipTime,
      previousBlockhash: address(9), parentSlot: slot - 1,
      transactions: (slot === 10 ? ["launch"] : slot === 11 ? ["other", "transfer"] : [])
        .map((signature) => ({ version: 1, transaction: { accountKeys: [], signatures: [signature] } })),
    } as never));
    const roots = await fixture();
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(roots)))
      .rejects.toThrow("GOVERNANCE_BLOCK_RPC_DISAGREEMENT");
  });

  it("rejects a missing launch anchor and a reorged cached transaction", async () => {
    const invalid = cache();
    invalid.transactions = invalid.transactions.slice(1);
    const missing = await fixture({ cache: resignCache(invalid) });
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(missing)))
      .rejects.toThrow("GOVERNANCE_LAUNCH_COVERAGE_MISSING");

    const reorged = cache();
    reorged.transactions[1].blockhash = address(10);
    const roots = await fixture({ cache: resignCache(reorged) });
    await expect(prepareAndPublishSolanaGovernanceSnapshot(environment(roots)))
      .rejects.toThrow("GOVERNANCE_CACHED_TRANSFER_REORGED");
  });
});
