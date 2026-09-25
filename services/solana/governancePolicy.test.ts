import { describe, expect, it } from "vitest";
import { finalizeGovernanceResult, freezeGovernanceProposal, governanceWindowStart, type GovernanceOption } from "./governancePolicy";

const marketingWallet = "8VffEDVrevGdRgDZP1rEDjWiZ3UvR256993C1ugCS73r";
const basicOptions: GovernanceOption[] = [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN", minOutputRaw: 250n }];

function proposal(overrides: Partial<Parameters<typeof freezeGovernanceProposal>[0]> = {}) {
  return freezeGovernanceProposal({
    id: 1n, now: 1_800_000_000, votingDurationSeconds: 3_600,
    snapshotRoot: "ab".repeat(32), totalAvailableWeight: 100n,
    availableReserveRawMstrx: 700n, options: basicOptions, ...overrides,
  });
}

describe("Solana governance reference policy", () => {
  it("uses at most one day of holder history without going before mint creation", () => {
    expect(governanceWindowStart(100_000, 99_000)).toBe(99_000);
    expect(governanceWindowStart(200_000, 99_000)).toBe(113_600);
    expect(() => governanceWindowStart(99_000, 99_000)).toThrow("GOVERNANCE_WINDOW_INVALID");
  });
  it("freezes the entire starting reserve for each spending action, but not accumulate", () => {
    const frozen = proposal();
    expect(frozen.options.map((option) => option.reserveRawMstrx)).toEqual([0n, 700n]);
    expect(frozen.options.map((option) => option.minOutputRaw)).toEqual([0n, 250n]);
    expect(frozen.frozenReserveRawMstrx).toBe(700n);
    expect(frozen.executableAt).toBe(frozen.endsAt + 300);
  });

  it("rejects duplicate, unknown and unapproved recipient options", () => {
    expect(() => proposal({ options: [{ action: "ACCUMULATE" }, { action: "ACCUMULATE" }] })).toThrow("GOVERNANCE_OPTION_DUPLICATE_OR_UNKNOWN");
    expect(() => proposal({ options: [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN", recipient: marketingWallet, minOutputRaw: 1n }] })).toThrow("GOVERNANCE_RECIPIENT_UNEXPECTED");
    expect(() => proposal({ options: [{ action: "ACCUMULATE" }, { action: "MARKETING_SALE", recipient: marketingWallet, minOutputRaw: 1n }] })).toThrow("GOVERNANCE_MARKETING_RECIPIENT_INVALID");
    expect(proposal({ options: [{ action: "ACCUMULATE" }, { action: "MARKETING_SALE", recipient: marketingWallet, minOutputRaw: 1n }], marketingWallet }).options[1].recipient).toBe(marketingWallet);
    expect(() => proposal({ options: [{ action: "BUYBACK_HOLD", minOutputRaw: 1n }, { action: "BUYBACK_BURN", minOutputRaw: 1n }] })).toThrow("GOVERNANCE_NO_ACCUMULATE_OPTION");
  });

  it("requires an approved lock term and bounded vote duration", () => {
    expect(() => proposal({ options: [{ action: "ACCUMULATE" }, { action: "BUYBACK_LOCK", lockDurationSeconds: 7 * 86_400, minOutputRaw: 1n }] })).toThrow("GOVERNANCE_LOCK_DURATION_INVALID");
    expect(() => proposal({ votingDurationSeconds: 12 * 3_600 + 1 })).toThrow("GOVERNANCE_DURATION_INVALID");
    expect(proposal({ options: [{ action: "ACCUMULATE" }, { action: "LOCK_MSTRX", lockDurationSeconds: 30 * 86_400 }] }).options[1].lockDurationSeconds).toBe(30 * 86_400);
  });

  it("requires a voted, immutable output floor only for conversion actions", () => {
    expect(() => proposal({ options: [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN" }] })).toThrow("GOVERNANCE_MIN_OUTPUT_INVALID");
    expect(() => proposal({ options: [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN", minOutputRaw: 0n }] })).toThrow("GOVERNANCE_MIN_OUTPUT_INVALID");
    expect(() => proposal({ options: [{ action: "ACCUMULATE", minOutputRaw: 1n }, basicOptions[1]] })).toThrow("GOVERNANCE_MIN_OUTPUT_INVALID");
    expect(() => proposal({ options: [{ action: "ACCUMULATE" }, { action: "LOCK_MSTRX", lockDurationSeconds: 30 * 86_400, minOutputRaw: 1n }] })).toThrow("GOVERNANCE_MIN_OUTPUT_INVALID");
    expect(() => proposal({ options: [{ action: "ACCUMULATE" }, { action: "MARKETING_SALE", recipient: marketingWallet, minOutputRaw: 0n }], marketingWallet })).toThrow("GOVERNANCE_MIN_OUTPUT_INVALID");
    expect(proposal({ options: [{ action: "ACCUMULATE" }, { action: "MARKETING_SALE", recipient: marketingWallet, minOutputRaw: 1_000_000_000n }], marketingWallet }).options[1].minOutputRaw).toBe(1_000_000_000n);
  });

  it("refuses values that cannot be represented in Solana instruction state", () => {
    expect(() => proposal({ id: 1n << 64n })).toThrow("GOVERNANCE_ID_OR_TIME_INVALID");
    expect(() => proposal({ totalAvailableWeight: 1n << 128n })).toThrow("GOVERNANCE_SNAPSHOT_INVALID");
    expect(() => proposal({ availableReserveRawMstrx: 1n << 64n })).toThrow("GOVERNANCE_RESERVE_AMOUNT_INVALID");
    expect(() => proposal({ options: [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN", minOutputRaw: 1n << 64n }] })).toThrow("GOVERNANCE_MIN_OUTPUT_INVALID");
    expect(() => proposal({ now: Number.MAX_SAFE_INTEGER - 3_600 })).toThrow("GOVERNANCE_TIME_OVERFLOW");
  });

  it("uses the original available weight for quorum and rejects ties", () => {
    const frozen = proposal();
    expect(finalizeGovernanceResult(frozen, [0n, 6n], frozen.executableAt)).toEqual({ status: "rejected", reason: "QUORUM_NOT_REACHED" });
    expect(finalizeGovernanceResult(frozen, [4n, 4n], frozen.executableAt)).toEqual({ status: "rejected", reason: "TIED_RESULT" });
    expect(finalizeGovernanceResult(frozen, [0n, 7n], frozen.executableAt)).toMatchObject({ status: "passed", winningOption: 1, action: { action: "BUYBACK_BURN", reserveRawMstrx: 700n } });
    expect(() => finalizeGovernanceResult(frozen, [0n, 101n], frozen.executableAt)).toThrow("GOVERNANCE_WEIGHT_EXCEEDED");
    expect(() => finalizeGovernanceResult(frozen, [0n, 7n], frozen.executableAt - 1)).toThrow("GOVERNANCE_NOT_EXECUTABLE");
  });

  it("treats an ACCUMULATE win as an executed no-op that releases its commitment", () => {
    const frozen = proposal();
    expect(finalizeGovernanceResult(frozen, [7n, 0n], frozen.executableAt)).toMatchObject({
      status: "executed", winningOption: 0, releasedRawMstrx: 700n,
      action: { action: "ACCUMULATE", reserveRawMstrx: 0n },
    });
  });
});
