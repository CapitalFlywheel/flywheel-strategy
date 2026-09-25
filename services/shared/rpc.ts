import { fallback, http, type Transport } from "viem";

const PUBLIC_ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";

export function rpcUrls(primary?: string, secondary?: string): string[] {
  const normalized = [primary || PUBLIC_ROBINHOOD_RPC, secondary]
    .filter((url): url is string => Boolean(url?.trim()))
    .map((url) => url.trim());
  return [...new Set(normalized)];
}

export function alchemyRpcUrl(...candidates: Array<string | undefined>): string {
  const match = candidates
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .find((value) => {
      try {
        return new URL(value).hostname.endsWith(".alchemy.com");
      } catch {
        return false;
      }
    });
  if (!match) throw new Error("ALCHEMY_TRANSFER_SOURCE_REQUIRES_ALCHEMY_RPC");
  return match;
}

export function rpcTransport(primary?: string, secondary?: string): Transport {
  const transports = rpcUrls(primary, secondary).map((url, index) => http(url, {
    key: index === 0 ? "primary" : "secondary",
    name: index === 0 ? "Primary Robinhood RPC" : "Secondary Robinhood RPC",
    timeout: 12_000,
    retryCount: 1,
    retryDelay: 250,
  }));
  return transports.length === 1
    ? transports[0]
    : fallback(transports, { rank: false, retryCount: 0 });
}

/**
 * Transaction submissions must stay on one RPC endpoint. Sending and then
 * reading the pending nonce through different fallback providers can briefly
 * return an older nonce even after the previous receipt is visible.
 */
export function transactionRpcTransport(primary?: string): Transport {
  const [url] = rpcUrls(primary);
  return http(url, {
    key: "transaction-primary",
    name: "Primary Robinhood Transaction RPC",
    timeout: 12_000,
    retryCount: 1,
    retryDelay: 250,
  });
}
