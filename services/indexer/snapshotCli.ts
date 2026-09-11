import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { createPublicClient, type Address } from "viem";
import { buildWeightSnapshotFromTransfers, serializableSnapshot } from "./chainSnapshot";
import { updateTransferCache } from "./transferCache";
import { rpcTransport } from "../shared/rpc";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const token = required("PROJECT_TOKEN_ADDRESS") as Address;
  const launchBlock = BigInt(required("PROJECT_LAUNCH_BLOCK"));
  const windowStart = Number(required("SNAPSHOT_WINDOW_START"));
  const windowEnd = Number(required("SNAPSHOT_WINDOW_END"));
  const outputPath = process.env.SNAPSHOT_OUTPUT || "snapshot.json";
  const excluded = new Set(
    (process.env.EXCLUDED_REWARD_ADDRESSES || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  const client = createPublicClient({
    transport: rpcTransport(rpcUrl, process.env.ROBINHOOD_RPC_FALLBACK_URL),
  });
  const head = await client.getBlockNumber();
  const confirmations = BigInt(process.env.INDEXER_CONFIRMATIONS || "1000");
  const toBlock = head > confirmations ? head - confirmations : head;
  const source = (process.env.TRANSFER_SOURCE || (rpcUrl.includes("alchemy.com") ? "alchemy" : "logs")) as "alchemy" | "logs";
  const transfers = await updateTransferCache({
    client,
    rpcUrl,
    token,
    launchBlock,
    toBlock,
    cachePath: process.env.TRANSFER_CACHE_PATH || "data/transfer-events.json",
    source,
    logChunkSize: BigInt(process.env.INDEXER_LOG_CHUNK_SIZE || (source === "alchemy" ? "10" : "5000")),
  });
  const snapshot = buildWeightSnapshotFromTransfers(
    token, launchBlock, toBlock, windowStart, windowEnd, excluded, transfers
  );
  await writeFile(outputPath, JSON.stringify(serializableSnapshot(snapshot), null, 2));
  console.log(`Snapshot written to ${outputPath}; ${snapshot.transfersProcessed} transfers processed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
