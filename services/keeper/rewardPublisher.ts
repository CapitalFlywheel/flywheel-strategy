import "dotenv/config";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { buildWeightSnapshotFromTransfers } from "../indexer/chainSnapshot";
import { buildDistribution } from "../indexer/distribution";
import { RewardCadenceTracker, type CadenceState } from "../indexer/rewardCadence";
import { readMarketCapUsd, type MarketCapReading } from "../automation/marketCap";
import { reimburseGas } from "./reimburse";
import { DEAD_ADDRESS, ZERO_ADDRESS, exclusionSet } from "../indexer/systemExclusions";
import { writeHeartbeat } from "./heartbeat";
import { updateTransferCache } from "../indexer/transferCache";
import { alchemyRpcUrl, rpcTransport, transactionRpcTransport } from "../shared/rpc";

interface PublisherState {
  latestEpoch: number;
  lastWindowEnd: number;
  cumulativeRewards: Record<string, string>;
  cadence?: CadenceState;
  latestMarketCap?: MarketCapReading;
}

interface AutoPayoutEntry {
  account: Address;
  amountRaw: string;
}

interface AutomaticSnapshot {
  epoch: number;
  merkleRoot: Hex;
  mstrRewardRaw: string;
  distributor: Address;
  distributorCumulativeClaimRaw: string;
  allocationHash: Hex;
  payoutEntries: AutoPayoutEntry[];
  batchSize: number;
}

const rewardVaultAbi = parseAbi([
  "function latestEpoch() view returns (uint64)",
  "function merkleRoot() view returns (bytes32)",
  "function cumulativeAllocated() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function mstr() view returns (address)",
  "function claimed(address account) view returns (uint256)",
  "function publishDistribution(uint64 epoch,bytes32 newRoot,uint256 newCumulativeAllocated)",
]);
const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const autoDistributorAbi = parseAbi([
  "function latestFundedEpoch() view returns (uint64)",
  "function epochs(uint64 epoch) view returns (uint256 funded,uint256 distributed,bytes32 allocationHash,bool finalized)",
  "function batchProcessed(uint64 epoch,uint32 batchId) view returns (bool)",
  "function fundEpoch(uint64 epoch,uint256 cumulativeClaim,bytes32[] proof,uint256 expectedAmount,bytes32 allocationHash)",
  "function distributeBatch(uint64 epoch,uint32 batchId,address[] recipients,uint256[] amounts)",
  "function finalizeEpoch(uint64 epoch)",
]);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

async function updatePublicHistory(entry: {
  epoch: number;
  windowStart: number;
  windowEnd: number;
  mstrRewardRaw: string;
  merkleRoot: Hex;
  transactionHash?: Hex;
  mode?: "claim" | "automatic";
  distributor?: Address;
}) {
  const path = join(publicSnapshotDir, "history.json");
  let history: typeof entry[] = [];
  try {
    history = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  history = history.filter((item) => item.epoch !== entry.epoch);
  history.push(entry);
  history.sort((a, b) => b.epoch - a.epoch);
  await atomicJson(path, history.slice(0, 1000));
}

async function loadState(path: string, launchTimestamp: number): Promise<PublisherState> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { latestEpoch: 0, lastWindowEnd: launchTimestamp, cumulativeRewards: {} };
  }
}

