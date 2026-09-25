import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  type Address,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { reimburseGas } from "./reimburse";
import { writeHeartbeat } from "./heartbeat";
import { rpcTransport, transactionRpcTransport } from "../shared/rpc";
import { advancePonsLifecycle, type PonsLifecycleStatus } from "./ponsLifecycle";

const governanceAbi = [
  {
    type: "function",
    name: "activeProposalId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "proposals",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      { name: "startsAt", type: "uint64" },
      { name: "endsAt", type: "uint64" },
      { name: "executableAt", type: "uint64" },
      { name: "weightRoot", type: "bytes32" },
      { name: "totalAvailableWeight", type: "uint128" },
      { name: "totalCastWeight", type: "uint128" },
      { name: "optionCount", type: "uint8" },
      { name: "executed", type: "bool" },
      { name: "passed", type: "bool" },
      { name: "winningOption", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [],
  },
] as const;

const lockVaultAbi = [
  {
    type: "function",
    name: "lockCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "locks",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "amount", type: "uint128" },
      { name: "unlockAt", type: "uint64" },
      { name: "released", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [],
  },
] as const;

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"],
    },
  },
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const governance = required("GOVERNANCE_ADDRESS") as Address;
const projectToken = required("PROJECT_TOKEN_ADDRESS") as Address;
const projectTokenLockVault = required("PROJECT_TOKEN_LOCK_VAULT_ADDRESS") as Address;
const account = privateKeyToAccount(required("KEEPER_PRIVATE_KEY") as Hex, { nonceManager });
const keeperVault = process.env.KEEPER_VAULT_ADDRESS as Address | undefined;
const transport = rpcTransport(chain.rpcUrls.default.http[0], process.env.ROBINHOOD_RPC_FALLBACK_URL);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({
  chain,
  transport: transactionRpcTransport(chain.rpcUrls.default.http[0]),
  account,
});

let latestPonsStatus: PonsLifecycleStatus | undefined;
let nextPonsCheckAt = 0;
let nextLockScanAt = 0;

async function maintainPonsLifecycle() {
  const now = Date.now();
  if (now < nextPonsCheckAt && latestPonsStatus) return latestPonsStatus;
  latestPonsStatus = await advancePonsLifecycle(publicClient, walletClient, account, projectToken);
  nextPonsCheckAt = now + (latestPonsStatus.phase === 2 ? 60_000 : 15_000);
  for (const hash of latestPonsStatus.transactions) {
    console.log(`Advanced PONS lifecycle: ${hash}`);
    try {
      const reimbursement = await reimburseGas(publicClient, walletClient, account, keeperVault, hash);
      if (reimbursement) console.log(`Reimbursed PONS lifecycle transaction: ${reimbursement}`);
    } catch (error) {
      console.error("PONS lifecycle reimbursement failed", error);
    }
  }
  return latestPonsStatus;
}

async function releaseMaturedProjectLocks() {
  if (Date.now() < nextLockScanAt) return 0;
  nextLockScanAt = Date.now() + 60_000;
  const [count, latestBlock] = await Promise.all([
    publicClient.readContract({ address: projectTokenLockVault, abi: lockVaultAbi, functionName: "lockCount" }),
    publicClient.getBlock(),
  ]);
  let released = 0;
  for (let lockId = 0n; lockId < count; lockId += 1n) {
    const tranche = await publicClient.readContract({
      address: projectTokenLockVault,
      abi: lockVaultAbi,
      functionName: "locks",
      args: [lockId],
    });
    if (tranche[2] || tranche[1] > latestBlock.timestamp) continue;
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address: projectTokenLockVault,
        abi: lockVaultAbi,
        functionName: "release",
        args: [lockId],
      });
      const hash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("LOCK_RELEASE_REVERTED");
      released += 1;
      console.log(`Released matured project-token lock ${lockId}: ${hash}`);
      try {
        const reimbursement = await reimburseGas(publicClient, walletClient, account, keeperVault, hash);
        if (reimbursement) console.log(`Reimbursed lock release ${lockId}: ${reimbursement}`);
      } catch (error) {
        console.error(`Lock release reimbursement failed for ${lockId}`, error);
      }
    } catch (error) {
      // Permissionless release can race another caller. Re-read before treating
      // the attempt as a real failure.
      const latest = await publicClient.readContract({
        address: projectTokenLockVault,
        abi: lockVaultAbi,
        functionName: "locks",
        args: [lockId],
      });
      if (!latest[2]) throw error;
    }
  }
  return released;
}

async function executeDueProposals() {
  const proposalId = await publicClient.readContract({
    address: governance,
    abi: governanceAbi,
    functionName: "activeProposalId",
  });
  if (proposalId === 0n) return;
  const latestBlock = await publicClient.getBlock();
  const now = latestBlock.timestamp;
  const proposal = await publicClient.readContract({
    address: governance,
    abi: governanceAbi,
    functionName: "proposals",
    args: [proposalId],
  });
  const executableAt = proposal[2];
  const executed = proposal[7];
  if (executed || executableAt === 0n || executableAt > now) return;

  const { request } = await publicClient.simulateContract({
    account,
    address: governance,
    abi: governanceAbi,
    functionName: "execute",
    args: [proposalId],
  });
  const hash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Submitted proposal ${proposalId}: ${hash}`);
  try {
    const reimbursement = await reimburseGas(publicClient, walletClient, account, keeperVault, hash);
    if (reimbursement) console.log(`Reimbursed execution ${proposalId}: ${reimbursement}`);
  } catch (error) {
    console.error(`Reimbursement failed for proposal ${proposalId}`, error);
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const pons = await maintainPonsLifecycle();
    const locksReleased = await releaseMaturedProjectLocks();
    await executeDueProposals();
    await writeHeartbeat("governance-keeper", true, {
      account: account.address,
      governance,
      ponsPhase: pons.phase,
      ponsPhaseName: pons.phaseName,
      migrationReady: pons.readyToGraduate,
      locksReleased,
    });
  } catch (error) {
    console.error(new Date().toISOString(), error);
    await writeHeartbeat("governance-keeper", false, {
      account: account.address,
      governance,
      error: error instanceof Error ? error.message : "unknown error",
    }).catch(() => undefined);
  } finally {
    running = false;
  }
}

console.log(`Governance keeper started for ${governance} as ${account.address}`);
void tick();
setInterval(() => void tick(), 15_000);
