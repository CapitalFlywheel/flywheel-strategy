import { describe, expect, it } from "vitest";
import { assertIndependentRpcProviders, requireMatchingValues } from "./rpcConsensus";

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
});
