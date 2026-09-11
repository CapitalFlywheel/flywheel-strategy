import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { normalizePostlaunchManifest, normalizePrelaunchManifest } from "./launchManifest";

const owner = getAddress("0xB4d521f6c47F1DB4A89A82f0564646737ED41972");
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`);

function pre() {
  return {
    version: 1, chainId: 4663, owner,
    automation: address("1"), rootPublisher: address("2"), mstr: address("3"), weth: address("4"),
    usdg: address("5"), universalRouter: address("6"), feeEscrow: address("7"), rewardVault: address("8"),
    reserveVault: address("9"), keeperVault: address("a"), v4MstrAdapter: address("b"),
    v3MstrAdapter: address("c"), feeRouter: address("d"), ponsFeeCollector: address("e"),
  };
}

describe("admin launch manifest", () => {
  it("accepts and normalizes the fixed prelaunch shape", () => {
    expect(normalizePrelaunchManifest(pre(), owner).owner).toBe(owner);
  });

  it("rejects a different owner", () => {
    expect(() => normalizePrelaunchManifest(pre(), address("f"))).toThrow("MANIFEST_WRONG_OWNER");
  });

  it("requires every postlaunch address", () => {
    expect(() => normalizePostlaunchManifest(pre(), owner)).toThrow("MANIFEST_MISSING_PROJECTTOKEN");
  });

  it("does not keep arbitrary payload fields", () => {
    const normalized = normalizePrelaunchManifest({ ...pre(), arbitraryCommand: "rm" }, owner);
    expect(normalized).not.toHaveProperty("arbitraryCommand");
  });
});
