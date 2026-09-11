import { describe, expect, it } from "vitest";
import {
  BASE_BPS,
  DAY,
  HOUR,
  HoldingWeightEngine,
  ZERO_ADDRESS,
  governanceLookbackSeconds,
  loyaltyBps,
  weightedTokenSeconds
} from "./holdingMath";

const alice = "0x00000000000000000000000000000000000000a1";
const bob = "0x00000000000000000000000000000000000000b2";
const pool = "0x00000000000000000000000000000000000000c3";

describe("short-life holding math", () => {
  it("rewards every completed hour and caps loyalty at 30 days", () => {
    expect(loyaltyBps(0)).toBe(10_000);
    expect(loyaltyBps(HOUR)).toBeGreaterThan(10_180);
    expect(loyaltyBps(6 * HOUR)).toBeGreaterThan(10_450);
    expect(loyaltyBps(DAY)).toBeGreaterThan(10_900);
    expect(loyaltyBps(7 * DAY)).toBeGreaterThan(12_400);
    expect(loyaltyBps(30 * DAY)).toBe(15_000);
    expect(loyaltyBps(365 * DAY)).toBe(15_000);
  });

  it("counts exact token time, so a mid-period buyer receives less weight", () => {
    const full = weightedTokenSeconds(1_000n, 0, 0, 10 * HOUR);
    const half = weightedTokenSeconds(1_000n, 5 * HOUR, 5 * HOUR, 10 * HOUR);
    expect(full).toBeGreaterThan(half * 2n);
  });

  it("preserves old core lots by consuming newest tokens first", () => {
    const engine = new HoldingWeightEngine(0, 48 * HOUR);
    engine.apply({ from: ZERO_ADDRESS, to: alice, amount: 100n, timestamp: 0 });
    engine.apply({ from: ZERO_ADDRESS, to: alice, amount: 40n, timestamp: 24 * HOUR });
    engine.apply({ from: alice, to: bob, amount: 40n, timestamp: 30 * HOUR });

    expect(engine.getLots(alice)).toEqual([{ amount: 100n, acquiredAt: 0 }]);
    expect(engine.getLots(bob)).toEqual([{ amount: 40n, acquiredAt: 30 * HOUR }]);
    const weights = engine.finalize();
    expect(weights.get(alice)).toBeGreaterThan(weights.get(bob) ?? 0n);
  });

  it("excludes pool and system addresses from rewards", () => {
    const engine = new HoldingWeightEngine(0, 2 * HOUR, new Set([pool]));
    engine.apply({ from: ZERO_ADDRESS, to: pool, amount: 1_000_000n, timestamp: 0 });
    engine.apply({ from: ZERO_ADDRESS, to: alice, amount: 100n, timestamp: 0 });
    const weights = engine.finalize();
    expect(weights.get(pool)).toBeUndefined();
    expect(weights.get(alice)).toBeGreaterThan(100n * BigInt(2 * HOUR));
  });

  it("uses at most 24 hours of history for governance", () => {
    expect(governanceLookbackSeconds(3 * HOUR)).toBe(3 * HOUR);
    expect(governanceLookbackSeconds(24 * HOUR)).toBe(24 * HOUR);
    expect(governanceLookbackSeconds(30 * DAY)).toBe(24 * HOUR);
  });
});
