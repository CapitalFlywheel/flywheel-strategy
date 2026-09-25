export const solanaMainnet = {
  cluster: "mainnet-beta" as const,
  name: "Solana",
  // web3.js requires an absolute URL. This same-origin relay never exposes
  // the authenticated provider URL to the browser bundle.
  rpcUrl: new URL("/api/solana/rpc", typeof window === "undefined" ? "https://flywheelstrategy.xyz" : window.location.origin).toString(),
  // This endpoint is not a general RPC relay. It accepts only a signed
  // governance cast_vote transaction, and is hard-disabled until release.
  voteRpcUrl: new URL("/api/solana/governance-vote", typeof window === "undefined" ? "https://flywheelstrategy.xyz" : window.location.origin).toString(),
  explorer: "https://solscan.io",
  wrappedSolMint: "So11111111111111111111111111111111111111112",
  mstrxMint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
  mstrxDecimals: 8,
};

export function solscanAccount(address: string) {
  return `${solanaMainnet.explorer}/account/${address}`;
}

export function solscanToken(address: string) {
  return `${solanaMainnet.explorer}/token/${address}`;
}

export function solscanTransaction(signature: string) {
  return `${solanaMainnet.explorer}/tx/${signature}`;
}
