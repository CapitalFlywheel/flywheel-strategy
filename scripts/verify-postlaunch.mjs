import "dotenv/config";

import { readFile } from "node:fs/promises";
import { createPublicClient, getAddress, http, parseAbi } from "viem";

const rpcUrl = process.env.ROBINHOOD_RPC_URL;
if (!rpcUrl) throw new Error("ROBINHOOD_RPC_URL is required");

const deployment = JSON.parse(await readFile("deployments/mainnet-4663.json", "utf8"));
const client = createPublicClient({ transport: http(rpcUrl) });

const viewAbi = parseAbi([
  "function projectToken() view returns (address)",
  "function holdVault() view returns (address)",
  "function executor() view returns (address)",
  "function initializer() view returns (address)",
  "function mstr() view returns (address)",
  "function ponsFactory() view returns (address)",
  "function governance() view returns (address)",
  "function reserveVault() view returns (address)",
  "function actionAdapter() view returns (address)",
  "function projectHoldVault() view returns (address)",
  "function projectTokenLockVault() view returns (address)",
  "function marketingWallet() view returns (address)",
  "function MAX_SLIPPAGE_BPS() view returns (uint16)",
  "function MIN_VOTING_DURATION() view returns (uint32)",
  "function MAX_VOTING_DURATION() view returns (uint32)",
  "function EXECUTION_DELAY() view returns (uint32)",
  "function QUORUM_BPS() view returns (uint16)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)"
]);

function same(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

async function read(address, functionName, args = []) {
  return client.readContract({ address: getAddress(address), abi: viewAbi, functionName, args });
}

const contracts = [
  deployment.projectHoldVault,
  deployment.projectTokenLockVault,
  deployment.reserveActionAdapter,
  deployment.restrictedExecutor,
  deployment.governance
];

for (const address of contracts) {
  const code = await client.getCode({ address: getAddress(address) });
  if (!code || code === "0x") throw new Error(`No contract code at ${address}`);
}

same(await read(deployment.projectHoldVault, "projectToken"), deployment.projectToken, "hold vault token");

same(await read(deployment.projectTokenLockVault, "projectToken"), deployment.projectToken, "lock vault token");
same(await read(deployment.projectTokenLockVault, "holdVault"), deployment.projectHoldVault, "lock vault destination");
same(await read(deployment.projectTokenLockVault, "executor"), deployment.restrictedExecutor, "lock vault executor");

same(await read(deployment.reserveActionAdapter, "executor"), deployment.restrictedExecutor, "reserve adapter executor");
same(await read(deployment.reserveActionAdapter, "mstr"), deployment.mstr, "reserve adapter MSTR");
same(await read(deployment.reserveActionAdapter, "projectToken"), deployment.projectToken, "reserve adapter project token");
same(await read(deployment.reserveActionAdapter, "ponsFactory"), "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e", "reserve adapter PONS factory");

same(await read(deployment.restrictedExecutor, "governance"), deployment.governance, "executor governance");
same(await read(deployment.restrictedExecutor, "reserveVault"), deployment.reserveVault, "executor reserve vault");
same(await read(deployment.restrictedExecutor, "actionAdapter"), deployment.reserveActionAdapter, "executor action adapter");
same(await read(deployment.restrictedExecutor, "projectHoldVault"), deployment.projectHoldVault, "executor hold vault");
same(await read(deployment.restrictedExecutor, "projectTokenLockVault"), deployment.projectTokenLockVault, "executor lock vault");
same(await read(deployment.restrictedExecutor, "marketingWallet"), deployment.marketingWallet, "executor marketing wallet");

same(await read(deployment.governance, "executor"), deployment.restrictedExecutor, "governance executor");
const quorumBps = await read(deployment.governance, "QUORUM_BPS");
const minVotingDuration = await read(deployment.governance, "MIN_VOTING_DURATION");
const maxVotingDuration = await read(deployment.governance, "MAX_VOTING_DURATION");
const executionDelay = await read(deployment.governance, "EXECUTION_DELAY");
const maxSlippageBps = await read(deployment.restrictedExecutor, "MAX_SLIPPAGE_BPS");

if (quorumBps !== 700) throw new Error("Wrong quorum");
if (minVotingDuration !== 3_600) throw new Error("Wrong minimum voting duration");
if (maxVotingDuration !== 43_200) throw new Error("Wrong maximum voting duration");
if (executionDelay !== 300) throw new Error("Wrong execution delay");
if (maxSlippageBps !== 2_000) throw new Error("Wrong maximum slippage");

const proposerRole = await read(deployment.governance, "PROPOSER_ROLE");
const adminRole = await read(deployment.governance, "DEFAULT_ADMIN_ROLE");
if (!(await read(deployment.governance, "hasRole", [proposerRole, getAddress(deployment.team)]))) {
  throw new Error("Team does not have proposal role");
}
if (!(await read(deployment.governance, "hasRole", [adminRole, getAddress(deployment.finalAdmin)]))) {
  throw new Error("Final admin does not control governance admin role");
}

const executorRole = await read(deployment.reserveVault, "EXECUTOR_ROLE");
if (!(await read(deployment.reserveVault, "hasRole", [executorRole, getAddress(deployment.restrictedExecutor)]))) {
  throw new Error("Restricted executor cannot control reserve vault");
}
if (await read(deployment.reserveVault, "hasRole", [executorRole, getAddress(deployment.deployer)])) {
  throw new Error("Deployer still has direct reserve executor access");
}

console.log(JSON.stringify({
  ok: true,
  blockNumber: (await client.getBlockNumber()).toString(),
  projectToken: getAddress(deployment.projectToken),
  governance: getAddress(deployment.governance),
  restrictedExecutor: getAddress(deployment.restrictedExecutor),
  marketingWallet: getAddress(deployment.marketingWallet),
  quorumPercent: Number(quorumBps) / 100,
  votingHours: [Number(minVotingDuration) / 3600, Number(maxVotingDuration) / 3600],
  executionDelayMinutes: Number(executionDelay) / 60,
  maxSlippagePercent: Number(maxSlippageBps) / 100,
  reserveDirectOwnerAccessRemoved: true
}, null, 2));
