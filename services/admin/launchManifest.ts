import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  toBytes,
  type Address,
} from "viem";

export const PONS_FACTORY = getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const PUBLIC_ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";

const addressKeys = [
  "owner", "automation", "rootPublisher", "mstr", "weth", "usdg", "universalRouter", "feeEscrow",
  "rewardVault", "reserveVault", "keeperVault", "v4MstrAdapter", "v3MstrAdapter", "feeRouter",
  "ponsFeeCollector",
] as const;
const postAddressKeys = [
  "projectToken", "curve", "marketingWallet", "team", "finalAdmin", "projectHoldVault",
  "projectTokenLockVault", "reserveActionAdapter", "restrictedExecutor", "governance",
] as const;

export interface PrelaunchManifest extends Record<string, unknown> {
  version: 1;
  chainId: 4663;
  owner: Address;
  automation: Address;
  rootPublisher: Address;
  mstr: Address;
  weth: Address;
  usdg: Address;
  universalRouter: Address;
  feeEscrow: Address;
  rewardVault: Address;
  reserveVault: Address;
  keeperVault: Address;
  v4MstrAdapter: Address;
  v3MstrAdapter: Address;
  feeRouter: Address;
  ponsFeeCollector: Address;
}

export interface PostlaunchManifest extends PrelaunchManifest {
  projectToken: Address;
  curve: Address;
  marketingWallet: Address;
  team: Address;
  finalAdmin: Address;
  projectHoldVault: Address;
  projectTokenLockVault: Address;
  reserveActionAdapter: Address;
  restrictedExecutor: Address;
  governance: Address;
}

