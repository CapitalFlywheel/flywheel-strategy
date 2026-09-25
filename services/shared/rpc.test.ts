import { describe, expect, it } from "vitest";
import { alchemyRpcUrl, rpcUrls } from "./rpc";

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

  it("selects Alchemy for transfer history even when it is the backup RPC", () => {
    expect(alchemyRpcUrl(
      "https://example.quiknode.pro/key",
      "https://robinhood-mainnet.g.alchemy.com/v2/key",
    )).toBe("https://robinhood-mainnet.g.alchemy.com/v2/key");
  });

  it("rejects Alchemy transfer mode without an Alchemy endpoint", () => {
    expect(() => alchemyRpcUrl("https://example.quiknode.pro/key")).toThrow(
      "ALCHEMY_TRANSFER_SOURCE_REQUIRES_ALCHEMY_RPC",
    );
  });
});
