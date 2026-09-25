import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair, PublicKey, type VersionedBlockResponse } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeFinalizedBlockBackfill, discoverFinalizedBlockTransfers, pendingFinalizedBlockBackfillTarget,
} from "./finalizedBlockBackfill";

const mint = Keypair.generate().publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();
const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function block(slot: number, signatures: Array<{ signature: string; mint?: string; failed?: boolean; mentionsMint?: boolean }>,
  version: "legacy" | 0 | 1 = "legacy"): VersionedBlockResponse {
  return {
    blockhash: `hash-${slot}`, previousBlockhash: `hash-${slot - 1}`, parentSlot: slot - 1, blockTime: slot * 10,
    transactions: signatures.map(({ signature, mint: tokenMint, failed, mentionsMint }) => ({
      transaction: { signatures: [signature], message: { staticAccountKeys: mentionsMint ? [new PublicKey(mint)] : [], addressTableLookups: [] } },
      meta: { err: failed ? { InstructionError: [0, "error"] } : null,
        preTokenBalances: tokenMint ? [{ mint: tokenMint }] : [],
        postTokenBalances: tokenMint ? [{ mint: tokenMint }] : [] },
      version,
    })),
  } as unknown as VersionedBlockResponse;
}

async function stateRoot() {
  const path = await mkdtemp(join(tmpdir(), "flywheel-backfill-"));
  temporary.push(path);
  return path;
}

function args(root: string) {
  return {
    mint, fromSlot: 10, throughSlot: 13, throughBlockhash: "hash-13", throughTime: 130, stateRoot: root,
    rpcUrls: ["https://one.invalid", "https://two.invalid"] as const,
    maxSlotsPerRun: 2,
  };
}

