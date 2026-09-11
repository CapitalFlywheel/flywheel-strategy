import { describe, expect, it } from "vitest";
import { rpcUrls } from "./rpc";

describe("RPC fallback configuration", () => {
  it("uses the public Robinhood endpoint when no provider is configured", () => {
    expect(rpcUrls()).toEqual(["https://rpc.mainnet.chain.robinhood.com"]);
  });

  it("keeps the paid/free provider first and removes duplicate fallback URLs", () => {
    expect(rpcUrls(" https://primary.example ", "https://backup.example")).toEqual([
      "https://primary.example", "https://backup.example",
    ]);
    expect(rpcUrls("https://same.example", "https://same.example")).toEqual(["https://same.example"]);
  });
});
