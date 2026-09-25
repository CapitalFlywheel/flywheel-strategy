import { describe, expect, it } from "vitest";
import { requireGovernanceExecutionReleased, SOLANA_GOVERNANCE_EXECUTION_RELEASED } from "./releaseGates";
import { automaticFeeTick, automaticOwedRetryTick, automaticRewardTick, parkUnreleasedLaunch } from "./controlRunner";

describe("Solana governance execution release gate", () => {
  it("keeps optional onchain governance execution disabled", () => {
    expect(SOLANA_GOVERNANCE_EXECUTION_RELEASED).toBe(false);
    expect(() => requireGovernanceExecutionReleased()).toThrow("GOVERNANCE_EXECUTION_NOT_RELEASED");
  });

  it("does not disarm the core launch detector merely because optional governance is disabled", async () => {
    const stale = {
      network: "solana-mainnet-beta" as const, automationState: "stopped" as const,
      launch: { configured: true, armed: true, armedAt: 1, activated: false },
      services: {}, balances: {}, conversionsPaused: false, updatedAt: 0,
    };
    expect(await automaticFeeTick(stale)).toBe(false);
    expect(await automaticRewardTick(stale)).toBe(false);
    expect(await automaticOwedRetryTick(stale)).toBe(false);
    parkUnreleasedLaunch(stale);
    expect(stale.launch).toMatchObject({ armed: true, activated: false, armedAt: 1 });
    expect(stale.automationState).toBe("stopped");
    expect(stale.conversionsPaused).toBe(false);
  });
});
