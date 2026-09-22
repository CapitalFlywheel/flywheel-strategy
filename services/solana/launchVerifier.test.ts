import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { assertFixedMstrxPumpLaunch } from "./launchVerifier";

const creator = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const valid = {
  mint,
  creator,
  expectedCreator: creator,
  quoteMint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
  expectedQuoteMint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
  tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  isHolderReward: false,
  creatorFeeBps: 200n,
};

describe("Pump launch verification", () => {
  it("accepts the intended fixed 2% MSTRx custom-pair launch", () => expect(assertFixedMstrxPumpLaunch(valid)).toBe(true));
  it("rejects native Pump holder rewards", () => expect(() => assertFixedMstrxPumpLaunch({ ...valid, isHolderReward: true })).toThrow("PUMP_NATIVE_HOLDER_REWARD_ENABLED"));
  it("rejects an unexpected creator", () => expect(() => assertFixedMstrxPumpLaunch({ ...valid, expectedCreator: Keypair.generate().publicKey.toBase58() })).toThrow("PUMP_CREATOR_MISMATCH"));
  it("rejects a creator fee other than 2%", () => expect(() => assertFixedMstrxPumpLaunch({ ...valid, creatorFeeBps: 150n })).toThrow("PUMP_CREATOR_FEE_NOT_2_PERCENT"));
  it("rejects a non-MSTRx quote", () => expect(() => assertFixedMstrxPumpLaunch({ ...valid, quoteMint: Keypair.generate().publicKey.toBase58() })).toThrow("PUMP_QUOTE_NOT_MSTRX"));
});
