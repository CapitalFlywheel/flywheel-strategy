import { describe, expect, it } from "vitest";
import { normalizeGovernanceProposalPreviewRequest, validateGovernancePreviewRpcPair } from "./governanceProposalPreview";

const valid = () => ({ mode: "initial", votingDurationSeconds: 3_600,
  options: [{ action: "ACCUMULATE" }, { action: "BUYBACK_BURN", minOutputRaw: "1" }] });

describe("owner-only governance proposal preview request", () => {
  it("accepts exact typed setup without an arbitrary recipient or instruction", () => {
    expect(normalizeGovernanceProposalPreviewRequest(valid())).toEqual(valid());
    expect(normalizeGovernanceProposalPreviewRequest({ ...valid(), mode: "revote" }).mode).toBe("revote");
  });

  it("rejects unknown fields, wrong ranges and malformed raw units before any RPC work", () => {
    expect(() => normalizeGovernanceProposalPreviewRequest({ ...valid(), transaction: "base64" }))
      .toThrow("GOVERNANCE_PREVIEW_REQUEST_INVALID");
    expect(() => normalizeGovernanceProposalPreviewRequest({ ...valid(), votingDurationSeconds: 59 }))
      .toThrow("GOVERNANCE_PREVIEW_REQUEST_INVALID");
    expect(() => normalizeGovernanceProposalPreviewRequest({ ...valid(), options: [
      { action: "ACCUMULATE" }, { action: "MARKETING_SALE", minOutputRaw: "1", recipient: "attacker" },
    ] })).toThrow("GOVERNANCE_PREVIEW_OPTION_INVALID");
    expect(() => normalizeGovernanceProposalPreviewRequest({ ...valid(), options: [
      { action: "ACCUMULATE" }, { action: "BUYBACK_BURN", minOutputRaw: "01" },
    ] })).toThrow("GOVERNANCE_PREVIEW_OPTION_INVALID");
    expect(() => normalizeGovernanceProposalPreviewRequest({ ...valid(), options: [
      { action: "ACCUMULATE" }, { action: "BUYBACK_BURN", minOutputRaw: (1n << 64n).toString() },
    ] })).toThrow("GOVERNANCE_PREVIEW_OPTION_INVALID");
  });

  it("requires two independent HTTPS RPC hosts without URL credentials or fragments", () => {
    expect(() => validateGovernancePreviewRpcPair(["https://primary.invalid/key", "https://fallback.invalid/key"]))
      .not.toThrow();
    for (const pair of [
      ["http://primary.invalid", "https://fallback.invalid"],
      ["https://primary.invalid", "https://primary.invalid/other"],
      ["https://user:secret@primary.invalid", "https://fallback.invalid"],
      ["https://primary.invalid/#secret", "https://fallback.invalid"],
    ] as const) {
      expect(() => validateGovernancePreviewRpcPair(pair)).toThrow("GOVERNANCE_PREVIEW_RPC_PAIR_INVALID");
    }
  });
});
