import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshHolderJournal, type MintTransferSource } from "./holderJournal";
import { readAgreedFinalizedTransaction } from "./finalizedTransfers";
import { buildRewardEpochPlan } from "./epochPlanner";

vi.mock("./finalizedTransfers", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./finalizedTransfers")>();
  return { ...original, readAgreedFinalizedTransaction: vi.fn() };
});

const mint = Keypair.generate().publicKey.toBase58();
const holder = Keypair.generate().publicKey.toBase58();
const pool = Keypair.generate().publicKey.toBase58();
const temporary: string[] = [];
afterEach(async () => {
  vi.mocked(readAgreedFinalizedTransaction).mockReset();
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("holder journal recovery", () => {
  it("persists an ordered same-signature sell and rebuy even when the net balance is zero", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_urls, signature) => signature === "launch" ? {
      signature, slot: 10, blockTime: 100, blockhash: "launch-block", transactionIndex: 0,
      deltas: [{ account: holder, owner: holder, rawAmount: "100" }],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: "100" }],
    } : {
      signature, slot: 11, blockTime: 200, blockhash: "trade-block", transactionIndex: 1, deltas: [],
      movements: [
        { instructionIndex: 0, from: holder, to: pool, rawAmount: "100" },
        { instructionIndex: 1, from: pool, to: holder, rawAmount: "100" },
      ],
    });
    const environment = {
      rpcUrls: ["https://one.invalid", "https://two.invalid"] as const,
      stateRoot, journalPath: resolve(stateRoot, "journal.json"), mint,
      launchSlot: 10, launchSignature: "launch", launchTime: 100, epochSeconds: 300,
    };
    const source: MintTransferSource = {
      discover: async () => { throw new Error("BITQUERY_MUST_NOT_AUTHORIZE_REWARDS"); },
      discoverFinalizedBlocks: async () => [
        { signature: "launch", slot: 10, transactionIndex: 0, blockhash: "launch-block", blockTime: 100 },
        { signature: "roundtrip", slot: 11, transactionIndex: 1, blockhash: "trade-block", blockTime: 200 },
      ], acknowledgeFinalizedBlocks: async () => undefined,
    };
    await refreshHolderJournal({ environment, source, finalizedThroughSlot: 20,
      finalizedThroughTime: 500, finalizedBlockhash: "tip-block" });
    const journal = JSON.parse(await readFile(environment.journalPath, "utf8"));
    expect(journal.version).toBe(3);
    expect(journal.coverage).toEqual({ kind: "two-rpc-finalized-full-blocks", fromSlot: 10,
      throughSlot: 20, throughBlockhash: "tip-block" });
    expect(journal.transfers.filter((row: { signature: string }) => row.signature === "roundtrip"))
      .toMatchObject([
        { instructionIndex: 0, from: holder, to: pool, rawAmount: "100" },
        { instructionIndex: 1, from: pool, to: holder, rawAmount: "100" },
      ]);
    expect(readAgreedFinalizedTransaction).toHaveBeenCalledWith(environment.rpcUrls, "roundtrip", mint,
      { includeOrderedMovements: true, agreedBlockPosition: {
        signature: "roundtrip", slot: 11, transactionIndex: 1, blockhash: "trade-block", blockTime: 200,
      } });
  });

  it("rejects a parsed transaction that conflicts with the attested full-block proof before ACK", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    vi.mocked(readAgreedFinalizedTransaction).mockResolvedValue({ signature: "launch", slot: 10,
      blockTime: 100, blockhash: "different-hash", transactionIndex: 0, deltas: [],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: "100" }] });
    const acknowledge = vi.fn(async () => undefined);
    const source: MintTransferSource = {
      discover: async () => { throw new Error("BITQUERY_MUST_NOT_AUTHORIZE_REWARDS"); },
      discoverFinalizedBlocks: async () => [
        { signature: "launch", slot: 10, transactionIndex: 0, blockhash: "expected-hash", blockTime: 100 },
      ], acknowledgeFinalizedBlocks: acknowledge,
    };
    await expect(refreshHolderJournal({
      environment: { rpcUrls: ["https://one.invalid", "https://two.invalid"], stateRoot,
        journalPath: resolve(stateRoot, "journal.json"), mint, launchSlot: 10,
        launchSignature: "launch", launchTime: 100, epochSeconds: 300 },
      source, finalizedThroughSlot: 20, finalizedThroughTime: 500, finalizedBlockhash: "tip",
    })).rejects.toThrow("HOLDER_INDEX_TRANSACTION_UNVERIFIED");
    expect(acknowledge).not.toHaveBeenCalled();
    await expect(readFile(resolve(stateRoot, "capital-transfers.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a later-slot timestamp regression before writing reward state", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_urls, signature) => ({
      signature, slot: signature === "launch" ? 10 : signature === "first" ? 11 : 12,
      blockTime: signature === "launch" ? 100 : signature === "first" ? 200 : 150,
      blockhash: "block", transactionIndex: 0, deltas: [{ account: holder, owner: holder, rawAmount: "1" }],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: "1" }],
    }));
    const source: MintTransferSource = {
      discover: async () => { throw new Error("BITQUERY_MUST_NOT_AUTHORIZE_REWARDS"); },
      discoverFinalizedBlocks: async () => [
        { signature: "launch", slot: 10, transactionIndex: 0 },
        { signature: "first", slot: 11, transactionIndex: 0 },
        { signature: "later", slot: 12, transactionIndex: 0 },
      ], acknowledgeFinalizedBlocks: async () => undefined,
    };
    await expect(refreshHolderJournal({
      environment: { rpcUrls: ["https://one.invalid", "https://two.invalid"], stateRoot,
        journalPath: resolve(stateRoot, "journal.json"), mint, launchSlot: 10,
        launchSignature: "launch", launchTime: 100, epochSeconds: 300 },
      source, finalizedThroughSlot: 20, finalizedThroughTime: 500, finalizedBlockhash: "tip",
    })).rejects.toThrow("HOLDER_INDEX_TIME_REGRESSION");
    await expect(readFile(resolve(stateRoot, "capital-transfers.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a backfilled movement timestamp before launch", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_urls, signature) => ({
      signature, slot: signature === "launch" ? 10 : 11,
      blockTime: signature === "launch" ? 100 : 99,
      blockhash: "block", transactionIndex: 0, deltas: [{ account: holder, owner: holder, rawAmount: "1" }],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: "1" }],
    }));
    const acknowledge = vi.fn(async () => undefined);
    const source: MintTransferSource = { discover: async () => { throw new Error("SHOULD_NOT_DISCOVER"); },
      discoverFinalizedBlocks: async () => [{ signature: "launch", slot: 10, transactionIndex: 0 },
        { signature: "prelaunch-time", slot: 11, transactionIndex: 0 }],
      acknowledgeFinalizedBlocks: acknowledge };
    await expect(refreshHolderJournal({
      environment: { rpcUrls: ["https://one.invalid", "https://two.invalid"], stateRoot,
        journalPath: resolve(stateRoot, "journal.json"), mint, launchSlot: 10,
        launchSignature: "launch", launchTime: 100, epochSeconds: 300,
        forceFinalizedBackfill: true },
      source, finalizedThroughSlot: 20, finalizedThroughTime: 500, finalizedBlockhash: "tip",
    })).rejects.toThrow("HOLDER_INDEX_TRANSACTION_UNVERIFIED");
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it.each([1, 2])("rebuilds a v%i vendor-only cache from launch before any new reward journal", async (version) => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    await writeFile(resolve(stateRoot, "capital-transfers.json"), JSON.stringify({
      version, mint, launchSlot: 10, launchSignature: "launch", launchTime: 100,
      indexedThroughSlot: 20, indexedThroughTime: 500, transactions: [],
    }));
    vi.mocked(readAgreedFinalizedTransaction).mockResolvedValue({ signature: "launch", slot: 10,
      blockTime: 100, blockhash: "block", transactionIndex: 0, deltas: [],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: "100" }] });
    const discover = vi.fn(async () => { throw new Error("BITQUERY_MUST_NOT_AUTHORIZE_REWARDS"); });
    const fullBlocks = vi.fn(async (_range: Parameters<NonNullable<MintTransferSource["discoverFinalizedBlocks"]>>[0]) =>
      [{ signature: "launch", slot: 10, transactionIndex: 0 }]);
    const source: MintTransferSource = { discover, discoverFinalizedBlocks: fullBlocks,
      acknowledgeFinalizedBlocks: async () => undefined };
    await refreshHolderJournal({
      environment: { rpcUrls: ["https://one.invalid", "https://two.invalid"], stateRoot,
        journalPath: resolve(stateRoot, "journal.json"), mint, launchSlot: 10,
        launchSignature: "launch", launchTime: 100, epochSeconds: 300 },
      source, finalizedThroughSlot: 21, finalizedThroughTime: 510, finalizedBlockhash: "block-21",
    });
    expect(discover).not.toHaveBeenCalled();
    expect(fullBlocks.mock.calls[0][0]).toMatchObject({ fromSlot: 10, throughSlot: 21 });
    const cache = JSON.parse(await readFile(resolve(stateRoot, "capital-transfers.json"), "utf8"));
    expect(cache.version).toBe(3);
    expect(cache.coverage).toEqual({ kind: "two-rpc-finalized-full-blocks", fromSlot: 10,
      throughSlot: 21, throughBlockhash: "block-21" });
  });

  it("rejects a changed cached ordered movement before reusing any v3 row", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    vi.mocked(readAgreedFinalizedTransaction).mockResolvedValue({ signature: "launch", slot: 10,
      blockTime: 100, blockhash: "block", transactionIndex: 0, deltas: [],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: "100" }] });
    const fullBlocks = vi.fn(async (_range: Parameters<NonNullable<MintTransferSource["discoverFinalizedBlocks"]>>[0]) =>
      [{ signature: "launch", slot: 10, transactionIndex: 0 }]);
    const source: MintTransferSource = { discover: async () => { throw new Error("BITQUERY_MUST_NOT_AUTHORIZE_REWARDS"); },
      discoverFinalizedBlocks: fullBlocks, acknowledgeFinalizedBlocks: async () => undefined };
    const environment = { rpcUrls: ["https://one.invalid", "https://two.invalid"] as const,
      stateRoot, journalPath: resolve(stateRoot, "journal.json"), mint,
      launchSlot: 10, launchSignature: "launch", launchTime: 100, epochSeconds: 300 };
    await refreshHolderJournal({ environment, source, finalizedThroughSlot: 20,
      finalizedThroughTime: 500, finalizedBlockhash: "block-20" });
    const path = resolve(stateRoot, "capital-transfers.json");
    const cached = JSON.parse(await readFile(path, "utf8"));
    cached.transactions[0].transfers[0].rawAmount = "999";
    await writeFile(path, JSON.stringify(cached));
    await expect(refreshHolderJournal({ environment, source, finalizedThroughSlot: 21,
      finalizedThroughTime: 510, finalizedBlockhash: "block-21" }))
      .rejects.toThrow("HOLDER_INDEX_CACHE_DIGEST_MISMATCH");
    expect(fullBlocks).toHaveBeenCalledOnce();
  });

  it("keeps old reward plans blocked while recording completed full-block coverage", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    await mkdir(resolve(stateRoot, "reward-epochs"));
    await writeFile(resolve(stateRoot, "reward-epochs", "current.json"), JSON.stringify({ version: 1 }));
    vi.mocked(readAgreedFinalizedTransaction).mockResolvedValue({ signature: "launch", slot: 10,
      blockTime: 100, blockhash: "block", transactionIndex: 0,
      deltas: [{ account: holder, owner: holder, rawAmount: "100" }],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: "100" }] });
    const source: MintTransferSource = { discover: async () => { throw new Error("BITQUERY_MUST_NOT_AUTHORIZE_REWARDS"); },
      discoverFinalizedBlocks: async () => [{ signature: "launch", slot: 10, transactionIndex: 0 }],
      acknowledgeFinalizedBlocks: async () => undefined };
    await expect(refreshHolderJournal({
      environment: { rpcUrls: ["https://one.invalid", "https://two.invalid"], stateRoot,
        journalPath: resolve(stateRoot, "journal.json"), mint, launchSlot: 10,
        launchSignature: "launch", launchTime: 100, epochSeconds: 300 },
      source, finalizedThroughSlot: 20, finalizedThroughTime: 500, finalizedBlockhash: "tip",
    })).rejects.toThrow("HOLDER_OLD_REWARD_PLAN_UNSAFE");
    const cache = JSON.parse(await readFile(resolve(stateRoot, "capital-transfers.json"), "utf8"));
    expect(cache.version).toBe(3);
    await expect(readFile(resolve(stateRoot, "journal.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a validly hashed plan for another mint before using its epoch window", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    await mkdir(resolve(stateRoot, "reward-epochs"));
    const foreignMint = Keypair.generate().publicKey.toBase58();
    const foreignPlan = buildRewardEpochPlan({
      epochId: 1n, fundedRawMstrx: 100n, excluded: [],
      mstrxMint: Keypair.generate().publicKey.toBase58(),
      owedEscrowOwner: Keypair.generate().publicKey.toBase58(),
      owedEscrowAddress: Keypair.generate().publicKey.toBase58(),
      journal: { version: 3, epochId: "1", capitalMint: foreignMint, launchSignature: "launch",
        windowStart: 100, windowEnd: 500, finalizedThroughSlot: 20, finalizedBlockhash: "block-20",
        coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: 10, throughSlot: 20,
          throughBlockhash: "block-20" },
        transfers: [{ signature: "launch", slot: 10, transactionIndex: 0,
          instructionIndex: 0, timestamp: 100, to: holder, rawAmount: "100" }] },
    });
    await writeFile(resolve(stateRoot, "reward-epochs", "current.json"), JSON.stringify(foreignPlan));
    vi.mocked(readAgreedFinalizedTransaction).mockResolvedValue({ signature: "launch", slot: 10,
      blockTime: 100, blockhash: "block", transactionIndex: 0, deltas: [],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: "100" }] });
    const source: MintTransferSource = { discover: async () => { throw new Error("BITQUERY_MUST_NOT_AUTHORIZE_REWARDS"); },
      discoverFinalizedBlocks: async () => [{ signature: "launch", slot: 10, transactionIndex: 0 }],
      acknowledgeFinalizedBlocks: async () => undefined };
    const journalPath = resolve(stateRoot, "journal.json");
    await expect(refreshHolderJournal({
      environment: { rpcUrls: ["https://one.invalid", "https://two.invalid"], stateRoot,
        journalPath, mint, launchSlot: 10, launchSignature: "launch", launchTime: 100, epochSeconds: 300 },
      source, finalizedThroughSlot: 21, finalizedThroughTime: 510, finalizedBlockhash: "block-21",
    })).rejects.toThrow("HOLDER_PREVIOUS_PLAN_IDENTITY_MISMATCH");
    await expect(readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not advance the journal while a full-block gap backfill is incomplete", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_urls, signature) => ({
      signature, slot: signature === "launch" ? 10 : 11, blockTime: signature === "launch" ? 100 : 120,
      blockhash: "block", transactionIndex: signature === "launch" ? 0 : 1,
      deltas: [{ account: holder, owner: holder, rawAmount: "100" }],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: "100" }],
    }));
    const recover = vi.fn(async (_args: Parameters<NonNullable<MintTransferSource["discoverFinalizedBlocks"]>>[0]) => [] as Awaited<ReturnType<NonNullable<MintTransferSource["discoverFinalizedBlocks"]>>>)
      .mockRejectedValueOnce(new Error("HOLDER_INDEX_BACKFILL_IN_PROGRESS"))
      .mockResolvedValueOnce([{ signature: "launch", slot: 10, transactionIndex: 0 }, { signature: "transfer", slot: 11, transactionIndex: 1 }]);
    const acknowledge = vi.fn(async () => undefined);
    const source: MintTransferSource = {
      discover: async () => { throw new Error("TRANSFER_SOURCE_REALTIME_GAP"); },
      discoverFinalizedBlocks: recover, acknowledgeFinalizedBlocks: acknowledge,
    };
    const environment = {
      rpcUrls: ["https://one.invalid", "https://two.invalid"] as const,
      stateRoot, journalPath: resolve(stateRoot, "journal.json"), mint,
      launchSlot: 10, launchSignature: "launch", launchTime: 100, epochSeconds: 300,
    };
    await expect(refreshHolderJournal({ environment, source, finalizedThroughSlot: 20, finalizedThroughTime: 500, finalizedBlockhash: "block-20" }))
      .rejects.toThrow("HOLDER_INDEX_BACKFILL_IN_PROGRESS");
    await expect(readFile(resolve(stateRoot, "capital-transfers.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(acknowledge).not.toHaveBeenCalled();
    const result = await refreshHolderJournal({ environment, source, finalizedThroughSlot: 20, finalizedThroughTime: 500, finalizedBlockhash: "block-20" });
    expect(result.published).toBe(true);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(recover.mock.calls[1][0]).toMatchObject({ fromSlot: 10, throughSlot: 20, throughBlockhash: "block-20" });
  });

  it("retains the original launch exactly once when a later gap is rescanned by slots", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_urls, signature) => ({
      signature, slot: signature === "launch" ? 10 : signature === "existing" ? 250 : 400,
      blockTime: signature === "launch" ? 100 : signature === "existing" ? 800 : 1_200,
      blockhash: "block", transactionIndex: signature === "launch" ? 0 : signature === "existing" ? 1 : 2,
      deltas: [{ account: holder, owner: holder, rawAmount: "100" }],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: "100" }],
    }));
    const recover = vi.fn(async (_args: Parameters<NonNullable<MintTransferSource["discoverFinalizedBlocks"]>>[0]) => [
      { signature: "launch", slot: 10, transactionIndex: 0 }, { signature: "existing", slot: 250, transactionIndex: 1 },
    ]).mockResolvedValueOnce([
      { signature: "launch", slot: 10, transactionIndex: 0 }, { signature: "existing", slot: 250, transactionIndex: 1 },
    ]).mockResolvedValueOnce([{ signature: "new", slot: 400, transactionIndex: 2 }]);
    const acknowledge = vi.fn(async () => undefined);
    const source: MintTransferSource = {
      discover: async () => { throw new Error("BITQUERY_MUST_NOT_AUTHORIZE_REWARDS"); },
      discoverFinalizedBlocks: recover, acknowledgeFinalizedBlocks: acknowledge,
    };
    const environment = {
      rpcUrls: ["https://one.invalid", "https://two.invalid"] as const,
      stateRoot, journalPath: resolve(stateRoot, "journal.json"), mint,
      launchSlot: 10, launchSignature: "launch", launchTime: 100, epochSeconds: 300,
    };
    await refreshHolderJournal({ environment, source, finalizedThroughSlot: 300, finalizedThroughTime: 1_000, finalizedBlockhash: "block-300" });
    const result = await refreshHolderJournal({ environment, source, finalizedThroughSlot: 500, finalizedThroughTime: 1_500, finalizedBlockhash: "block-500" });
    expect(result.indexed).toBe(3);
    expect(recover.mock.calls[0][0]).toMatchObject({ fromSlot: 10, throughSlot: 300 });
    expect(recover.mock.calls[1][0]).toMatchObject({ fromSlot: 300, throughSlot: 500 });
    expect(acknowledge).toHaveBeenCalledTimes(2);
    const cache = JSON.parse(await readFile(resolve(stateRoot, "capital-transfers.json"), "utf8"));
    expect(cache.transactions.map((row: { signature: string }) => row.signature)).toEqual(["launch", "existing", "new"]);
  });

  it("detects a missing transfer in the one-slot verified overlap", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_urls, signature) => ({
      signature, slot: signature === "launch" ? 10 : 20, blockTime: signature === "launch" ? 100 : 400,
      blockhash: "block", transactionIndex: signature === "launch" ? 0 : 1,
      deltas: [{ account: holder, owner: holder, rawAmount: signature === "launch" ? "100" : "10" }],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: signature === "launch" ? "100" : "10" }],
    }));
    let discovered = [{ signature: "launch", slot: 10, transactionIndex: 0 }, { signature: "transfer", slot: 20, transactionIndex: 1 }];
    const source: MintTransferSource = { discover: async () => { throw new Error("BITQUERY_MUST_NOT_AUTHORIZE_REWARDS"); },
      discoverFinalizedBlocks: async () => discovered, acknowledgeFinalizedBlocks: async () => undefined };
    const environment = {
      rpcUrls: ["https://one.invalid", "https://two.invalid"] as const,
      stateRoot, journalPath: resolve(stateRoot, "journal.json"), mint,
      launchSlot: 10, launchSignature: "launch", launchTime: 100, epochSeconds: 300,
    };
    const first = await refreshHolderJournal({ environment, source, finalizedThroughSlot: 20, finalizedThroughTime: 500, finalizedBlockhash: "block-20" });
    expect(first.published).toBe(true);
    const journal = JSON.parse(await readFile(environment.journalPath, "utf8"));
    expect(journal.version).toBe(3);
    expect(journal.transfers).toHaveLength(2);
    discovered = [];
    await expect(refreshHolderJournal({ environment, source, finalizedThroughSlot: 21, finalizedThroughTime: 510, finalizedBlockhash: "block-21" }))
      .rejects.toThrow("HOLDER_INDEX_PREVIOUS_TRANSFER_MISSING");
  });

  it("seeds a mint-creation transaction absent from the transfer cube using agreed block order", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_urls, signature) => ({
      signature, slot: signature === "launch" ? 10 : 11, blockTime: signature === "launch" ? 100 : 120,
      blockhash: "block", transactionIndex: signature === "launch" ? 1 : 1,
      deltas: [{ account: holder, owner: holder, rawAmount: signature === "launch" ? "100" : "10" }],
      movements: [{ instructionIndex: 0, to: holder, rawAmount: signature === "launch" ? "100" : "10" }],
    }));
    const getBlock = vi.spyOn(Connection.prototype, "getBlock").mockResolvedValue({
      blockhash: "block", previousBlockhash: "previous", parentSlot: 9, blockTime: 100,
      transactions: ["other", "launch"].map((signature) => ({
        version: 1, transaction: { accountKeys: [], signatures: [signature] },
      })),
    } as never);
    const environment = {
      rpcUrls: ["https://one.invalid", "https://two.invalid"] as const,
      stateRoot, journalPath: resolve(stateRoot, "journal.json"), mint,
      launchSlot: 10, launchSignature: "launch", launchTime: 100, epochSeconds: 300,
    };
    const source: MintTransferSource = { discover: async () => { throw new Error("BITQUERY_MUST_NOT_AUTHORIZE_REWARDS"); },
      discoverFinalizedBlocks: async (range) => range.fromSlot === 10
        ? [{ signature: "transfer", slot: 11, transactionIndex: 1 }] : [],
      acknowledgeFinalizedBlocks: async () => undefined };
    const result = await refreshHolderJournal({ environment, source, finalizedThroughSlot: 20, finalizedThroughTime: 500, finalizedBlockhash: "block-20" });
    expect(result.published).toBe(true);
    const cache = JSON.parse(await readFile(resolve(stateRoot, "capital-transfers.json"), "utf8"));
    expect(cache.version).toBe(3);
    expect(cache.transactions.map((row: { signature: string; transactionIndex: number }) => [row.signature, row.transactionIndex]))
      .toEqual([["launch", 1], ["transfer", 1]]);
    const second = await refreshHolderJournal({ environment, source, finalizedThroughSlot: 21, finalizedThroughTime: 510, finalizedBlockhash: "block-21" });
    expect(second.indexed).toBe(2);
    expect(readAgreedFinalizedTransaction).toHaveBeenCalledWith(environment.rpcUrls, "launch", mint, { includeOrderedMovements: true });
    expect(getBlock).toHaveBeenCalledWith(10, expect.objectContaining({
      transactionDetails: "accounts", maxSupportedTransactionVersion: 1,
    }));
  });
});
