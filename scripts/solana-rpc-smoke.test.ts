import { describe, expect, it } from "vitest";
import { inspectSolanaRpcSmoke, type RpcProbe } from "./solana-rpc-smoke";

function probe(overrides: Partial<RpcProbe> = {}): RpcProbe {
  return {
    finalizedSlot: async () => 450_000_000,
    producedSlots: async (start) => [start, start + 1],
    fullBlock: async (slot) => ({ slot, hash: `block-${slot}`, signatures: ["tx-a", "tx-b"] }),
    accountsBlock: async (slot) => ({ slot, hash: `block-${slot}`, signatures: ["tx-a", "tx-b"] }),
    ...overrides,
  };
}

describe("Solana RPC full-block smoke", () => {
  it("compares the same recent and historical finalized blocks on both providers", async () => {
    const result = await inspectSolanaRpcSmoke([probe(), probe()]);
    expect(result.recent).toEqual({ slot: 449_999_900, transactions: 2 });
    expect(result.historical).toEqual({ slot: 449_800_000, transactions: 2 });
  });

  it("stops on omitted produced slots or altered transaction lists", async () => {
    await expect(inspectSolanaRpcSmoke([probe(), probe({ producedSlots: async (start) => [start + 1] })]))
      .rejects.toThrow("RPC_PRODUCED_SLOT_DISAGREEMENT");
    await expect(inspectSolanaRpcSmoke([probe(), probe({ fullBlock: async (slot) =>
      ({ slot, hash: `block-${slot}`, signatures: ["tx-a"] }) })]))
      .rejects.toThrow("RPC_FULL_BLOCK_DISAGREEMENT");
  });

  it("rejects large finalized-slot drift and an unavailable full block", async () => {
    await expect(inspectSolanaRpcSmoke([probe(), probe({ finalizedSlot: async () => 449_999_900 })]))
      .rejects.toThrow("RPC_FINALIZED_SLOT_DISAGREEMENT");
    await expect(inspectSolanaRpcSmoke([probe(), probe({ fullBlock: async () => null })]))
      .rejects.toThrow("RPC_FULL_BLOCK_UNAVAILABLE");
  });

  it("rejects an accounts-mode block that omits or reorders a finalized transaction", async () => {
    await expect(inspectSolanaRpcSmoke([probe(), probe({ accountsBlock: async (slot) =>
      ({ slot, hash: `block-${slot}`, signatures: ["tx-b", "tx-a"] }) })]))
      .rejects.toThrow("RPC_ACCOUNTS_BLOCK_DISAGREEMENT");
  });
});
