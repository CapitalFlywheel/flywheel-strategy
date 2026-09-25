import { Connection, SolanaJSONRPCError, SolanaJSONRPCErrorCode } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertIndependentRpcProviders, finalizedConsensus, requireMatchingValues } from "./rpcConsensus";

afterEach(() => vi.restoreAllMocks());

function rpcError(code: number) {
  return new SolanaJSONRPCError({ code, message: "Block not available for slot", data: null });
}

describe("Solana RPC consensus", () => {
  it("returns identical finalized values", () => {
    expect(requireMatchingValues([{ amount: "42" }, { amount: "42" }])).toEqual({ amount: "42" });
  });

  it("fails closed when providers disagree", () => {
    expect(() => requireMatchingValues([{ amount: "42" }, { amount: "41" }])).toThrow("RPC_STATE_DISAGREEMENT");
  });

  it("compares on-chain bigint values without losing precision", () => {
    expect(requireMatchingValues([{ amount: 2n ** 80n }, { amount: 2n ** 80n }])).toEqual({ amount: 2n ** 80n });
    expect(() => requireMatchingValues([{ amount: 2n ** 80n }, { amount: 1n }])).toThrow("RPC_STATE_DISAGREEMENT");
  });

  it("requires two independent HTTPS hosts", () => {
    expect(() => assertIndependentRpcProviders(["https://same.example/key1", "https://same.example/key2"])).toThrow("RPC_PROVIDERS_NOT_INDEPENDENT");
    expect(() => assertIndependentRpcProviders(["https://a.example", "http://b.example"])).toThrow("RPC_HTTPS_REQUIRED");
    expect(assertIndependentRpcProviders(["https://a.example", "https://b.example"])).toBe(true);
  });

  it("searches behind a mutually unavailable finalized slot", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockResolvedValue(100);
    const getBlock = vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async (slot) => {
      if (slot === 100) throw rpcError(SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_BLOCK_NOT_AVAILABLE);
      return { blockhash: "agreed-hash" } as Awaited<ReturnType<Connection["getBlock"]>>;
    });
    await expect(finalizedConsensus(["https://a.example", "https://b.example"]))
      .resolves.toEqual({ slot: 99, blockhash: "agreed-hash", providers: 2 });
    expect(getBlock).toHaveBeenCalledTimes(4);
  });

  it("does not ignore an unavailable slot on only one RPC", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockResolvedValue(100);
    let calls = 0;
    vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async () => {
      if (calls++ === 0) throw rpcError(SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_BLOCK_NOT_AVAILABLE);
      return { blockhash: "one-provider-has-block" } as Awaited<ReturnType<Connection["getBlock"]>>;
    });
    await expect(finalizedConsensus(["https://a.example", "https://b.example"]))
      .rejects.toThrow("RPC_BLOCK_DISAGREEMENT");
  });

  it("fails closed on a provider error instead of searching backward", async () => {
    vi.spyOn(Connection.prototype, "getSlot").mockResolvedValue(100);
    const getBlock = vi.spyOn(Connection.prototype, "getBlock").mockRejectedValue(
      rpcError(SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_NODE_UNHEALTHY));
    await expect(finalizedConsensus(["https://a.example", "https://b.example"]))
      .rejects.toThrow("Block not available for slot");
    expect(getBlock).toHaveBeenCalledTimes(2);
  });
});