const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const account = privateKeyToAccount(required("ROOT_PUBLISHER_PRIVATE_KEY") as Hex, { nonceManager });
const expectedPublisher = getAddress(required("ROOT_PUBLISHER_ADDRESS"));
if (getAddress(account.address) !== expectedPublisher) {
  throw new Error("ROOT_PUBLISHER_PRIVATE_KEY_DOES_NOT_MATCH_CONFIGURED_ADDRESS");
}
const transport = rpcTransport(rpcUrl, process.env.ROBINHOOD_RPC_FALLBACK_URL);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ chain, transport: transactionRpcTransport(rpcUrl), account });
const projectToken = getAddress(required("PROJECT_TOKEN_ADDRESS"));
const launchBlock = BigInt(required("PROJECT_LAUNCH_BLOCK"));
const launchTimestamp = Number(required("PROJECT_LAUNCH_TIMESTAMP"));
const rewardVault = getAddress(required("REWARD_VAULT_ADDRESS"));
const factory = getAddress(process.env.PONS_V2_FACTORY_ADDRESS || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
const poolManager = getAddress(process.env.UNISWAP_V4_POOL_MANAGER_ADDRESS || "0x8366a39CC670B4001A1121B8F6A443A643e40951");
const memeHook = getAddress(process.env.PONS_V2_MEME_HOOK_ADDRESS || "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044");
const usdg = getAddress(process.env.USDG_ADDRESS || "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const wethUsdgPoolId = (process.env.WETH_USDG_POOL_ID || "0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6") as Hex;
const keeperVault = process.env.KEEPER_VAULT_ADDRESS as Address | undefined;
const statePath = process.env.REWARD_STATE_PATH || "data/reward-state.json";
const publicSnapshotDir = process.env.PUBLIC_SNAPSHOT_DIR || "data/public/snapshots";
const transferCachePath = process.env.TRANSFER_CACHE_PATH || "data/transfer-events.json";
const indexerConfirmations = BigInt(process.env.INDEXER_CONFIRMATIONS || "1000");
const transferSource = (process.env.TRANSFER_SOURCE || (rpcUrl.includes("alchemy.com") ? "alchemy" : "logs")) as "alchemy" | "logs";
const transferRpcUrl = transferSource === "alchemy"
  ? alchemyRpcUrl(rpcUrl, process.env.ROBINHOOD_RPC_FALLBACK_URL)
  : rpcUrl;
const logChunkSize = BigInt(process.env.INDEXER_LOG_CHUNK_SIZE || (transferSource === "alchemy" ? "10" : "5000"));
const configuredExclusions = (process.env.EXCLUDED_REWARD_ADDRESSES || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const autoDistributor = process.env.AUTO_REWARD_DISTRIBUTOR_ADDRESS
  ? getAddress(process.env.AUTO_REWARD_DISTRIBUTOR_ADDRESS)
  : undefined;
const autoBatchSize = Math.min(100, Math.max(1, Number(process.env.AUTO_REWARD_BATCH_SIZE || "60")));
let running = false;

async function submitAutomatic(
  functionName: "fundEpoch" | "distributeBatch" | "finalizeEpoch",
  args: readonly unknown[]
): Promise<Hex> {
  if (!autoDistributor) throw new Error("AUTO_REWARD_DISTRIBUTOR_ADDRESS_IS_REQUIRED");
  const { request } = await publicClient.simulateContract({
    account,
    address: autoDistributor,
    abi: autoDistributorAbi,
    functionName,
    args: args as never,
  });
  const hash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });
  try {
    await reimburseGas(publicClient, walletClient, account, keeperVault, hash);
  } catch (error) {
    console.error(`Automatic reward reimbursement failed for ${hash}`, error);
  }
  return hash;
}

async function settleAutomaticPayout(snapshot: AutomaticSnapshot) {
  if (!autoDistributor || getAddress(snapshot.distributor) !== autoDistributor) {
    throw new Error("AUTOMATIC_SNAPSHOT_DISTRIBUTOR_MISMATCH");
  }
  const expectedAmount = BigInt(snapshot.mstrRewardRaw);
  let payout = await publicClient.readContract({
    address: autoDistributor,
    abi: autoDistributorAbi,
    functionName: "epochs",
    args: [BigInt(snapshot.epoch)],
  });
  if (payout[0] === 0n) {
    const tree = StandardMerkleTree.of<[string, string]>(
      [[autoDistributor, snapshot.distributorCumulativeClaimRaw]],
      ["address", "uint256"]
    );
    if (tree.root.toLowerCase() !== snapshot.merkleRoot.toLowerCase()) {
      throw new Error("AUTOMATIC_DISTRIBUTOR_ROOT_MISMATCH");
    }
    await submitAutomatic("fundEpoch", [
      BigInt(snapshot.epoch),
      BigInt(snapshot.distributorCumulativeClaimRaw),
      tree.getProof(0),
      expectedAmount,
      snapshot.allocationHash,
    ]);
    payout = await publicClient.readContract({
      address: autoDistributor,
      abi: autoDistributorAbi,
      functionName: "epochs",
      args: [BigInt(snapshot.epoch)],
    });
  }
  if (payout[0] !== expectedAmount || payout[2].toLowerCase() !== snapshot.allocationHash.toLowerCase()) {
    throw new Error("AUTOMATIC_EPOCH_FUNDING_MISMATCH");
  }

  const snapshotBatchSize = Math.min(100, Math.max(1, Number(snapshot.batchSize || autoBatchSize)));
  for (let offset = 0, batchId = 0; offset < snapshot.payoutEntries.length; offset += snapshotBatchSize, batchId += 1) {
    const alreadyProcessed = await publicClient.readContract({
      address: autoDistributor,
      abi: autoDistributorAbi,
      functionName: "batchProcessed",
      args: [BigInt(snapshot.epoch), batchId],
    });
    if (alreadyProcessed) continue;
    const batch = snapshot.payoutEntries.slice(offset, offset + snapshotBatchSize);
    await submitAutomatic("distributeBatch", [
      BigInt(snapshot.epoch),
      batchId,
      batch.map((entry) => entry.account),
      batch.map((entry) => BigInt(entry.amountRaw)),
    ]);
  }

  payout = await publicClient.readContract({
    address: autoDistributor,
    abi: autoDistributorAbi,
    functionName: "epochs",
    args: [BigInt(snapshot.epoch)],
  });
  if (payout[1] !== expectedAmount) throw new Error("AUTOMATIC_EPOCH_NOT_FULLY_DISTRIBUTED");
  if (!payout[3]) await submitAutomatic("finalizeEpoch", [BigInt(snapshot.epoch)]);
}

async function publishOneEpoch() {
  let state = await loadState(statePath, launchTimestamp);
  const [latestBlockNumber, onchainEpoch, onchainRoot, onchainAllocated, totalClaimed, mstr] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "latestEpoch" }),
    publicClient.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "merkleRoot" }),
    publicClient.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "cumulativeAllocated" }),
    publicClient.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "totalClaimed" }),
    publicClient.readContract({ address: rewardVault, abi: rewardVaultAbi, functionName: "mstr" }),
  ]);
  if (Number(onchainEpoch) === state.latestEpoch + 1) {
    const recoveryPath = join(publicSnapshotDir, `epoch-${onchainEpoch}.json`);
    const recovery = JSON.parse(await readFile(recoveryPath, "utf8"));
    if (recovery.merkleRoot.toLowerCase() !== onchainRoot.toLowerCase()) {
      throw new Error("RECOVERY_SNAPSHOT_ROOT_MISMATCH");
    }
    if (recovery.mode === "automatic") {
      await settleAutomaticPayout(recovery as AutomaticSnapshot);
    }
    state = {
      ...state,
      latestEpoch: Number(onchainEpoch),
      lastWindowEnd: recovery.windowEnd,
      cumulativeRewards: Object.fromEntries(
        recovery.entries.map((entry: { account: string; cumulativeRewardRaw: string }) => [
          entry.account,
          entry.cumulativeRewardRaw,
        ])
      ),
    };
    await atomicJson(statePath, state);
    const recoveredPublished = {
      ...recovery,
      status: recovery.mode === "automatic" ? "airdropped-recovered" : "published-recovered",
    };
    await atomicJson(recoveryPath, recoveredPublished);
    await atomicJson(join(publicSnapshotDir, "latest.json"), recoveredPublished);
    await updatePublicHistory({
      epoch: Number(onchainEpoch),
      windowStart: recovery.windowStart,
      windowEnd: recovery.windowEnd,
      mstrRewardRaw: recovery.mstrRewardRaw,
      merkleRoot: recovery.merkleRoot,
      transactionHash: recovery.transactionHash,
      mode: recovery.mode || "claim",
      distributor: recovery.distributor,
    });
  }
  if (Number(onchainEpoch) !== state.latestEpoch) {
    throw new Error("PUBLISHER_STATE_DOES_NOT_MATCH_CHAIN");
  }

  const indexedBlockNumber = latestBlockNumber > indexerConfirmations
    ? latestBlockNumber - indexerConfirmations
    : latestBlockNumber;
  const indexedBlock = await publicClient.getBlock({ blockNumber: indexedBlockNumber });
  const windowEnd = Number(indexedBlock.timestamp);
  const marketCap = await readMarketCapUsd(publicClient, {
    factory,
    poolManager,
    memeHook,
    usdg,
    wethUsdgPoolId,
    projectToken,
  });
  const cadenceTracker = new RewardCadenceTracker(state.cadence);
  const cadence = cadenceTracker.update(marketCap.timestamp, marketCap.marketCapUsd);
  const intervalSeconds = cadenceTracker.currentIntervalSeconds();
  state = { ...state, cadence, latestMarketCap: marketCap };
  await atomicJson(statePath, state);
  await atomicJson(join(publicSnapshotDir, "market-status.json"), {
    ...marketCap,
    intervalSeconds,
    cadence,
  });
  if (windowEnd < state.lastWindowEnd + intervalSeconds) return;

  const mstrBalance = await publicClient.readContract({
    address: mstr,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [rewardVault],
  });
  const newReward = mstrBalance + totalClaimed - onchainAllocated;
  if (newReward === 0n) return;

  const exclusions = exclusionSet([
    ...configuredExclusions,
    rewardVault,
    factory,
    poolManager,
    memeHook,
    marketCap.curve,
    process.env.FEE_ROUTER_ADDRESS,
    process.env.PONS_FEE_COLLECTOR_ADDRESS,
    process.env.RESERVE_VAULT_ADDRESS,
    process.env.KEEPER_VAULT_ADDRESS,
    process.env.GOVERNANCE_ADDRESS,
    process.env.RESTRICTED_EXECUTOR_ADDRESS,
    process.env.RESERVE_ACTION_ADAPTER_ADDRESS,
    process.env.PROJECT_HOLD_VAULT_ADDRESS,
    process.env.PROJECT_TOKEN_LOCK_VAULT_ADDRESS,
    process.env.V4_MSTR_ADAPTER_ADDRESS,
    process.env.V3_MSTR_ADAPTER_ADDRESS,
    autoDistributor,
    ZERO_ADDRESS,
    DEAD_ADDRESS,
  ]);
  const transferEvents = await updateTransferCache({
    client: publicClient,
    rpcUrl: transferRpcUrl,
    token: projectToken,
    launchBlock,
    toBlock: indexedBlockNumber,
    cachePath: transferCachePath,
    source: transferSource,
    logChunkSize,
  });
  const weightSnapshot = buildWeightSnapshotFromTransfers(
    projectToken,
    launchBlock,
    indexedBlockNumber,
    state.lastWindowEnd,
    windowEnd,
    exclusions,
    transferEvents
  );
  const previous = new Map(
    Object.entries(state.cumulativeRewards).map(([address, amount]) => [address, BigInt(amount)])
  );
  const distribution = buildDistribution(weightSnapshot.weights, newReward, previous);
  const nextEpoch = state.latestEpoch + 1;
  const newCumulativeAllocated = onchainAllocated + newReward;
  const payoutEntries: AutoPayoutEntry[] = distribution.entries
    .filter((entry) => entry.epochReward > 0n)
    .map((entry) => ({ account: getAddress(entry.account), amountRaw: entry.epochReward.toString() }));
  const allocationHash = keccak256(toHex(JSON.stringify(payoutEntries)));
  let publishedRoot = distribution.merkleRoot as Hex;
  let distributorCumulativeClaim: bigint | undefined;
  if (autoDistributor) {
    const alreadyClaimed = await publicClient.readContract({
      address: rewardVault,
      abi: rewardVaultAbi,
      functionName: "claimed",
      args: [autoDistributor],
    });
    distributorCumulativeClaim = alreadyClaimed + newReward;
    publishedRoot = StandardMerkleTree.of<[string, string]>(
      [[autoDistributor, distributorCumulativeClaim.toString()]],
      ["address", "uint256"]
    ).root as Hex;
  }
  const snapshotPath = join(publicSnapshotDir, `epoch-${nextEpoch}.json`);
  const snapshot = {
    status: "prepared",
    mode: autoDistributor ? "automatic" : "claim",
    chainId: 4663,
    epoch: nextEpoch,
    projectToken,
    rewardVault,
    fromBlock: launchBlock.toString(),
    toBlock: indexedBlockNumber.toString(),
    windowStart: state.lastWindowEnd,
    windowEnd,
    transfersProcessed: weightSnapshot.transfersProcessed,
    mstrRewardRaw: newReward.toString(),
    cumulativeAllocatedRaw: newCumulativeAllocated.toString(),
    totalWeight: distribution.totalWeight.toString(),
    merkleRoot: publishedRoot,
    allocationMerkleRoot: distribution.merkleRoot,
    allocationHash,
    ...(autoDistributor && distributorCumulativeClaim !== undefined ? {
      distributor: autoDistributor,
      distributorCumulativeClaimRaw: distributorCumulativeClaim.toString(),
      payoutEntries,
      batchSize: autoBatchSize,
    } : {}),
    entries: distribution.entries.map((entry) => ({
      account: entry.account,
      weight: entry.weight.toString(),
      epochRewardRaw: entry.epochReward.toString(),
      cumulativeRewardRaw: entry.cumulativeReward.toString(),
      proof: entry.proof,
    })),
    tree: distribution.treeDump,
  };
  await atomicJson(snapshotPath, snapshot);

  const { request } = await publicClient.simulateContract({
    account,
    address: rewardVault,
    abi: rewardVaultAbi,
    functionName: "publishDistribution",
    args: [BigInt(nextEpoch), publishedRoot, newCumulativeAllocated],
  });
  const hash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });
  try {
    const reimbursement = await reimburseGas(publicClient, walletClient, account, keeperVault, hash);
    if (reimbursement) console.log(`Reimbursed reward epoch ${nextEpoch}: ${reimbursement}`);
  } catch (error) {
    console.error(`Reward publisher reimbursement failed for ${hash}`, error);
  }

  const publishedSnapshot = { ...snapshot, status: "published", transactionHash: hash };
  await atomicJson(snapshotPath, publishedSnapshot);
  if (autoDistributor) {
    await settleAutomaticPayout(publishedSnapshot as AutomaticSnapshot);
  }
  const completedSnapshot = {
    ...publishedSnapshot,
    status: autoDistributor ? "airdropped" : "published",
  };
  await atomicJson(snapshotPath, completedSnapshot);
  await atomicJson(join(publicSnapshotDir, "latest.json"), {
    ...snapshot,
    status: completedSnapshot.status,
    transactionHash: hash,
  });
  await updatePublicHistory({
    epoch: nextEpoch,
    windowStart: state.lastWindowEnd,
    windowEnd,
    mstrRewardRaw: newReward.toString(),
    merkleRoot: publishedRoot,
    transactionHash: hash,
    mode: autoDistributor ? "automatic" : "claim",
    distributor: autoDistributor,
  });
  await atomicJson(statePath, {
    latestEpoch: nextEpoch,
    lastWindowEnd: windowEnd,
    cadence,
    latestMarketCap: marketCap,
    cumulativeRewards: Object.fromEntries(
      distribution.entries.map((entry) => [entry.account, entry.cumulativeReward.toString()])
    ),
  } satisfies PublisherState);
  console.log(`Published reward epoch ${nextEpoch}: ${hash}`);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await publishOneEpoch();
    await writeHeartbeat("reward-publisher", true, { account: account.address, rewardVault });
  } catch (error) {
    console.error(new Date().toISOString(), error);
    await writeHeartbeat("reward-publisher", false, {
      account: account.address,
      rewardVault,
      error: error instanceof Error ? error.message : "unknown error",
    }).catch(() => undefined);
    if (process.env.PUBLISHER_RUN_ONCE === "true") throw error;
  } finally {
    running = false;
  }
}

console.log(`Reward publisher started for ${rewardVault} as ${account.address}`);
void tick();
if (process.env.PUBLISHER_RUN_ONCE !== "true") {
  setInterval(() => void tick(), 30_000);
}
