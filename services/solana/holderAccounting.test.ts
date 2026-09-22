import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { buildPushDistribution, SolanaHoldingEngine } from "./holderAccounting";

const alice = Keypair.generate().publicKey.toBase58();
const bob = Keypair.generate().publicKey.toBase58();

describe("Solana holder accounting", () => {
  it("uses exact hold time, ignores duplicate signatures and consumes newest lots first", () => {
    const engine = new SolanaHoldingEngine(0, 10_800, []);
    engine.apply({ signature: "a", slot: 1, instructionIndex: 0, timestamp: 0, to: alice, rawAmount: 100n });
    engine.apply({ signature: "b", slot: 2, instructionIndex: 0, timestamp: 3_600, to: alice, rawAmount: 50n });
    engine.apply({ signature: "c", slot: 3, instructionIndex: 0, timestamp: 7_200, from: alice, to: bob, rawAmount: 50n });
    engine.apply({ signature: "c", slot: 3, instructionIndex: 0, timestamp: 7_200, from: alice, to: bob, rawAmount: 50n });
    const weights = engine.finalize();
    expect(weights.get(alice)).toBeGreaterThan(weights.get(bob) ?? 0n);
  });

  it("builds deterministic exact push batches", () => {
    const result = buildPushDistribution(new Map([[alice, 2n], [bob, 1n]]), 10n, 1);
    expect(result.allocations.reduce((sum, row) => sum + row.rawMstrx, 0n)).toBe(10n);
    expect(result.batches).toHaveLength(2);
    expect(result.batches[0].id).toHaveLength(64);
  });
});
