import "dotenv/config";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  createPublicClient, encodeFunctionData, getAddress, parseAbi,
  type Address, type Hex,
} from "viem";
import { normalizeGovernanceDraft, type GovernanceAction, type GovernanceLock } from "./governanceDraft";
import { buildGovernanceSnapshotFromTransfers } from "../governance/snapshot";
import { DEAD_ADDRESS, ZERO_ADDRESS, exclusionSet } from "../indexer/systemExclusions";
import { updateTransferCache } from "../indexer/transferCache";
import { rpcTransport } from "../shared/rpc";

const ACTIONS: Record<GovernanceAction, number> = {
  ACCUMULATE: 0,
  BUYBACK_HOLD: 1,
  BUYBACK_BURN: 2,
  BUYBACK_LOCK: 3,
  LOCK_MSTR: 4,
  MARKETING_SALE: 5,
};
const LOCKS: Record<GovernanceLock, number> = {
  "1_MONTH": 30 * 86400,
  "3_MONTHS": 90 * 86400,
  "6_MONTHS": 180 * 86400,
  "1_YEAR": 365 * 86400,
  "2_YEARS": 730 * 86400,
  "3_YEARS": 1095 * 86400,
  "5_YEARS": 1825 * 86400,
  FOREVER: 0xffffffff,
};
const governanceAbi = parseAbi([
  "function activeProposalId() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function createProposal(bytes32 weightRoot,uint128 totalAvailableWeight,uint32 votingDuration,(uint8 action,uint16 reserveBps,uint128 reserveAmount,uint32 lockDuration,address recipient)[] options) returns (uint256 proposalId)",
]);

interface ControlRequest {
  id: string;
  action: string;
  payload: unknown;
}

interface PostlaunchManifest extends Record<string, unknown> {
  projectToken: Address;
  curve: Address;
  governance: Address;
  marketingWallet: Address;
  team: Address;
  rewardVault: Address;
  reserveVault: Address;
  keeperVault: Address;
  feeRouter: Address;
  ponsFeeCollector: Address;
  restrictedExecutor: Address;
  reserveActionAdapter: Address;
  projectHoldVault: Address;
  projectTokenLockVault: Address;
}

interface DetectedLaunch {
  blockNumber: string;
  launchTimestamp: number;
}

