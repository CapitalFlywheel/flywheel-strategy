import { describe, expect, it, vi } from "vitest";
import { ensureRobinhoodChain, type Eip1193Provider, type WalletProviderDetail } from "./wallets";

function providerWith(handler: (method: string) => unknown | Promise<unknown>): Eip1193Provider {
  return { request: vi.fn(({ method }: { method: string }) => Promise.resolve(handler(method))) };
}

describe("Robinhood Chain wallet setup", () => {
  it("does nothing when the wallet is already on chain 4663", async () => {
    const provider = providerWith(() => "0x1237");
    await ensureRobinhoodChain(provider);
    expect(provider.request).toHaveBeenCalledTimes(1);
  });

  it("adds Robinhood Chain when a wallet cannot switch to it yet", async () => {
    let added = false;
    const provider = providerWith((method) => {
      if (method === "eth_chainId") return added ? "0x1237" : "0x1";
      if (method === "wallet_switchEthereumChain") throw { code: 4902 };
      if (method === "wallet_addEthereumChain") added = true;
      return null;
    });
    await ensureRobinhoodChain(provider);
    expect(provider.request).toHaveBeenCalledWith(expect.objectContaining({ method: "wallet_addEthereumChain" }));
  });

  it("does not turn a rejected network switch into another request", async () => {
    const provider = providerWith((method) => {
      if (method === "eth_chainId") return "0x1";
      throw { code: 4001 };
    });
    await expect(ensureRobinhoodChain(provider)).rejects.toThrow("cancelled the network switch");
    expect(provider.request).toHaveBeenCalledTimes(2);
  });

  it("explains Phantom's current Robinhood Chain limitation", async () => {
    const provider = providerWith((method) => {
      if (method === "eth_chainId") return "0x1";
      throw { code: 4902 };
    });
    const phantom: WalletProviderDetail = {
      info: { uuid: "phantom", name: "Phantom", rdns: "app.phantom" },
      provider,
      source: "injected",
    };
    await expect(ensureRobinhoodChain(provider, phantom)).rejects.toThrow("does not support Robinhood Chain");
  });
});
