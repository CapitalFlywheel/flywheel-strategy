import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshHolderJournal, type MintTransferSource } from "./holderJournal";
import { readAgreedFinalizedTransaction } from "./finalizedTransfers";

vi.mock("./finalizedTransfers", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./finalizedTransfers")>();
  return { ...original, readAgreedFinalizedTransaction: vi.fn() };
});

const mint = Keypair.generate().publicKey.toBase58();
const holder = Keypair.generate().publicKey.toBase58();
const temporary: string[] = [];
afterEach(async () => {
  vi.mocked(readAgreedFinalizedTransaction).mockReset();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("holder journal recovery", () => {
  it("seeds launch balances and detects a missing transfer on an overlapping refresh", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-journal-"));
    temporary.push(stateRoot);
    vi.mocked(readAgreedFinalizedTransaction).mockImplementation(async (_urls, signature) => ({
      signature, slot: signature === "launch" ? 10 : 11, blockTime: signature === "launch" ? 100 : 120,
      blockhash: "block", deltas: [{ account: holder, owner: holder, rawAmount: signature === "launch" ? "100" : "10" }],
    }));
    let discovered = [{ signature: "launch", slot: 10, transactionIndex: 0 }, { signature: "transfer", slot: 11, transactionIndex: 1 }];
    const source: MintTransferSource = { discover: async () => discovered };
    const environment = {
      rpcUrls: ["https://one.invalid", "https://two.invalid"] as const,
      stateRoot, journalPath: resolve(stateRoot, "journal.json"), mint,
      launchSlot: 10, launchSignature: "launch", launchTime: 100, epochSeconds: 300,
    };
    const first = await refreshHolderJournal({ environment, source, finalizedThroughSlot: 20, finalizedThroughTime: 500, finalizedBlockhash: "block-20" });
    expect(first.published).toBe(true);
    const journal = JSON.parse(await readFile(environment.journalPath, "utf8"));
    expect(journal.transfers).toHaveLength(2);
    discovered = [];
    await expect(refreshHolderJournal({ environment, source, finalizedThroughSlot: 21, finalizedThroughTime: 510, finalizedBlockhash: "block-21" }))
      .rejects.toThrow("HOLDER_INDEX_PREVIOUS_TRANSFER_MISSING");
  });
});