const accessAbi = [{
  type: "function", name: "hasRole", stateMutability: "view",
  inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;
const getter = (name: string) => [{
  type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }],
}] as const;
const boolGetter = (name: string) => [{
  type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }],
}] as const;
const ponsAbi = [{
  type: "function", name: "getLaunchedToken", stateMutability: "view",
  inputs: [{ name: "token", type: "address" }],
  outputs: [{
    name: "", type: "tuple", components: [
      { name: "token", type: "address" }, { name: "curve", type: "address" },
      { name: "deployer", type: "address" }, { name: "creatorFeeRecipient", type: "address" },
      { name: "pairToken", type: "address" }, { name: "graduationThreshold", type: "uint256" },
      { name: "poolFee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
      { name: "creatorTaxBps", type: "uint16" }, { name: "buybackEnabled", type: "bool" },
      { name: "phase", type: "uint8" }, { name: "sweptQuote", type: "uint256" },
      { name: "sweptTokens", type: "uint256" }, { name: "sweptAt", type: "uint256" },
      { name: "exists", type: "bool" },
    ],
  }],
}] as const;

const client = createPublicClient({ transport: http(PUBLIC_ROBINHOOD_RPC, { timeout: 12_000, retryCount: 2 }) });
const role = (name: string) => keccak256(toBytes(name));
const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}` as const;

function fail(message: string): never {
  throw new Error(`MANIFEST_${message}`);
}

function normalizeBase(payload: unknown): PrelaunchManifest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("INVALID");
  const source = payload as Record<string, unknown>;
  if (source.version !== 1 || source.chainId !== 4663) fail("WRONG_NETWORK");
  const result: Record<string, unknown> = { version: 1, chainId: 4663 };
  for (const key of addressKeys) {
    if (typeof source[key] !== "string") fail(`MISSING_${key.toUpperCase()}`);
    try { result[key] = getAddress(source[key] as string); } catch { fail(`BAD_${key.toUpperCase()}`); }
  }
  return result as PrelaunchManifest;
}

export function normalizePrelaunchManifest(payload: unknown, expectedOwner: Address): PrelaunchManifest {
  const result = normalizeBase(payload);
  if (result.owner.toLowerCase() !== expectedOwner.toLowerCase()) fail("WRONG_OWNER");
  return result;
}

export function normalizePostlaunchManifest(payload: unknown, expectedOwner: Address): PostlaunchManifest {
  const base = normalizePrelaunchManifest(payload, expectedOwner);
  const source = payload as Record<string, unknown>;
  const result: Record<string, unknown> = { ...base };
  for (const key of postAddressKeys) {
    if (typeof source[key] !== "string") fail(`MISSING_${key.toUpperCase()}`);
    try { result[key] = getAddress(source[key] as string); } catch { fail(`BAD_${key.toUpperCase()}`); }
  }
  if ((result.finalAdmin as Address).toLowerCase() !== expectedOwner.toLowerCase()) fail("WRONG_FINAL_ADMIN");
  return result as PostlaunchManifest;
}

async function expectCode(address: Address, label: string) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") fail(`NO_CODE_${label}`);
}

async function readAddress(address: Address, name: string): Promise<Address> {
  return getAddress(await client.readContract({ address, abi: getter(name), functionName: name }));
}

async function expectAddress(address: Address, name: string, expected: Address, label: string) {
  const actual = await readAddress(address, name);
  if (actual.toLowerCase() !== expected.toLowerCase()) fail(`WRONG_${label}`);
}

async function expectRole(address: Address, roleHash: `0x${string}`, account: Address, expected: boolean, label: string) {
  const actual = await client.readContract({ address, abi: accessAbi, functionName: "hasRole", args: [roleHash, account] });
  if (actual !== expected) fail(`WRONG_ROLE_${label}`);
}

export async function verifyPrelaunchManifest(manifest: PrelaunchManifest, options: { finalized?: boolean } = {}): Promise<void> {
  await Promise.all([
    expectCode(manifest.rewardVault, "REWARD_VAULT"), expectCode(manifest.reserveVault, "RESERVE_VAULT"),
    expectCode(manifest.keeperVault, "KEEPER_VAULT"), expectCode(manifest.v4MstrAdapter, "V4_ADAPTER"),
    expectCode(manifest.v3MstrAdapter, "V3_ADAPTER"), expectCode(manifest.feeRouter, "FEE_ROUTER"),
    expectCode(manifest.ponsFeeCollector, "FEE_COLLECTOR"),
  ]);
  await Promise.all([
    expectAddress(manifest.rewardVault, "mstr", manifest.mstr, "REWARD_MSTR"),
    expectAddress(manifest.reserveVault, "mstr", manifest.mstr, "RESERVE_MSTR"),
    expectAddress(manifest.v4MstrAdapter, "mstr", manifest.mstr, "V4_MSTR"),
    expectAddress(manifest.v4MstrAdapter, "weth", manifest.weth, "V4_WETH"),
    expectAddress(manifest.v4MstrAdapter, "usdg", manifest.usdg, "V4_USDG"),
    expectAddress(manifest.v4MstrAdapter, "universalRouter", manifest.universalRouter, "V4_ROUTER"),
    expectAddress(manifest.v3MstrAdapter, "mstr", manifest.mstr, "V3_MSTR"),
    expectAddress(manifest.v3MstrAdapter, "weth", manifest.weth, "V3_WETH"),
    expectAddress(manifest.v3MstrAdapter, "universalRouter", manifest.universalRouter, "V3_ROUTER"),
    expectAddress(manifest.feeRouter, "rewardVault", manifest.rewardVault, "ROUTER_REWARD"),
    expectAddress(manifest.feeRouter, "reserveVault", manifest.reserveVault, "ROUTER_RESERVE"),
    expectAddress(manifest.feeRouter, "keeperVault", manifest.keeperVault, "ROUTER_KEEPER"),
    expectAddress(manifest.feeRouter, "swapAdapter", manifest.v4MstrAdapter, "ROUTER_ADAPTER"),
    expectAddress(manifest.ponsFeeCollector, "feeEscrow", manifest.feeEscrow, "COLLECTOR_ESCROW"),
    expectAddress(manifest.ponsFeeCollector, "feeRouter", manifest.feeRouter, "COLLECTOR_ROUTER"),
    expectRole(manifest.rewardVault, DEFAULT_ADMIN_ROLE, manifest.owner, true, "REWARD_ADMIN"),
    expectRole(manifest.rewardVault, role("ROOT_PUBLISHER_ROLE"), manifest.rootPublisher, true, "PUBLISHER"),
    expectRole(manifest.reserveVault, DEFAULT_ADMIN_ROLE, manifest.owner, true, "RESERVE_ADMIN"),
    ...(options.finalized ? [] : [expectRole(manifest.reserveVault, role("EXECUTOR_ROLE"), manifest.owner, true, "INITIAL_EXECUTOR")]),
    expectRole(manifest.keeperVault, role("AUTOMATION_ROLE"), manifest.automation, true, "KEEPER_AUTOMATION"),
    expectRole(manifest.keeperVault, role("AUTOMATION_ROLE"), manifest.rootPublisher, true, "KEEPER_PUBLISHER"),
    expectRole(manifest.feeRouter, role("AUTOMATION_ROLE"), manifest.automation, true, "ROUTER_AUTOMATION"),
  ]);
  const fallbackAllowed = await client.readContract({
    address: manifest.feeRouter,
    abi: [{ type: "function", name: "allowedSwapAdapters", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] }],
    functionName: "allowedSwapAdapters",
    args: [manifest.v3MstrAdapter],
  });
  if (!fallbackAllowed) fail("FALLBACK_NOT_ALLOWED");
}

export async function verifyPostlaunchManifest(manifest: PostlaunchManifest): Promise<void> {
  await verifyPrelaunchManifest(manifest, { finalized: true });
  await Promise.all([
    expectCode(manifest.projectToken, "PROJECT_TOKEN"), expectCode(manifest.curve, "CURVE"),
    expectCode(manifest.projectHoldVault, "HOLD_VAULT"), expectCode(manifest.projectTokenLockVault, "LOCK_VAULT"),
    expectCode(manifest.reserveActionAdapter, "RESERVE_ADAPTER"), expectCode(manifest.restrictedExecutor, "EXECUTOR"),
    expectCode(manifest.governance, "GOVERNANCE"),
  ]);
  const launch = await client.readContract({ address: PONS_FACTORY, abi: ponsAbi, functionName: "getLaunchedToken", args: [manifest.projectToken] });
  if (!launch.exists || launch.curve.toLowerCase() !== manifest.curve.toLowerCase()) fail("WRONG_PONS_CURVE");
  if (launch.deployer.toLowerCase() !== manifest.owner.toLowerCase()) fail("WRONG_PONS_DEPLOYER");
  if (launch.creatorFeeRecipient.toLowerCase() !== manifest.ponsFeeCollector.toLowerCase()) fail("WRONG_CREATOR_WALLET");
  if (launch.pairToken.toLowerCase() !== ZERO_ADDRESS || launch.creatorTaxBps !== 200 || launch.buybackEnabled) {
    fail("WRONG_PONS_SETTINGS");
  }
  await Promise.all([
    expectAddress(manifest.projectHoldVault, "projectToken", manifest.projectToken, "HOLD_TOKEN"),
    expectAddress(manifest.projectTokenLockVault, "projectToken", manifest.projectToken, "LOCK_TOKEN"),
    expectAddress(manifest.projectTokenLockVault, "holdVault", manifest.projectHoldVault, "LOCK_HOLD_VAULT"),
    expectAddress(manifest.projectTokenLockVault, "executor", manifest.restrictedExecutor, "LOCK_EXECUTOR"),
    expectAddress(manifest.reserveActionAdapter, "mstr", manifest.mstr, "RESERVE_ADAPTER_MSTR"),
    expectAddress(manifest.reserveActionAdapter, "projectToken", manifest.projectToken, "RESERVE_ADAPTER_TOKEN"),
    expectAddress(manifest.reserveActionAdapter, "executor", manifest.restrictedExecutor, "RESERVE_ADAPTER_EXECUTOR"),
    expectAddress(manifest.restrictedExecutor, "reserveVault", manifest.reserveVault, "EXECUTOR_RESERVE"),
    expectAddress(manifest.restrictedExecutor, "actionAdapter", manifest.reserveActionAdapter, "EXECUTOR_ADAPTER"),
    expectAddress(manifest.restrictedExecutor, "marketingWallet", manifest.marketingWallet, "EXECUTOR_MARKETING"),
    expectAddress(manifest.restrictedExecutor, "governance", manifest.governance, "EXECUTOR_GOVERNANCE"),
    expectAddress(manifest.governance, "executor", manifest.restrictedExecutor, "GOVERNANCE_EXECUTOR"),
    expectRole(manifest.governance, role("PROPOSER_ROLE"), manifest.team, true, "PROPOSER"),
    expectRole(manifest.reserveVault, role("EXECUTOR_ROLE"), manifest.restrictedExecutor, true, "FINAL_EXECUTOR"),
    expectRole(manifest.reserveVault, role("EXECUTOR_ROLE"), manifest.owner, false, "OLD_EXECUTOR_REMOVED"),
  ]);
}

export async function verifyPonsDetection(manifest: PrelaunchManifest, token: Address, curve: Address) {
  const launch = await client.readContract({ address: PONS_FACTORY, abi: ponsAbi, functionName: "getLaunchedToken", args: [token] });
  return launch.exists
    && launch.curve.toLowerCase() === curve.toLowerCase()
    && launch.deployer.toLowerCase() === manifest.owner.toLowerCase()
    && launch.creatorFeeRecipient.toLowerCase() === manifest.ponsFeeCollector.toLowerCase()
    && launch.pairToken.toLowerCase() === ZERO_ADDRESS
    && launch.creatorTaxBps === 200
    && !launch.buybackEnabled;
}
