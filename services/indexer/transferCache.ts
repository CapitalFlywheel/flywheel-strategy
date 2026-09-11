import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAddress, type Address, type PublicClient } from "viem";
import { fetchTransferEvents, type IndexedTransferEvent } from "./chainSnapshot";

interface StoredTransfer {
  from: string;
  to: string;
  amount: string;
  timestamp: number;
  blockNumber: string;
  sourceId: string;
}

interface TransferCacheFile {
  version: 1;
  token: string;
  launchBlock: string;
  lastIndexedBlock: string | null;
  events: StoredTransfer[];
}

interface AlchemyTransfer {
  blockNum: string;
  uniqueId: string;
  from: string;
  to: string;
  rawContract: { value?: string | null; address?: string | null };
  metadata?: { blockTimestamp?: string };
}

interface AlchemyResponse {
  result?: { transfers: AlchemyTransfer[]; pageKey?: string };
  error?: { message?: string };
}

export interface TransferCacheOptions {
  client: PublicClient;
  rpcUrl: string;
  token: Address;
  launchBlock: bigint;
  toBlock: bigint;
  cachePath: string;
  source?: "alchemy" | "logs";
  logChunkSize?: bigint;
  overlapBlocks?: bigint;
  fetchImplementation?: typeof fetch;
}

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

function emptyCache(token: Address, launchBlock: bigint): TransferCacheFile {
  return { version: 1, token, launchBlock: launchBlock.toString(), lastIndexedBlock: null, events: [] };
}

async function loadCache(path: string, token: Address, launchBlock: bigint): Promise<TransferCacheFile> {
  let cache: TransferCacheFile;
  try {
    cache = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCache(token, launchBlock);
    throw error;
  }
  if (
    cache.version !== 1
      || getAddress(cache.token) !== token
      || BigInt(cache.launchBlock) !== launchBlock
      || !Array.isArray(cache.events)
  ) {
    throw new Error("TRANSFER_CACHE_CONFIGURATION_MISMATCH");
  }
  return cache;
}

function serialize(event: IndexedTransferEvent): StoredTransfer {
  return {
    from: event.from,
    to: event.to,
    amount: event.amount.toString(),
    timestamp: event.timestamp,
    blockNumber: event.blockNumber.toString(),
    sourceId: event.sourceId,
  };
}

function deserialize(event: StoredTransfer): IndexedTransferEvent {
  return {
    from: event.from,
    to: event.to,
    amount: BigInt(event.amount),
    timestamp: event.timestamp,
    blockNumber: BigInt(event.blockNumber),
    sourceId: event.sourceId,
  };
}

function hexBlock(block: bigint): `0x${string}` {
  return `0x${block.toString(16)}`;
}

export async function fetchAlchemyTransferEvents(
  rpcUrl: string,
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
  fetchImplementation: typeof fetch = fetch
): Promise<IndexedTransferEvent[]> {
  if (!rpcUrl.includes("alchemy.com")) throw new Error("ALCHEMY_TRANSFER_SOURCE_REQUIRES_ALCHEMY_URL");
  const events: IndexedTransferEvent[] = [];
  let pageKey: string | undefined;
  do {
    const parameters: Record<string, unknown> = {
      fromBlock: hexBlock(fromBlock),
      toBlock: hexBlock(toBlock),
      contractAddresses: [token],
      category: ["erc20"],
      excludeZeroValue: false,
      withMetadata: true,
      maxCount: "0x3e8",
      order: "asc",
    };
    if (pageKey) parameters.pageKey = pageKey;
    const response = await fetchImplementation(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [parameters] }),
    });
    if (!response.ok) throw new Error(`ALCHEMY_TRANSFERS_HTTP_${response.status}`);
    const payload = await response.json() as AlchemyResponse;
    if (payload.error || !payload.result) {
      throw new Error(`ALCHEMY_TRANSFERS_ERROR:${payload.error?.message || "missing result"}`);
    }
    for (const transfer of payload.result.transfers) {
      const rawValue = transfer.rawContract.value;
      const timestamp = transfer.metadata?.blockTimestamp;
      if (!rawValue || !timestamp || !transfer.uniqueId) throw new Error("ALCHEMY_TRANSFER_MISSING_RAW_DATA");
      if (transfer.rawContract.address && getAddress(transfer.rawContract.address) !== token) {
        throw new Error("ALCHEMY_TRANSFER_WRONG_TOKEN");
      }
      events.push({
        from: getAddress(transfer.from),
        to: getAddress(transfer.to),
        amount: BigInt(rawValue),
        timestamp: Math.floor(Date.parse(timestamp) / 1000),
        blockNumber: BigInt(transfer.blockNum),
        sourceId: transfer.uniqueId,
      });
    }
    pageKey = payload.result.pageKey || undefined;
  } while (pageKey);
  return events;
}

export async function updateTransferCache(options: TransferCacheOptions): Promise<IndexedTransferEvent[]> {
  const cache = await loadCache(options.cachePath, options.token, options.launchBlock);
  const overlap = options.overlapBlocks ?? 1_000n;
  const previousEnd = cache.lastIndexedBlock === null ? options.launchBlock - 1n : BigInt(cache.lastIndexedBlock);
  if (options.toBlock < options.launchBlock) return [];
  if (options.toBlock + overlap < previousEnd) throw new Error("TRANSFER_CACHE_AHEAD_OF_CHAIN");

  const refreshStart = previousEnd < options.launchBlock
    ? options.launchBlock
    : (previousEnd - overlap + 1n > options.launchBlock ? previousEnd - overlap + 1n : options.launchBlock);
  const oldEvents = cache.events
    .map(deserialize)
    .filter((event) => event.blockNumber < refreshStart);
  const source = options.source ?? (options.rpcUrl.includes("alchemy.com") ? "alchemy" : "logs");
  const freshEvents = source === "alchemy"
    ? await fetchAlchemyTransferEvents(
        options.rpcUrl, options.token, refreshStart, options.toBlock, options.fetchImplementation
      )
    : await fetchTransferEvents(
        options.client, options.token, refreshStart, options.toBlock, options.logChunkSize ?? 5_000n
      );
  const seen = new Set<string>();
  const events = [...oldEvents, ...freshEvents].filter((event) => {
    if (seen.has(event.sourceId)) return false;
    seen.add(event.sourceId);
    return true;
  });
  await atomicJson(options.cachePath, {
    version: 1,
    token: options.token,
    launchBlock: options.launchBlock.toString(),
    lastIndexedBlock: options.toBlock.toString(),
    events: events.map(serialize),
  } satisfies TransferCacheFile);
  return events;
}
