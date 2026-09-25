import { Buffer } from "buffer";

/** The Reown Project ID is browser-visible. Keep authenticated RPC URLs out of Vite variables. */
export function solanaWalletConnectProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const projectId = value.trim();
  return /^[a-f\d]{32}$/i.test(projectId) ? projectId : undefined;
}

/** Load the large Reown bundle only when this site has a configured Project ID. */
export async function createSolanaWalletConnectAdapter(value: unknown) {
  const projectId = solanaWalletConnectProjectId(value);
  if (!projectId) throw new Error("SOLANA_WALLETCONNECT_PROJECT_ID_INVALID");

  // The published Solana adapter uses the Node Buffer global when signing.
  const browserGlobal = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
  browserGlobal.Buffer ??= Buffer;

  const [{ WalletAdapterNetwork }, { WalletConnectWalletAdapter }] = await Promise.all([
    import("@solana/wallet-adapter-base"),
    import("@walletconnect/solana-adapter"),
  ]);
  return new WalletConnectWalletAdapter({ network: WalletAdapterNetwork.Mainnet, options: { projectId } });
}
