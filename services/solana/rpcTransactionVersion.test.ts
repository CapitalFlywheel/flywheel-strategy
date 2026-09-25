import { Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFinalizedBlockSignatures } from "./rpcTransactionVersion";

afterEach(() => vi.restoreAllMocks());

const block = (versions: Array<"legacy" | number>, signatures: string[]) => ({
  blockhash: "finalized-block", blockTime: 7_200, previousBlockhash: "previous", parentSlot: 9,
  transactions: versions.map((version, index) => ({
    version, transaction: { accountKeys: [], signatures: [signatures[index]] },
  })),
});

describe("v1-capable finalized block signature read", () => {
  it("requests accounts mode with version 1 and preserves canonical order", async () => {
    const getBlock = vi.spyOn(Connection.prototype, "getBlock")
      .mockResolvedValue(block(["legacy", 0, 1], ["first", "second", "third"]) as never);
    const result = await readFinalizedBlockSignatures(new Connection("https://rpc.example"), 10);
    expect(result).toEqual({ blockhash: "finalized-block", blockTime: 7_200,
      signatures: ["first", "second", "third"] });
    expect(getBlock).toHaveBeenCalledWith(10, {
      commitment: "finalized", transactionDetails: "accounts", rewards: false,
      maxSupportedTransactionVersion: 1,
    });
  });

  it("fails closed on unknown version, duplicate signatures and malformed transaction rows", async () => {
    const getBlock = vi.spyOn(Connection.prototype, "getBlock");
    const connection = new Connection("https://rpc.example");
    getBlock.mockResolvedValueOnce(block([2], ["first"]) as never);
    await expect(readFinalizedBlockSignatures(connection, 10)).rejects.toThrow("SOLANA_TRANSACTION_VERSION_UNSUPPORTED");
    getBlock.mockResolvedValueOnce(block([1, 1], ["first", "first"]) as never);
    await expect(readFinalizedBlockSignatures(connection, 10)).rejects.toThrow("SOLANA_FINALIZED_BLOCK_DUPLICATE_SIGNATURE");
    const invalid = block([1], ["first"]);
    (invalid.transactions[0].transaction as { accountKeys?: unknown }).accountKeys = undefined;
    getBlock.mockResolvedValueOnce(invalid as never);
    await expect(readFinalizedBlockSignatures(connection, 10)).rejects.toThrow("SOLANA_FINALIZED_BLOCK_TRANSACTION_INVALID");
  });
});
