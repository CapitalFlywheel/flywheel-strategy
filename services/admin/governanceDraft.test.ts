import { describe, expect, it } from "vitest";
import { normalizeGovernanceDraft } from "./governanceDraft";

describe("governance draft validation", () => {
  it("accepts all six fixed actions", () => {
    expect(normalizeGovernanceDraft({
      durationHours: 6,
      options: [
        { action: "ACCUMULATE" },
        { action: "BUYBACK_HOLD", reservePercent: 25 },
        { action: "BUYBACK_BURN", reservePercent: 50 },
        { action: "BUYBACK_LOCK", reservePercent: 75, lock: "3_MONTHS" },
        { action: "LOCK_MSTR", reservePercent: 100, lock: "FOREVER" },
        { action: "MARKETING_SALE", reservePercent: 5 },
      ],
    }).options).toHaveLength(6);
  });

  it("enforces the 1 to 12 hour window", () => {
    for (const durationHours of [0, 13, 1.5]) {
      expect(() => normalizeGovernanceDraft({
        durationHours,
        options: [{ action: "ACCUMULATE" }, { action: "BUYBACK_HOLD", reservePercent: 5 }],
      })).toThrow("GOVERNANCE_DRAFT_BAD_DURATION");
    }
  });

  it("requires between two and six unique actions", () => {
    expect(() => normalizeGovernanceDraft({ durationHours: 1, options: [{ action: "ACCUMULATE" }] }))
      .toThrow("GOVERNANCE_DRAFT_BAD_OPTION_COUNT");
    expect(() => normalizeGovernanceDraft({
      durationHours: 1,
      options: [{ action: "ACCUMULATE" }, { action: "ACCUMULATE" }],
    })).toThrow("GOVERNANCE_DRAFT_BAD_OR_DUPLICATE_ACTION");
  });

  it("accepts only 1 to 100 whole reserve percent", () => {
    for (const reservePercent of [0, 101, 2.5]) {
      expect(() => normalizeGovernanceDraft({
        durationHours: 1,
        options: [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN", reservePercent }],
      })).toThrow("GOVERNANCE_DRAFT_BAD_RESERVE_PERCENT");
    }
  });

  it("requires a fixed lock choice only for lock actions", () => {
    expect(() => normalizeGovernanceDraft({
      durationHours: 1,
      options: [{ action: "ACCUMULATE" }, { action: "LOCK_MSTR", reservePercent: 20 }],
    })).toThrow("GOVERNANCE_DRAFT_BAD_LOCK");
    expect(() => normalizeGovernanceDraft({
      durationHours: 1,
      options: [{ action: "ACCUMULATE" }, { action: "MARKETING_SALE", reservePercent: 20, lock: "1_MONTH" }],
    })).toThrow("GOVERNANCE_DRAFT_UNEXPECTED_LOCK");
  });
});
