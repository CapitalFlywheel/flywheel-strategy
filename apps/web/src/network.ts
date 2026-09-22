export const solanaMainnet = {
  cluster: "mainnet-beta" as const,
  name: "Solana",
  rpcUrl: (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined) || "https://api.mainnet-beta.solana.com",
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
