import { Connection, PublicKey } from "@solana/web3.js";
import { solanaMainnet } from "./network";

export const publicConnection = new Connection(solanaMainnet.rpcUrl, "confirmed");

export async function readTokenAccountBalance(address?: string): Promise<string> {
  if (!address) return "—";
  try {
    const balance = await publicConnection.getTokenAccountBalance(new PublicKey(address), "confirmed");
    return balance.value.uiAmountString ?? "0";
  } catch {
    return "—";
  }
}

export async function readMstrxMultiplier(): Promise<number> {
  try {
    const account = await publicConnection.getParsedAccountInfo(new PublicKey(solanaMainnet.mstrxMint), "confirmed");
    const parsed = account.value?.data && "parsed" in account.value.data ? account.value.data.parsed : undefined;
    const extensions = parsed?.info?.extensions as Array<{ extension?: string; state?: { multiplier?: string } }> | undefined;
    const scaled = extensions?.find((entry) => entry.extension === "scaledUiAmountConfig");
    const multiplier = Number(scaled?.state?.multiplier ?? "1");
    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  } catch {
    return 1;
  }
}

export function formatMstrxRaw(raw: string | bigint, multiplier = 1): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const whole = Number(value) / 10 ** solanaMainnet.mstrxDecimals * multiplier;
  return whole.toLocaleString(undefined, { maximumFractionDigits: 8 });
}
