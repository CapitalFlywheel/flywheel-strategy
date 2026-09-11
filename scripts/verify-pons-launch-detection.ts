import { readFile } from "node:fs/promises";
import { createPublicClient, getAddress, http, parseAbiItem } from "viem";
import {
  PONS_FACTORY,
  normalizePrelaunchManifest,
  verifyPonsDetection,
} from "../services/admin/launchManifest";

async function main() {
  const preFile = JSON.parse(await readFile("deployments/prelaunch-4663.json", "utf8"));
  const launch = JSON.parse(await readFile("deployments/pons-launch-4663.json", "utf8"));
  const owner = getAddress(preFile.deployer);
  const pre = normalizePrelaunchManifest({ ...preFile, version: 1, chainId: 4663, owner }, owner);
  const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
  const event = parseAbiItem(
    "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
  );
  const block = BigInt(launch.blockNumber);
  const logs = await client.getLogs({
    address: PONS_FACTORY,
    event,
    args: { deployer: owner },
    fromBlock: block,
    toBlock: block,
    strict: true,
  });
  const matched = logs.find((log) => log.args.token?.toLowerCase() === launch.token.toLowerCase());
  if (!matched || !await verifyPonsDetection(pre, getAddress(matched.args.token), getAddress(matched.args.curve))) {
    throw new Error("PONS_LAUNCH_DETECTION_FAILED");
  }
  console.log(`PONS_LAUNCH_DETECTION_OK token=${matched.args.token} curve=${matched.args.curve}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
