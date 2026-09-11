import { readFile } from "node:fs/promises";
import { getAddress } from "viem";
import {
  normalizePostlaunchManifest,
  normalizePrelaunchManifest,
  verifyPostlaunchManifest,
  verifyPrelaunchManifest,
} from "../services/admin/launchManifest";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

async function main() {
  const preFile = await readJson("deployments/prelaunch-4663.json");
  const launch = await readJson("deployments/pons-launch-4663.json");
  const postFile = await readJson("deployments/mainnet-4663.json");
  const owner = getAddress(preFile.deployer);
  const pre = normalizePrelaunchManifest({ ...preFile, version: 1, chainId: 4663, owner }, owner);
  await verifyPrelaunchManifest(pre, { finalized: true });
  console.log("EXISTING_PRELAUNCH_COMPONENTS_OK");
  const post = normalizePostlaunchManifest({ ...postFile, version: 1, chainId: 4663, owner, curve: launch.curve }, owner);
  await verifyPostlaunchManifest(post);
  console.log("EXISTING_POSTLAUNCH_MANIFEST_OK");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
