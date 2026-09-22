import { describe, expect, it } from "vitest";
import { requireMatchingValues } from "./rpcConsensus";

describe("Solana RPC consensus", () => {
  it("returns identical finalized values", () => {
    expect(requireMatchingValues([{ amount: "42" }, { amount: "42" }])).toEqual({ amount: "42" });
  });

  it("fails closed when providers disagree", () => {
    expect(() => requireMatchingValues([{ amount: "42" }, { amount: "41" }])).toThrow("RPC_STATE_DISAGREEMENT");
  });
});
