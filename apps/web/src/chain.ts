import { solanaMainnet } from "./network";

export function formatMstrxRaw(raw: string | bigint, multiplier = 1): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const whole = Number(value) / 10 ** solanaMainnet.mstrxDecimals * multiplier;
  return whole.toLocaleString(undefined, { maximumFractionDigits: 8 });
}
