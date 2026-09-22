import { PublicKey } from "@solana/web3.js";

export function parsePublicKey(value: string): PublicKey {
  return new PublicKey(value);
}

export function isSolanaPublicKey(value: string): boolean {
  try {
    return parsePublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

export function shortPublicKey(value?: string | PublicKey | null): string {
  if (!value) return "—";
  const address = typeof value === "string" ? value : value.toBase58();
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-5)}` : address;
}
