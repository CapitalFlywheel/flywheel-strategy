import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Address, Hex, PublicClient } from "viem";
import { buildChainWeightSnapshot, buildWeightSnapshotFromTransfers } from "../indexer/chainSnapshot";
import { governanceLookbackSeconds, type TransferEvent } from "../indexer/holdingMath";

export interface GovernanceSnapshotEntry {
  account: Address;
  weight: string;
  proof: Hex[];
}

export function buildGovernanceSnapshotFromTransfers(
  token: Address,
  launchBlock: bigint,
  toBlock: bigint,
  launchTimestamp: number,
  windowEnd: number,
  exclusions: ReadonlySet<string>,
  transfers: readonly TransferEvent[]
) {
  const projectAge = windowEnd - launchTimestamp;
  const windowStart = windowEnd - governanceLookbackSeconds(projectAge);
  const snapshot = buildWeightSnapshotFromTransfers(
    token, launchBlock, toBlock, windowStart, windowEnd, exclusions, transfers
  );
  return finalizeGovernanceSnapshot(snapshot);
}

export async function buildGovernanceSnapshot(
  client: PublicClient,
  token: Address,
  launchBlock: bigint,
  launchTimestamp: number,
  exclusions: ReadonlySet<string>
) {
  const toBlock = await client.getBlockNumber();
  const block = await client.getBlock({ blockNumber: toBlock });
  const windowEnd = Number(block.timestamp);
  const projectAge = windowEnd - launchTimestamp;
  const windowStart = windowEnd - governanceLookbackSeconds(projectAge);
  const snapshot = await buildChainWeightSnapshot(
    client, token, launchBlock, toBlock, windowStart, windowEnd, exclusions
  );
  return finalizeGovernanceSnapshot(snapshot);
}

function finalizeGovernanceSnapshot(snapshot: Awaited<ReturnType<typeof buildChainWeightSnapshot>>) {
  const rows = [...snapshot.weights.entries()]
    .filter(([, weight]) => weight > 0n)
    .map(([account, weight]) => [account.toLowerCase(), weight.toString()] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (rows.length === 0) throw new Error("NO_ELIGIBLE_HOLDERS");
  const tree = StandardMerkleTree.of(rows, ["address", "uint256"]);
  const entries: GovernanceSnapshotEntry[] = [];
  for (const [index, value] of tree.entries()) {
    entries.push({ account: value[0] as Address, weight: value[1], proof: tree.getProof(index) as Hex[] });
  }
  entries.sort((a, b) => a.account.localeCompare(b.account));
  const totalAvailableWeight = entries.reduce((sum, entry) => sum + BigInt(entry.weight), 0n);
  if (totalAvailableWeight > (1n << 128n) - 1n) throw new Error("GOVERNANCE_WEIGHT_EXCEEDS_UINT128");
  return {
    status: "prepared",
    chainId: 4663,
    token: snapshot.token,
    fromBlock: snapshot.fromBlock.toString(),
    toBlock: snapshot.toBlock.toString(),
    windowStart: snapshot.windowStart,
    windowEnd: snapshot.windowEnd,
    transfersProcessed: snapshot.transfersProcessed,
    merkleRoot: tree.root as Hex,
    totalAvailableWeight: totalAvailableWeight.toString(),
    entries,
    tree: tree.dump(),
  };
}
