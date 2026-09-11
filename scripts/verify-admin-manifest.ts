import { readFile } from "node:fs/promises";
import { getAddress } from "viem";
import {
  normalizePostlaunchManifest,
  normalizePrelaunchManifest,
  verifyPostlaunchManifest,
  verifyPrelaunchManifest,
} from "../services/admin/launchManifest";

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("REQUEST_PATH_REQUIRED");
  const request = JSON.parse(await readFile(path, "utf8"));
  const owner = getAddress(request.signer);
  if (request.action === "register_prelaunch") {
    const manifest = normalizePrelaunchManifest(request.payload, owner);
    await verifyPrelaunchManifest(manifest);
  } else if (request.action === "activate_postlaunch") {
    const manifest = normalizePostlaunchManifest(request.payload, owner);
    await verifyPostlaunchManifest(manifest);
  } else {
    throw new Error("UNSUPPORTED_MANIFEST_ACTION");
  }
  console.log("ADMIN_MANIFEST_OK");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
