import "dotenv/config";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rpcTransport } from "../shared/rpc";
import {
  PONS_FACTORY,
  normalizePrelaunchManifest,
  verifyPonsDetection,
  type PrelaunchManifest,
} from "../admin/launchManifest";
import { writeHeartbeat } from "./heartbeat";
import { reimburseGas } from "./reimburse";
import { advancePonsLifecycle } from "./ponsLifecycle";

const controlRoot = resolve(process.env.CONTROL_DATA_ROOT || "data/control");
const launchRoot = resolve(controlRoot, "main-launch");
const prelaunchPath = resolve(launchRoot, "prelaunch.json");
const armedPath = resolve(launchRoot, "armed.json");
const detectedPath = resolve(launchRoot, "detected.json");
const pollMs = Math.max(2_000, Number(process.env.LAUNCH_WATCH_POLL_MS || "3000"));
const maxRuntimeMs = Math.min(6 * 60 * 60_000, Math.max(10 * 60_000, Number(process.env.LAUNCH_WATCH_MAX_MS || "21600000")));

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"] } },
});
const publicClient = createPublicClient({
  chain,
  transport: rpcTransport(process.env.ROBINHOOD_RPC_URL, process.env.ROBINHOOD_RPC_FALLBACK_URL),
});
const launchEvent = parseAbiItem(
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
);

const delay = (milliseconds: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_IS_REQUIRED`);
  return value;
}

async function atomicJson(path: string, payload: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function loadManifest(): Promise<PrelaunchManifest> {
  const value = JSON.parse(await readFile(prelaunchPath, "utf8"));
  return normalizePrelaunchManifest(value, getAddress(value.owner));
}

interface ArmedState {
  armedAt: number;
  nextBlock?: string;
}

interface DetectedState {
  token: Address;
  curve: Address;
  transactionHash: Hex;
  blockNumber: string;
  launchTimestamp: number;
  detectedAt: number;
  settings: { pair: "ETH"; creatorTaxBps: 200; buybackEnabled: false };
}

async function loadJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function disarm() {
  await unlink(armedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function keepMigrationMoving(manifest: PrelaunchManifest, token: Address, detected: object) {
  const account = privateKeyToAccount(required("KEEPER_PRIVATE_KEY") as Hex);
  if (account.address.toLowerCase() !== manifest.automation.toLowerCase()) {
    throw new Error("KEEPER_PRIVATE_KEY_DOES_NOT_MATCH_AUTOMATION_ADDRESS");
  }
  const walletClient = createWalletClient({ chain, transport: rpcTransport(process.env.ROBINHOOD_RPC_URL, process.env.ROBINHOOD_RPC_FALLBACK_URL), account });

  while (true) {
    try {
      const lifecycle = await advancePonsLifecycle(publicClient, walletClient, account, token);
      for (const hash of lifecycle.transactions) {
        console.log(`Advanced detected launch lifecycle: ${hash}`);
        try {
          const reimbursement = await reimburseGas(publicClient, walletClient, account, manifest.keeperVault, hash);
          if (reimbursement) console.log(`Reimbursed launch lifecycle transaction: ${reimbursement}`);
        } catch (error) {
          console.error("Launch lifecycle reimbursement failed", error);
        }
      }
      await writeHeartbeat("launch-watcher", true, {
        state: lifecycle.phase === 2 ? "v4_ready" : lifecycle.phase === 1 ? "migration" : "curve",
        ...detected,
        ponsPhase: lifecycle.phase,
        ponsPhaseName: lifecycle.phaseName,
      });
      if (lifecycle.phase === 2) {
        console.log(`PONS V4 pool is ready for ${token}`);
        await disarm();
        return;
      }
      if (lifecycle.phase === 3) throw new Error("PONS_GRADUATION_WAS_RESCUED");
    } catch (error) {
      await writeHeartbeat("launch-watcher", false, {
        state: "migration_retry",
        ...detected,
        error: error instanceof Error ? error.message : "unknown error",
      });
      console.error("PONS lifecycle attempt failed; retrying", error);
    }
    await delay(15_000);
  }
}

async function main() {
  const armed = await loadJson<ArmedState>(armedPath);
  if (!armed) throw new Error("LAUNCH_WATCHER_NOT_ARMED");
  const manifest = await loadManifest();
  const detected = await loadJson<DetectedState>(detectedPath);
  if (detected) {
    console.log(`Resuming PONS lifecycle tracking for ${detected.token}`);
    await keepMigrationMoving(manifest, getAddress(detected.token), detected);
    return;
  }

  let fromBlock: bigint;
  if (armed.nextBlock !== undefined) {
    fromBlock = BigInt(armed.nextBlock);
  } else {
    fromBlock = (await publicClient.getBlockNumber()) - 64n;
    if (fromBlock < 0n) fromBlock = 0n;
    await atomicJson(armedPath, { ...armed, nextBlock: fromBlock.toString() });
  }
  console.log(`Watching PONS launches by ${manifest.owner} from block ${fromBlock}`);
  await writeHeartbeat("launch-watcher", true, { state: "armed", owner: manifest.owner, fromBlock: fromBlock.toString() });

  while (Date.now() - armed.armedAt < maxRuntimeMs) {
    try {
      const head = await publicClient.getBlockNumber();
      if (head >= fromBlock) {
        const logs = await publicClient.getLogs({
          address: PONS_FACTORY,
          event: launchEvent,
          args: { deployer: manifest.owner },
          fromBlock,
          toBlock: head,
          strict: true,
        });
        for (const log of logs) {
          const token = getAddress(log.args.token as Address);
          const curve = getAddress(log.args.curve as Address);
          if (!await verifyPonsDetection(manifest, token, curve, publicClient as PublicClient)) continue;
          const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
          const nextDetected: DetectedState = {
            token,
            curve,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber.toString(),
            launchTimestamp: Number(block.timestamp),
            detectedAt: Date.now(),
            settings: { pair: "ETH", creatorTaxBps: 200, buybackEnabled: false },
          };
          await atomicJson(detectedPath, nextDetected);
          await writeHeartbeat("launch-watcher", true, { state: "detected", ...nextDetected });
          console.log(`Expected PONS token detected: ${token}`);
          await keepMigrationMoving(manifest, token, nextDetected);
          return;
        }
        fromBlock = head + 1n;
        await atomicJson(armedPath, { ...armed, nextBlock: fromBlock.toString() });
      }
      await writeHeartbeat("launch-watcher", true, { state: "armed", owner: manifest.owner, checkedBlock: head.toString() });
    } catch (error) {
      console.error("Launch detection RPC attempt failed; retrying without advancing cursor", error);
      await writeHeartbeat("launch-watcher", false, {
        state: "detection_retry",
        owner: manifest.owner,
        nextBlock: fromBlock.toString(),
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
    await delay(pollMs);
  }
  await writeHeartbeat("launch-watcher", false, { state: "expired", owner: manifest.owner });
  await disarm();
  throw new Error("LAUNCH_WATCH_WINDOW_EXPIRED");
}

main().catch(async (error) => {
  console.error(error);
  await writeHeartbeat("launch-watcher", false, {
    state: "failed",
    error: error instanceof Error ? error.message : "unknown error",
  }).catch(() => undefined);
  process.exitCode = 1;
});
