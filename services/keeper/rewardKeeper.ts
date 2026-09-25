import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { bestQuote, quoteMstrRoutes } from "../automation/mstrQuotes";
import { reimburseGas } from "./reimburse";
import { writeHeartbeat } from "./heartbeat";
import { rpcTransport, transactionRpcTransport } from "../shared/rpc";

const collectorAbi = parseAbi([
  "function feeEscrow() view returns (address)",
  "function collect() returns (uint256 amount)",
  "function sweepCurveAndCollect(address curve) returns (uint256 amount)",
]);
const escrowAbi = parseAbi(["function balanceOf(address recipient) view returns (uint256)"]);
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
]);
const curveAbi = parseAbi([
  "function graduated() view returns (bool)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
]);
const feeRouterAbi = parseAbi([
  "function unallocatedEth() view returns (uint256)",
  "function pendingRewardEth() view returns (uint256)",
  "function pendingReserveEth() view returns (uint256)",
  "function allocate()",
  "function buyRewardMstrWithAdapter(address adapter,uint256 ethAmount,uint256 minMstrOut) returns (uint256)",
  "function buyReserveMstrWithAdapter(address adapter,uint256 ethAmount,uint256 minMstrOut) returns (uint256)",
]);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const network = JSON.parse(readFileSync("config/robinhood-mainnet.json", "utf8"));
const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ROBINHOOD_RPC_URL || network.rpcUrl] } },
});
const account = privateKeyToAccount(required("KEEPER_PRIVATE_KEY") as Hex, { nonceManager });
const expectedAutomation = getAddress(required("AUTOMATION_ADDRESS"));
if (getAddress(account.address) !== expectedAutomation) {
  throw new Error("KEEPER_PRIVATE_KEY_DOES_NOT_MATCH_AUTOMATION_ADDRESS");
}
const transport = rpcTransport(chain.rpcUrls.default.http[0], process.env.ROBINHOOD_RPC_FALLBACK_URL);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({
  chain,
  transport: transactionRpcTransport(chain.rpcUrls.default.http[0]),
  account,
});
const collector = required("PONS_FEE_COLLECTOR_ADDRESS") as Address;
const feeRouter = required("FEE_ROUTER_ADDRESS") as Address;
const projectToken = required("PROJECT_TOKEN_ADDRESS") as Address;
const ponsFactory = (process.env.PONS_V2_FACTORY_ADDRESS || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e") as Address;
const keeperVault = process.env.KEEPER_VAULT_ADDRESS as Address | undefined;
const adapters = {
  V4_WETH_USDG_MSTR: required("V4_MSTR_ADAPTER_ADDRESS") as Address,
  V3_WETH_MSTR: required("V3_MSTR_ADAPTER_ADDRESS") as Address,
};
const quoteConfig = {
  weth: network.assets.WETH as Address,
  usdg: network.assets.USDG as Address,
  mstr: network.assets.MSTR as Address,
  v4Quoter: network.uniswap.v4Quoter as Address,
  v3Quoter: network.uniswap.v3Quoter as Address,
};
const MAX_CHUNK = 10n * 10n ** 18n;

async function submit(address: Address, abi: typeof collectorAbi | typeof feeRouterAbi, functionName: string, args: readonly unknown[] = []) {
  const simulation = await publicClient.simulateContract({
    account,
    address,
    abi,
    functionName: functionName as never,
    args: args as never,
  });
  const hash = await walletClient.writeContract(simulation.request);
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${functionName}: ${hash}`);
  try {
    const reimbursement = await reimburseGas(publicClient, walletClient, account, keeperVault, hash);
    if (reimbursement) console.log(`reimbursed ${hash}: ${reimbursement}`);
  } catch (error) {
    console.error(`reimbursement failed for ${hash}`, error);
  }
}

async function buy(bucket: "reward" | "reserve", pending: bigint) {
  if (pending === 0n) return;
  const amount = pending > MAX_CHUNK ? MAX_CHUNK : pending;
  const quote = bestQuote(await quoteMstrRoutes(publicClient, quoteConfig, amount));
  const functionName = bucket === "reward"
    ? "buyRewardMstrWithAdapter"
    : "buyReserveMstrWithAdapter";
  await submit(feeRouter, feeRouterAbi, functionName, [adapters[quote.route], amount, quote.minimumOut]);
}

async function collectPonsFees() {
  const escrow = await publicClient.readContract({
    address: collector,
    abi: collectorAbi,
    functionName: "feeEscrow",
  });
  const launch = await publicClient.readContract({
    address: ponsFactory,
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    args: [projectToken],
  });
  if (!launch.exists) throw new Error("PROJECT_TOKEN_IS_NOT_A_PONS_V2_LAUNCH");

  const [graduated, pendingCurveFee, pendingCurveTax] = await Promise.all([
    publicClient.readContract({ address: launch.curve, abi: curveAbi, functionName: "graduated" }),
    publicClient.readContract({ address: launch.curve, abi: curveAbi, functionName: "quoteFeeBalance" }),
    publicClient.readContract({ address: launch.curve, abi: curveAbi, functionName: "creatorTaxBalance" }),
  ]);
  if (!graduated && pendingCurveFee + pendingCurveTax > 0n) {
    await submit(collector, collectorAbi, "sweepCurveAndCollect", [launch.curve]);
    return;
  }

  const claimable = await publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "balanceOf",
    args: [collector],
  });
  if (claimable > 0n) await submit(collector, collectorAbi, "collect");
}

async function runCycle() {
  await collectPonsFees();

  const unallocated = await publicClient.readContract({
    address: feeRouter,
    abi: feeRouterAbi,
    functionName: "unallocatedEth",
  });
  if (unallocated > 0n) await submit(feeRouter, feeRouterAbi, "allocate");

  const [reward, reserve] = await Promise.all([
    publicClient.readContract({ address: feeRouter, abi: feeRouterAbi, functionName: "pendingRewardEth" }),
    publicClient.readContract({ address: feeRouter, abi: feeRouterAbi, functionName: "pendingReserveEth" }),
  ]);
  await buy("reward", reward);
  await buy("reserve", reserve);
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    await runCycle();
    await writeHeartbeat("reward-keeper", true, { account: account.address });
  } catch (error) {
    console.error(new Date().toISOString(), error);
    await writeHeartbeat("reward-keeper", false, {
      account: account.address,
      error: error instanceof Error ? error.message : "unknown error",
    }).catch(() => undefined);
    if (process.env.KEEPER_RUN_ONCE === "true") throw error;
  } finally {
    running = false;
  }
}

console.log(`Reward keeper started as ${account.address}`);
void tick();
if (process.env.KEEPER_RUN_ONCE !== "true") {
  setInterval(() => void tick(), 30_000);
}
