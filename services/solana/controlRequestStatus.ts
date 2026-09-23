import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { readJsonIfExists, writeDurableJson } from "./durableJson";

export type ControlRequestOutcome = "queued" | "processed" | "failed";

function outcomePath(controlRoot: string, requestId: string) {
  if (!/^\d+-[a-f0-9]{16}$/.test(requestId)) throw new Error("REQUEST_ID_INVALID");
  return resolve(controlRoot, "solana-status-visible", "request-outcomes", `${requestId}.json`);
}

export async function writeControlRequestOutcome(controlRoot: string, requestId: string, state: "processed" | "failed") {
  await writeDurableJson(outcomePath(controlRoot, requestId), { version: 1, state, updatedAt: Date.now() });
}

async function fileExists(path: string) {
  try { return (await stat(path)).isFile(); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readControlRequestOutcome(controlRoot: string, requestId: string): Promise<ControlRequestOutcome | undefined> {
  const marker = await readJsonIfExists<{ version: number; state: string }>(outcomePath(controlRoot, requestId));
  if (marker) {
    if (marker.version !== 1 || (marker.state !== "processed" && marker.state !== "failed")) throw new Error("REQUEST_OUTCOME_INVALID");
    return marker.state;
  }
  const name = `${requestId}.json`;
  // Raw completed/failed files can contain signatures and RPC exceptions.
  // They are not mounted into the public web container.
  if (await fileExists(resolve(controlRoot, "solana-requests", name))) return "queued";
}
