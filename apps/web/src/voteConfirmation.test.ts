import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { awaitFinalizedVote } from "./voteConfirmation";

describe("HTTP vote confirmation", () => {
  it("accepts only a successful finalized status", async () => {
    const reader = {
      getSignatureStatuses: vi.fn().mockResolvedValueOnce({ value: [{ confirmationStatus: "confirmed", err: null }] })
        .mockResolvedValueOnce({ value: [{ confirmationStatus: "finalized", err: null }] }),
      getBlockHeight: vi.fn().mockResolvedValue(4),
    } as unknown as Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;
    await expect(awaitFinalizedVote(reader, "signature", 9, { delay: async () => undefined })).resolves.toBeUndefined();
    expect(reader.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });

  it("keeps an unresolved expired transaction distinct from a failed finalized one", async () => {
    const reader = {
      getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }),
      getBlockHeight: vi.fn().mockResolvedValue(10),
    } as unknown as Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;
    await expect(awaitFinalizedVote(reader, "sig-unproven", 9)).rejects.toThrow("outcome not proven");
    const failed = {
      getSignatureStatuses: vi.fn().mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }] }),
      getBlockHeight: vi.fn(),
    } as unknown as Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;
    await expect(awaitFinalizedVote(failed, "sig-failed", 9)).rejects.toThrow("onchain error");
    expect(failed.getBlockHeight).not.toHaveBeenCalled();
  });
});
