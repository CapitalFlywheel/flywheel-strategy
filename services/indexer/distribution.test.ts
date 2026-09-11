import { describe, expect, it } from "vitest";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { buildDistribution } from "./distribution";

const alice = "0x00000000000000000000000000000000000000a1";
const bob = "0x00000000000000000000000000000000000000b2";
const carol = "0x00000000000000000000000000000000000000c3";

describe("MSTR distribution builder", () => {
  it("allocates every raw unit and favors larger holding weight", () => {
    const result = buildDistribution(
      new Map([
        [alice, 6n],
        [bob, 3n],
        [carol, 1n],
      ]),
      101n
    );

    expect(result.entries.map((entry) => entry.epochReward)).toEqual([61n, 30n, 10n]);
    expect(result.entries.reduce((sum, entry) => sum + entry.epochReward, 0n)).toBe(101n);
    expect(result.totalWeight).toBe(10n);
  });

  it("builds cumulative leaves compatible with RewardVault", () => {
    const result = buildDistribution(
      new Map([
        [alice, 1n],
        [bob, 1n],
      ]),
      10n,
      new Map([[alice, 20n]])
    );
    const aliceEntry = result.entries.find((entry) => entry.account === alice)!;
    expect(aliceEntry.cumulativeReward).toBe(25n);

    const tree = StandardMerkleTree.load(result.treeDump);
    const index = [...tree.entries()].find(([, value]) => value[0].toLowerCase() === alice)![0];
    expect(tree.verify(index, tree.getProof(index))).toBe(true);
    expect(tree.root).toBe(result.merkleRoot);
    expect(tree.verify(index, aliceEntry.proof)).toBe(true);
  });

  it("keeps an older holder in the new root even with zero weight this epoch", () => {
    const result = buildDistribution(
      new Map([[bob, 1n]]),
      10n,
      new Map([[alice, 25n]])
    );
    const oldHolder = result.entries.find((entry) => entry.account === alice)!;
    expect(oldHolder.weight).toBe(0n);
    expect(oldHolder.epochReward).toBe(0n);
    expect(oldHolder.cumulativeReward).toBe(25n);
    expect(oldHolder.proof.length).toBeGreaterThan(0);
  });

  it("rejects epochs with no rewards or no eligible holder weight", () => {
    expect(() => buildDistribution(new Map([[alice, 1n]]), 0n)).toThrow("EMPTY_REWARD");
    expect(() => buildDistribution(new Map([[alice, 0n]]), 1n)).toThrow("EMPTY_WEIGHT");
  });

  it("preserves every raw reward unit across many uneven holder sets", () => {
    let seed = 42n;
    const next = () => {
      seed = (seed * 1_103_515_245n + 12_345n) % 2_147_483_648n;
      return seed;
    };
    for (let round = 0; round < 100; round += 1) {
      const weights = new Map<string, bigint>();
      const count = Number(next() % 20n) + 1;
      for (let i = 1; i <= count; i += 1) {
        weights.set(`0x${i.toString(16).padStart(40, "0")}`, next() + 1n);
      }
      const reward = next() + 1n;
      const distribution = buildDistribution(weights, reward);
      expect(distribution.entries.reduce((sum, entry) => sum + entry.epochReward, 0n)).toBe(reward);
      expect(distribution.totalEpochReward).toBe(reward);
    }
  });
});
