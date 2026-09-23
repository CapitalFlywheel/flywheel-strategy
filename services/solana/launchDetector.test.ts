import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { detectCreatorPumpLaunch, selectArmedLaunchCandidate, type PumpCreateCandidate } from "./launchDetector";

function candidate(creator: string, blockTime: number, mint = Keypair.generate().publicKey.toBase58()): PumpCreateCandidate {
  return {
    signature: "signature",
    slot: 10,
    blockTime,
    mint,
    creator,
    user: creator,
    quoteMint: Keypair.generate().publicKey.toBase58(),
    tokenProgram: Keypair.generate().publicKey.toBase58(),
    creatorFeeBps: 200n,
    isHolderReward: false,
  };
}

describe("armed Pump launch selection", () => {
  it("ignores activity before arming and other creators", () => {
    const creator = Keypair.generate().publicKey.toBase58();
    const expected = candidate(creator, 20);
    expect(selectArmedLaunchCandidate({
      candidates: [candidate(creator, 9), candidate(Keypair.generate().publicKey.toBase58(), 21), expected],
      creator,
      armedAtMs: 10_000,
    })).toEqual(expected);
  });

  it("accepts a launch within the same block-time second as arming", () => {
    const creator = Keypair.generate().publicKey.toBase58();
    const launched = candidate(creator, 10);
    expect(selectArmedLaunchCandidate({ candidates: [launched], creator, armedAtMs: 10_800 })).toEqual(launched);
  });

  it("fails closed when the creator launches more than one coin after arming", () => {
    const creator = Keypair.generate().publicKey.toBase58();
    expect(() => selectArmedLaunchCandidate({
      candidates: [candidate(creator, 20), candidate(creator, 21)],
      creator,
      armedAtMs: 10_000,
    })).toThrow("MULTIPLE_PUMP_LAUNCHES_AFTER_ARM");
  });

  it("paginates past the first page of creator activity after arming", async () => {
    const creator = Keypair.generate().publicKey.toBase58();
    const pages = [
      [{ signature: "new-3", blockTime: 20, err: null }, { signature: "new-2", blockTime: 19, err: null }],
      [{ signature: "new-1", blockTime: 18, err: null }, { signature: "old", blockTime: 9, err: null }],
    ];
    const list = vi.spyOn(Connection.prototype, "getSignaturesForAddress").mockImplementation(async () => pages.shift() as never);
    const getTransaction = vi.spyOn(Connection.prototype, "getTransaction").mockResolvedValue(null);
    try {
      await expect(detectCreatorPumpLaunch({ rpcUrl: "https://rpc.example", creator, armedAtMs: 10_000, limit: 2 })).resolves.toBeUndefined();
      expect(list).toHaveBeenCalledTimes(2);
      expect(getTransaction).toHaveBeenCalledTimes(3);
    } finally {
      list.mockRestore();
      getTransaction.mockRestore();
    }
  });
});
