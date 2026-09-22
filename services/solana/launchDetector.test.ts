import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { selectArmedLaunchCandidate, type PumpCreateCandidate } from "./launchDetector";

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

  it("fails closed when the creator launches more than one coin after arming", () => {
    const creator = Keypair.generate().publicKey.toBase58();
    expect(() => selectArmedLaunchCandidate({
      candidates: [candidate(creator, 20), candidate(creator, 21)],
      creator,
      armedAtMs: 10_000,
    })).toThrow("MULTIPLE_PUMP_LAUNCHES_AFTER_ARM");
  });
});
