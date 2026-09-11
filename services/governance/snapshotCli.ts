import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createPublicClient, getAddress } from "viem";
import { buildGovernanceSnapshotFromTransfers } from "./snapshot";
import { DEAD_ADDRESS, ZERO_ADDRESS, exclusionSet, readPonsCurve } from "../indexer/systemExclusions";
import { updateTransferCache } from "../indexer/transferCache";
import { rpcTransport } from "../shared/rpc";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const output = process.env.GOVERNANCE_SNAPSHOT_OUTPUT || "data/public/governance/latest-weights.json";
  const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const client = createPublicClient({
    transport: rpcTransport(rpcUrl, process.env.ROBINHOOD_RPC_FALLBACK_URL),
  });
  const token = getAddress(required("PROJECT_TOKEN_ADDRESS"));
  const launchBlock = BigInt(required("PROJECT_LAUNCH_BLOCK"));
  const launchTimestamp = Number(required("PROJECT_LAUNCH_TIMESTAMP"));
  const factory = getAddress(process.env.PONS_V2_FACTORY_ADDRESS || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
  const curve = await readPonsCurve(client, factory, token);
  const exclusions = exclusionSet([
    ...(process.env.EXCLUDED_REWARD_ADDRESSES || "").split(","),
    factory,
    curve,
    process.env.PONS_V2_MEME_HOOK_ADDRESS || "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
    process.env.UNISWAP_V4_POOL_MANAGER_ADDRESS || "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    process.env.REWARD_VAULT_ADDRESS,
    process.env.RESERVE_VAULT_ADDRESS,
    process.env.KEEPER_VAULT_ADDRESS,
    process.env.FEE_ROUTER_ADDRESS,
    process.env.PONS_FEE_COLLECTOR_ADDRESS,
    process.env.GOVERNANCE_ADDRESS,
    process.env.RESTRICTED_EXECUTOR_ADDRESS,
    process.env.RESERVE_ACTION_ADAPTER_ADDRESS,
    process.env.PROJECT_HOLD_VAULT_ADDRESS,
    process.env.PROJECT_TOKEN_LOCK_VAULT_ADDRESS,
    ZERO_ADDRESS,
    DEAD_ADDRESS,
  ]);
  const head = await client.getBlockNumber();
  const confirmations = BigInt(process.env.INDEXER_CONFIRMATIONS || "1000");
  const toBlock = head > confirmations ? head - confirmations : head;
  const block = await client.getBlock({ blockNumber: toBlock });
  const source = (process.env.TRANSFER_SOURCE || (rpcUrl.includes("alchemy.com") ? "alchemy" : "logs")) as "alchemy" | "logs";
  const transfers = await updateTransferCache({
    client,
    rpcUrl,
    token,
    launchBlock,
    toBlock,
    cachePath: process.env.GOVERNANCE_TRANSFER_CACHE_PATH || "data/governance-transfer-events.json",
    source,
    logChunkSize: BigInt(process.env.INDEXER_LOG_CHUNK_SIZE || (source === "alchemy" ? "10" : "5000")),
  });
  const snapshot = buildGovernanceSnapshotFromTransfers(
    token,
    launchBlock,
    toBlock,
    launchTimestamp,
    Number(block.timestamp),
    exclusions,
    transfers
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(snapshot, null, 2));
  console.log(`Governance weights written to ${output}`);
  console.log(`Root: ${snapshot.merkleRoot}; holders: ${snapshot.entries.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
