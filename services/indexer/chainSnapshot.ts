import { parseAbiItem, type Address, type PublicClient } from "viem";
import { HoldingWeightEngine, type TransferEvent } from "./holdingMath";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

export interface WeightSnapshot {
  token: Address;
  fromBlock: bigint;
  toBlock: bigint;
  windowStart: number;
  windowEnd: number;
  transfersProcessed: number;
  weights: Map<string, bigint>;
}

export interface IndexedTransferEvent extends TransferEvent {
  blockNumber: bigint;
  sourceId: string;
}

export async function fetchTransferEvents(
  client: PublicClient,
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize = 50_000n
): Promise<IndexedTransferEvent[]> {
  if (toBlock < fromBlock) throw new Error("INVALID_BLOCK_RANGE");
  if (chunkSize <= 0n) throw new Error("INVALID_CHUNK_SIZE");

  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
    logs.push(...await client.getLogs({ address: token, event: transferEvent, fromBlock: start, toBlock: end }));
  }

  const blockNumbers = [...new Set(logs.map((log) => log.blockNumber.toString()))].map(BigInt);
  const timestamps = new Map<bigint, number>();
  for (let i = 0; i < blockNumbers.length; i += 25) {
    const batch = blockNumbers.slice(i, i + 25);
    const blocks = await Promise.all(batch.map((blockNumber) => client.getBlock({ blockNumber })));
    blocks.forEach((block, index) => timestamps.set(batch[index], Number(block.timestamp)));
  }

  return logs
    .map((log) => ({
      from: log.args.from!,
      to: log.args.to!,
      amount: log.args.value!,
      timestamp: timestamps.get(log.blockNumber)!,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
    }))
    .sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
      return a.logIndex - b.logIndex;
    })
    .map(({ from, to, amount, timestamp, blockNumber, logIndex }) => ({
      from,
      to,
      amount,
      timestamp,
      blockNumber,
      sourceId: `${blockNumber}:${logIndex}`,
    }));
}

export function buildWeightSnapshotFromTransfers(
  token: Address,
  launchBlock: bigint,
  toBlock: bigint,
  windowStart: number,
  windowEnd: number,
  excludedAddresses: ReadonlySet<string>,
  transfers: readonly TransferEvent[]
): WeightSnapshot {
  const engine = new HoldingWeightEngine(windowStart, windowEnd, new Set(excludedAddresses));
  for (const transfer of transfers) engine.apply(transfer);
  return {
    token,
    fromBlock: launchBlock,
    toBlock,
    windowStart,
    windowEnd,
    transfersProcessed: transfers.length,
    weights: engine.finalize(),
  };
}

export async function buildChainWeightSnapshot(
  client: PublicClient,
  token: Address,
  launchBlock: bigint,
  toBlock: bigint,
  windowStart: number,
  windowEnd: number,
  excludedAddresses: ReadonlySet<string>
): Promise<WeightSnapshot> {
  const transfers = await fetchTransferEvents(client, token, launchBlock, toBlock);
  return buildWeightSnapshotFromTransfers(
    token, launchBlock, toBlock, windowStart, windowEnd, excludedAddresses, transfers
  );
}

export function serializableSnapshot(snapshot: WeightSnapshot) {
  return {
    ...snapshot,
    fromBlock: snapshot.fromBlock.toString(),
    toBlock: snapshot.toBlock.toString(),
    weights: [...snapshot.weights.entries()]
      .map(([account, weight]) => ({ account, weight: weight.toString() }))
      .sort((a, b) => a.account.localeCompare(b.account)),
  };
}
