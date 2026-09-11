import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

export interface DistributionEntry {
  account: string;
  weight: bigint;
  epochReward: bigint;
  cumulativeReward: bigint;
  proof: string[];
}

export interface Distribution {
  merkleRoot: string;
  totalWeight: bigint;
  totalEpochReward: bigint;
  entries: DistributionEntry[];
  treeDump: ReturnType<StandardMerkleTree<[string, string]>["dump"]>;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/**
 * Splits raw MSTR units proportionally to holder weight. Integer dust is assigned
 * by largest remainder, making the epoch add up exactly without losing a wei.
 */
export function buildDistribution(
  weights: ReadonlyMap<string, bigint>,
  totalEpochReward: bigint,
  previousCumulative: ReadonlyMap<string, bigint> = new Map()
): Distribution {
  if (totalEpochReward <= 0n) throw new Error("EMPTY_REWARD");

  const rows = [...weights.entries()]
    .map(([account, weight]) => ({ account: normalizeAddress(account), weight }))
    .filter(({ weight }) => weight > 0n)
    .sort((a, b) => a.account.localeCompare(b.account));
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0n);
  if (totalWeight === 0n) throw new Error("EMPTY_WEIGHT");

  const provisional = rows.map((row) => {
    const numerator = totalEpochReward * row.weight;
    return {
      ...row,
      epochReward: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });
  let assigned = provisional.reduce((sum, row) => sum + row.epochReward, 0n);
  const byRemainder = [...provisional].sort((a, b) => {
    if (a.remainder === b.remainder) return a.account.localeCompare(b.account);
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (let i = 0; assigned < totalEpochReward; i += 1) {
    byRemainder[i].epochReward += 1n;
    assigned += 1n;
  }

  const rewardByAddress = new Map(byRemainder.map((row) => [row.account, row.epochReward]));
  const normalizedPrevious = new Map<string, bigint>();
  for (const [account, cumulative] of previousCumulative) {
    normalizedPrevious.set(normalizeAddress(account), cumulative);
  }
  const weightByAddress = new Map(rows.map((row) => [row.account, row.weight]));
  const allAccounts = [...new Set([...weightByAddress.keys(), ...normalizedPrevious.keys()])].sort();
  const entries: DistributionEntry[] = allAccounts.map((account) => {
    const weight = weightByAddress.get(account) ?? 0n;
    const epochReward = rewardByAddress.get(account) ?? 0n;
    const cumulativeReward = (normalizedPrevious.get(account) ?? 0n) + epochReward;
    return { account, weight, epochReward, cumulativeReward, proof: [] };
  });

  const tree = StandardMerkleTree.of<[string, string]>(
    entries.map((entry) => [entry.account, entry.cumulativeReward.toString()]),
    ["address", "uint256"]
  );
  for (const [index, value] of tree.entries()) {
    const entry = entries.find(
      (candidate) => candidate.account === value[0].toLowerCase()
        && candidate.cumulativeReward.toString() === value[1]
    );
    if (!entry) throw new Error("TREE_ENTRY_MISMATCH");
    entry.proof = tree.getProof(index);
  }

  return {
    merkleRoot: tree.root,
    totalWeight,
    totalEpochReward,
    entries,
    treeDump: tree.dump(),
  };
}
