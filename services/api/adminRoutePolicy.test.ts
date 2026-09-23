import { describe, expect, it } from "vitest";
import { blockLegacyAdminPath, solanaAdminMode } from "./adminRoutePolicy";

describe("legacy admin route policy", () => {
  it("closes every old admin route when the Solana owner is configured, even without SOLANA_CLUSTER", () => {
    const mode = solanaAdminMode(undefined, "9tiKUSwJrdJQzySro2pWJmWLw83NpdGwrvTCUesSP9NQ");
    expect(mode).toBe(true);
    for (const path of ["/admin", "/admin/", "/admin/api/status", "/admin/api/action", "/admin/api/reserve-quote"]) {
      expect(blockLegacyAdminPath(path, mode)).toBe(true);
    }
    expect(blockLegacyAdminPath("/private-panel/api/solana/status", mode)).toBe(false);
  });

  it("also closes old routes when the Solana cluster is explicit", () => {
    expect(blockLegacyAdminPath("/admin/api/challenge", solanaAdminMode("mainnet-beta", undefined))).toBe(true);
  });

  it("preserves Robinhood's legacy API without exposing its public /admin page", () => {
    const mode = solanaAdminMode(undefined, undefined);
    expect(mode).toBe(false);
    expect(blockLegacyAdminPath("/admin", mode)).toBe(true);
    expect(blockLegacyAdminPath("/admin/other", mode)).toBe(true);
    expect(blockLegacyAdminPath("/admin/api/status", mode)).toBe(false);
    expect(blockLegacyAdminPath("/admin/api/action", mode)).toBe(false);
  });
});
