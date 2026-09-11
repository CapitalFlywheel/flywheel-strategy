import { describe, expect, it } from "vitest";
import { humanToken1PerToken0, tickFromSlot0, v4PoolId } from "./marketCap";

describe("market-cap price helpers", () => {
  it("decodes positive and negative V4 ticks", () => {
    const positive = `0x${(12345n << 160n).toString(16).padStart(64, "0")}` as `0x${string}`;
    const negative = `0x${(0xff_ff9cn << 160n).toString(16).padStart(64, "0")}` as `0x${string}`;
    expect(tickFromSlot0(positive)).toBe(12345);
    expect(tickFromSlot0(negative)).toBe(-100);
  });

  it("adjusts pool price for token decimals", () => {
    expect(humanToken1PerToken0(0, 18, 6)).toBe(1e12);
  });

  it("reproduces the known WETH/USDG pool id", () => {
    expect(v4PoolId(
      "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      200,
      4,
      "0x0000000000000000000000000000000000000000"
    )).toBe("0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6");
  });
});