describe("finalized mint-wide block recovery", () => {
  it("bounds parallel full-block reads while preserving chain-order candidates", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockResolvedValue([10, 11, 12, 13]);
    let active = 0;
    let peak = 0;
    vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async (slot) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 5));
      active -= 1;
      return block(slot, [{ signature: `sig-${slot}`, mint }]);
    });
    const rows = await discoverFinalizedBlockTransfers({ ...args(root), maxSlotsPerRun: 4, blockConcurrency: 2 });
    expect(peak).toBe(4); // two slots at a time, each independently read by two RPCs
    expect(rows.map((row) => row.signature)).toEqual(["sig-10", "sig-11", "sig-12", "sig-13"]);
  });

  it("resumes a bounded full-block scan without publishing an incomplete cursor or duplicating signatures", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockImplementation(async (start, end) =>
      [10, 11, 13].filter((slot) => slot >= start && slot <= (end ?? start)));
    vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async (slot) => block(slot, slot === 10
      ? [{ signature: "launch", mint }, { signature: "unrelated", mint: other }]
      : slot === 11 ? [{ signature: "failed", mint, failed: true }, { signature: "transfer", mint }]
        : [{ signature: "later", mint }]));
    await expect(discoverFinalizedBlockTransfers(args(root))).rejects.toThrow("HOLDER_INDEX_BACKFILL_IN_PROGRESS");
    expect(await pendingFinalizedBlockBackfillTarget(root, mint, 10)).toEqual({ slot: 13, blockhash: "hash-13", blockTime: 130 });
    const pending = JSON.parse(await readFile(resolve(root, "recovery", "capital-block-backfill.json"), "utf8"));
    expect(pending.nextSlot).toBe(12);
    expect(pending.transactions.map((row: { signature: string }) => row.signature)).toEqual(["launch", "transfer"]);
    expect(pending.transactions).toEqual([
      { signature: "launch", slot: 10, transactionIndex: 0, blockhash: "hash-10", blockTime: 100 },
      { signature: "transfer", slot: 11, transactionIndex: 1, blockhash: "hash-11", blockTime: 110 },
    ]);
    const rows = await discoverFinalizedBlockTransfers(args(root));
    expect(rows.map((row) => [row.signature, row.slot, row.transactionIndex, row.blockhash, row.blockTime])).toEqual([
      ["launch", 10, 0, "hash-10", 100], ["transfer", 11, 1, "hash-11", 110],
      ["later", 13, 0, "hash-13", 130],
    ]);
    expect(await pendingFinalizedBlockBackfillTarget(root, mint, 10)).toBeDefined();
    await acknowledgeFinalizedBlockBackfill(args(root));
    expect(await pendingFinalizedBlockBackfillTarget(root, mint, 10)).toBeUndefined();
  });

  it("keeps its last durable checkpoint when providers disagree about produced slots", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockResolvedValueOnce([10, 11]).mockResolvedValueOnce([10]);
    await expect(discoverFinalizedBlockTransfers(args(root))).rejects.toThrow("HOLDER_BACKFILL_SLOT_RPC_DISAGREEMENT");
    const pending = JSON.parse(await readFile(resolve(root, "recovery", "capital-block-backfill.json"), "utf8"));
    expect(pending.nextSlot).toBe(10);
    await expect(acknowledgeFinalizedBlockBackfill(args(root))).rejects.toThrow("HOLDER_BACKFILL_ACK_INVALID");
  });

  it("restarts from launch and archives a narrower legacy checkpoint without trusting its cursor", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockImplementation(async (start, end) =>
      [10, 11, 12, 13].filter((slot) => slot >= start && slot <= (end ?? start)));
    vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async (slot) =>
      block(slot, [{ signature: `sig-${slot}`, mint }]));
    const legacy = { ...args(root), fromSlot: 12, maxSlotsPerRun: 1 };
    await expect(discoverFinalizedBlockTransfers(legacy)).rejects.toThrow("HOLDER_INDEX_BACKFILL_IN_PROGRESS");
    const rows = await discoverFinalizedBlockTransfers({ ...args(root), maxSlotsPerRun: 4 });
    expect(rows.map((row) => row.signature)).toEqual(["sig-10", "sig-11", "sig-12", "sig-13"]);
    const recoveryFiles = await readdir(resolve(root, "recovery"));
    expect(recoveryFiles.some((name) => name.startsWith("capital-block-backfill.json.superseded-"))).toBe(true);
    const current = JSON.parse(await readFile(resolve(root, "recovery", "capital-block-backfill.json"), "utf8"));
    expect(current.fromSlot).toBe(10);
  });

  it("archives a version-1 candidate checkpoint before rebuilding every slot", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockImplementation(async (start, end) =>
      [10, 11, 12, 13].filter((slot) => slot >= start && slot <= (end ?? start)));
    vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async (slot) =>
      block(slot, [{ signature: `sig-${slot}`, mint }]));
    await expect(discoverFinalizedBlockTransfers(args(root))).rejects.toThrow("HOLDER_INDEX_BACKFILL_IN_PROGRESS");
    const path = resolve(root, "recovery", "capital-block-backfill.json");
    const old = JSON.parse(await readFile(path, "utf8"));
    old.version = 1;
    await writeFile(path, JSON.stringify(old));
    const rows = await discoverFinalizedBlockTransfers({ ...args(root), maxSlotsPerRun: 4 });
    expect(rows.map((row) => row.signature)).toEqual(["sig-10", "sig-11", "sig-12", "sig-13"]);
    const files = await readdir(resolve(root, "recovery"));
    expect(files.some((name) => name.startsWith("capital-block-backfill.json.superseded-"))).toBe(true);
    const current = JSON.parse(await readFile(path, "utf8"));
    expect(current.version).toBe(2);
    expect(current.fromSlot).toBe(10);
  });

  it("refuses provider disagreement about a transaction touching the mint", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockResolvedValue([10]);
    vi.spyOn(Connection.prototype, "getBlock")
      .mockResolvedValueOnce(block(10, [{ signature: "same-signature", mint }]))
      .mockResolvedValueOnce(block(10, [{ signature: "same-signature" }]));
    await expect(discoverFinalizedBlockTransfers({ ...args(root), fromSlot: 10, throughSlot: 10,
      throughBlockhash: "hash-10", throughTime: 100, maxSlotsPerRun: 1 }))
      .rejects.toThrow("HOLDER_BACKFILL_BLOCK_RPC_DISAGREEMENT");
    const pending = JSON.parse(await readFile(resolve(root, "recovery", "capital-block-backfill.json"), "utf8"));
    expect(pending.nextSlot).toBe(10);
  });

  it("never emits an attested candidate when providers disagree about its block hash or time", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockResolvedValue([10]);
    const inconsistent = block(10, [{ signature: "tx", mint }]);
    inconsistent.blockhash = "other-hash";
    vi.spyOn(Connection.prototype, "getBlock")
      .mockResolvedValueOnce(block(10, [{ signature: "tx", mint }]))
      .mockResolvedValueOnce(inconsistent);
    await expect(discoverFinalizedBlockTransfers({ ...args(root), throughSlot: 10,
      throughBlockhash: "hash-10", throughTime: 100, maxSlotsPerRun: 1 }))
      .rejects.toThrow("HOLDER_BACKFILL_BLOCK_RPC_DISAGREEMENT");
    const pending = JSON.parse(await readFile(resolve(root, "recovery", "capital-block-backfill.json"), "utf8"));
    expect(pending.nextSlot).toBe(10);
    expect(pending.transactions).toEqual([]);
  });

  it("fails closed when archival block coverage is unavailable", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValueOnce(11).mockResolvedValueOnce(1);
    await expect(discoverFinalizedBlockTransfers(args(root))).rejects.toThrow("HOLDER_BACKFILL_ARCHIVE_UNAVAILABLE");
  });

  it("rejects a missing token-balance array rather than silently calling a transaction irrelevant", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockResolvedValue([10]);
    const invalid = block(10, [{ signature: "unknown" }]);
    delete (invalid.transactions[0].meta as { preTokenBalances?: unknown }).preTokenBalances;
    vi.spyOn(Connection.prototype, "getBlock").mockResolvedValue(invalid);
    await expect(discoverFinalizedBlockTransfers(args(root))).rejects.toThrow("HOLDER_BACKFILL_TOKEN_BALANCES_MISSING");
  });

  it("keeps a successful mint-referencing transaction even if its token account is opened and closed inside it", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockResolvedValue([10]);
    vi.spyOn(Connection.prototype, "getBlock").mockResolvedValue(block(10, [{ signature: "transient", mentionsMint: true }]));
    const rows = await discoverFinalizedBlockTransfers({ ...args(root), fromSlot: 10, throughSlot: 10,
      throughBlockhash: "hash-10", throughTime: 100, maxSlotsPerRun: 1 });
    expect(rows).toEqual([{ signature: "transient", slot: 10, transactionIndex: 0,
      blockhash: "hash-10", blockTime: 100 }]);
  });

  it("reads a v1 transaction without address lookup tables and never skips its mint movement", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockResolvedValue([10]);
    const getBlock = vi.spyOn(Connection.prototype, "getBlock").mockResolvedValue(
      block(10, [{ signature: "v1-transfer", mentionsMint: true }], 1));
    const rows = await discoverFinalizedBlockTransfers({ ...args(root), fromSlot: 10, throughSlot: 10,
      throughBlockhash: "hash-10", throughTime: 100, maxSlotsPerRun: 1 });
    expect(rows).toEqual([{ signature: "v1-transfer", slot: 10, transactionIndex: 0,
      blockhash: "hash-10", blockTime: 100 }]);
    expect(getBlock).toHaveBeenCalledWith(10, expect.objectContaining({ maxSupportedTransactionVersion: 1 }));
  });

  it("does not advance the checkpoint for an unknown transaction version or a v1 lookup layout", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockResolvedValue([10]);
    const unsupported = block(10, [{ signature: "unknown", mint }], 1);
    (unsupported.transactions[0] as { version?: number }).version = 2;
    const getBlock = vi.spyOn(Connection.prototype, "getBlock").mockResolvedValue(unsupported);
    const range = { ...args(root), fromSlot: 10, throughSlot: 10,
      throughBlockhash: "hash-10", throughTime: 100, maxSlotsPerRun: 1 };
    await expect(discoverFinalizedBlockTransfers(range)).rejects.toThrow("SOLANA_TRANSACTION_VERSION_UNSUPPORTED");
    const malformedV1 = block(10, [{ signature: "bad-v1", mint }], 1);
    (malformedV1.transactions[0].transaction.message as { addressTableLookups: unknown[] }).addressTableLookups = [{}];
    getBlock.mockResolvedValue(malformedV1);
    await expect(discoverFinalizedBlockTransfers(range)).rejects.toThrow("HOLDER_BACKFILL_ADDRESS_LAYOUT_INVALID");
    const pending = JSON.parse(await readFile(resolve(root, "recovery", "capital-block-backfill.json"), "utf8"));
    expect(pending.nextSlot).toBe(10);
  });

  it("refuses a changed target after a partial checkpoint", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockImplementation(async (start, end) =>
      [10, 11, 13].filter((slot) => slot >= start && slot <= (end ?? start)));
    vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async (slot) => block(slot, [{ signature: `sig-${slot}`, mint }]));
    await expect(discoverFinalizedBlockTransfers(args(root))).rejects.toThrow("HOLDER_INDEX_BACKFILL_IN_PROGRESS");
    await expect(discoverFinalizedBlockTransfers({ ...args(root), maxSlotsPerRun: 4, throughBlockhash: "other" }))
      .rejects.toThrow("HOLDER_BACKFILL_TARGET_MISMATCH");
    const pending = JSON.parse(await readFile(resolve(root, "recovery", "capital-block-backfill.json"), "utf8"));
    expect(pending.nextSlot).toBe(12);
  });

  it("refuses a finalized target block whose hash differs from the pinned cursor", async () => {
    const root = await stateRoot();
    vi.spyOn(Connection.prototype, "getFirstAvailableBlock").mockResolvedValue(1);
    vi.spyOn(Connection.prototype, "getBlocks").mockResolvedValue([13]);
    vi.spyOn(Connection.prototype, "getBlock").mockResolvedValue(block(13, [{ signature: "tx", mint }]));
    await expect(discoverFinalizedBlockTransfers({ ...args(root), fromSlot: 13, throughBlockhash: "wrong-hash", maxSlotsPerRun: 1 }))
      .rejects.toThrow("HOLDER_BACKFILL_TARGET_BLOCK_MISMATCH");
    const pending = JSON.parse(await readFile(resolve(root, "recovery", "capital-block-backfill.json"), "utf8"));
    expect(pending.nextSlot).toBe(13);
  });
});