const jsonReplacer = (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value;

async function atomicJson(path: string, value: unknown, mode: number) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, jsonReplacer, 2)}\n`, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function prepare(request: ControlRequest, controlRoot: string, publicRoot: string) {
  if (request.action !== "prepare_governance" || typeof request.id !== "string") throw new Error("WRONG_REQUEST");
  const draft = normalizeGovernanceDraft(request.payload);
  const mainLaunchRoot = resolve(controlRoot, "main-launch");
  const [manifest, detected] = await Promise.all([
    readFile(resolve(mainLaunchRoot, "postlaunch.json"), "utf8").then(JSON.parse) as Promise<PostlaunchManifest>,
    readFile(resolve(mainLaunchRoot, "detected.json"), "utf8").then(JSON.parse) as Promise<DetectedLaunch>,
  ]);

  const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const client = createPublicClient({ transport: rpcTransport(rpcUrl, process.env.ROBINHOOD_RPC_FALLBACK_URL) });
  const token = getAddress(manifest.projectToken);
  const governance = getAddress(manifest.governance);
  const team = getAddress(manifest.team);
  const marketingWallet = getAddress(manifest.marketingWallet);
  const launchBlock = BigInt(detected.blockNumber);
  const head = await client.getBlockNumber();
  const confirmations = BigInt(process.env.INDEXER_CONFIRMATIONS || "1000");
  const toBlock = head > confirmations ? head - confirmations : head;
  const block = await client.getBlock({ blockNumber: toBlock });
  const factory = getAddress(process.env.PONS_V2_FACTORY_ADDRESS || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
  const exclusions = exclusionSet([
    ...(process.env.EXCLUDED_REWARD_ADDRESSES || "").split(","),
    factory,
    manifest.curve,
    process.env.PONS_V2_MEME_HOOK_ADDRESS || "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
    process.env.UNISWAP_V4_POOL_MANAGER_ADDRESS || "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    manifest.rewardVault, manifest.reserveVault, manifest.keeperVault, manifest.feeRouter,
    manifest.ponsFeeCollector, manifest.governance, manifest.restrictedExecutor,
    manifest.reserveActionAdapter, manifest.projectHoldVault, manifest.projectTokenLockVault,
    ZERO_ADDRESS, DEAD_ADDRESS,
  ]);
  const source = (process.env.TRANSFER_SOURCE || (rpcUrl.includes("alchemy.com") ? "alchemy" : "logs")) as "alchemy" | "logs";
  const transfers = await updateTransferCache({
    client,
    rpcUrl,
    token,
    launchBlock,
    toBlock,
    cachePath: resolve(controlRoot, "..", "governance-transfer-events.json"),
    source,
    logChunkSize: BigInt(process.env.INDEXER_LOG_CHUNK_SIZE || (source === "alchemy" ? "10" : "5000")),
  });
  const snapshot = buildGovernanceSnapshotFromTransfers(
    token, launchBlock, toBlock, detected.launchTimestamp, Number(block.timestamp), exclusions, transfers,
  );
  await atomicJson(resolve(publicRoot, "governance", "latest-weights.json"), snapshot, 0o644);

  const [activeProposalId, proposalCount] = await Promise.all([
    client.readContract({ address: governance, abi: governanceAbi, functionName: "activeProposalId" }),
    client.readContract({ address: governance, abi: governanceAbi, functionName: "proposalCount" }),
  ]);
  if (activeProposalId !== 0n) throw new Error(`PROPOSAL_${activeProposalId}_IS_STILL_ACTIVE`);

  const options = draft.options.map((option) => ({
    action: ACTIONS[option.action],
    reserveBps: option.action === "ACCUMULATE" ? 0 : (option.reservePercent as number) * 100,
    reserveAmount: 0n,
    lockDuration: option.lock ? LOCKS[option.lock] : 0,
    recipient: option.action === "MARKETING_SALE" ? marketingWallet : ZERO_ADDRESS as Address,
  }));
  const expectedProposalId = proposalCount + 1n;
  const data = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [snapshot.merkleRoot, BigInt(snapshot.totalAvailableWeight), draft.durationHours * 3600, options],
  });
  const preparedAt = Date.now();
  const prepared = {
    status: "ready",
    requestId: request.id,
    chainId: 4663,
    expectedProposalId: expectedProposalId.toString(),
    from: team,
    to: governance,
    value: "0x0",
    data,
    durationHours: draft.durationHours,
    options: draft.options,
    marketingWallet,
    weightRoot: snapshot.merkleRoot,
    totalAvailableWeight: snapshot.totalAvailableWeight,
    eligibleHolders: snapshot.entries.length,
    snapshotBlock: snapshot.toBlock,
    preparedAt,
    expiresAt: preparedAt + 30 * 60_000,
  };
  await Promise.all([
    atomicJson(resolve(controlRoot, "governance-prepared.json"), prepared, 0o600),
    atomicJson(resolve(publicRoot, "governance", `proposal-${expectedProposalId}.json`), {
      ...prepared,
      weightSnapshot: snapshot,
    }, 0o644),
  ]);
  return prepared;
}

async function main() {
  const requestPath = resolve(process.argv[2] || "");
  const controlRoot = resolve(process.env.CONTROL_DATA_ROOT || "data/control");
  const publicRoot = resolve(process.env.PUBLIC_DATA_ROOT || "data/public");
  const processingRoot = resolve(controlRoot, "processing");
  if (!requestPath.startsWith(`${processingRoot}${sep}`)) throw new Error("UNSAFE_REQUEST_PATH");
  const request = JSON.parse(await readFile(requestPath, "utf8")) as ControlRequest;
  try {
    const prepared = await prepare(request, controlRoot, publicRoot);
    console.log(JSON.stringify(prepared, jsonReplacer, 2));
  } catch (error) {
    await atomicJson(resolve(controlRoot, "governance-prepared.json"), {
      status: "failed",
      requestId: request.id,
      error: error instanceof Error ? error.message : "PREPARATION_FAILED",
      failedAt: Date.now(),
    }, 0o600);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
