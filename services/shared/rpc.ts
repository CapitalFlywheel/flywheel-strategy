import { fallback, http, type Transport } from "viem";

const PUBLIC_ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";

export function rpcUrls(primary?: string, secondary?: string): string[] {
  const normalized = [primary || PUBLIC_ROBINHOOD_RPC, secondary]
    .filter((url): url is string => Boolean(url?.trim()))
    .map((url) => url.trim());
  return [...new Set(normalized)];
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
