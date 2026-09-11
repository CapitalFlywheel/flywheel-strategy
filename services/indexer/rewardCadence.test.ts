import { describe, expect, it } from "vitest";
import { CONFIRMATION_SECONDS, RewardCadenceTracker } from "./rewardCadence";

describe("market-cap reward cadence", () => {
  it("starts at ten minutes", () => {
    const tracker = new RewardCadenceTracker();
    expect(tracker.currentIntervalSeconds()).toBe(600);
  });

  it("confirms a higher level only after one full hour", () => {
    const tracker = new RewardCadenceTracker();
    for (let elapsed = 0; elapsed <= CONFIRMATION_SECONDS; elapsed += 60) {
      tracker.update(1_000 + elapsed, 550_000);
    }
    expect(tracker.currentIntervalSeconds()).toBe(1_200);
  });

  it("can confirm the five-million level directly and never rolls back", () => {
    const tracker = new RewardCadenceTracker();
    for (let elapsed = 0; elapsed <= CONFIRMATION_SECONDS; elapsed += 60) {
      tracker.update(10_000 + elapsed, 5_500_000);
    }
    expect(tracker.currentIntervalSeconds()).toBe(3_600);
    tracker.update(20_000, 100_000);
    expect(tracker.currentIntervalSeconds()).toBe(3_600);
  });

  it("resets confirmation when the target is lost", () => {
    const tracker = new RewardCadenceTracker();
    tracker.update(0, 1_100_000);
    tracker.update(60, 400_000);
    tracker.update(2_000, 1_100_000);
    for (let elapsed = 60; elapsed < CONFIRMATION_SECONDS; elapsed += 60) {
      tracker.update(2_000 + elapsed, 1_100_000);
    }
    expect(tracker.currentIntervalSeconds()).toBe(600);
  });

  it("restores an already confirmed irreversible level", () => {
    const tracker = new RewardCadenceTracker({ confirmedLevel: 2 });
    expect(tracker.currentIntervalSeconds()).toBe(1_800);
    tracker.update(1_000, 10_000);
    expect(tracker.currentIntervalSeconds()).toBe(1_800);
  });

  it("does not count monitor downtime toward the confirmation hour", () => {
    const tracker = new RewardCadenceTracker();
    tracker.update(1_000, 600_000);
    tracker.update(1_121, 600_000);
    expect(tracker.snapshot().candidateSince).toBe(1_121);
    expect(tracker.currentIntervalSeconds()).toBe(600);
  });
});
