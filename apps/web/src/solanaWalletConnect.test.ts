import { describe, expect, it } from "vitest";
import { createSolanaWalletConnectAdapter, solanaWalletConnectProjectId } from "./solanaWalletConnect";

describe("Solana WalletConnect configuration", () => {
  it("enables Reown only for a valid public Project ID", () => {
    const id = "0123456789abcdef0123456789ABCDEF";
    expect(solanaWalletConnectProjectId(` ${id} `)).toBe(id);
  });

  it("keeps installed-wallet discovery when the ID is missing or invalid", () => {
    expect(solanaWalletConnectProjectId(undefined)).toBeUndefined();
    expect(solanaWalletConnectProjectId("")).toBeUndefined();
    expect(solanaWalletConnectProjectId("not-a-project-id")).toBeUndefined();
    expect(solanaWalletConnectProjectId("https://private-rpc.example/?api-key=secret")).toBeUndefined();
  });

  it("rejects an invalid ID before loading the WalletConnect bundle", async () => {
    await expect(createSolanaWalletConnectAdapter("bad")).rejects.toThrow("SOLANA_WALLETCONNECT_PROJECT_ID_INVALID");
  });
});
