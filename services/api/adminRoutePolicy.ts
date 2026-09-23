export function solanaAdminMode(cluster: string | undefined, solanaOwner: string | undefined) {
  return cluster?.trim() === "mainnet-beta" || Boolean(solanaOwner?.trim());
}

export function blockLegacyAdminPath(pathname: string, solanaMode: boolean) {
  if (pathname === "/admin" || pathname === "/admin/") return true;
  if (!pathname.startsWith("/admin/")) return false;
  // Robinhood's existing hidden panel still calls these API routes. In Solana
  // mode, every legacy route is unavailable even if an EVM owner remains set.
  return solanaMode || !pathname.startsWith("/admin/api/");
}
