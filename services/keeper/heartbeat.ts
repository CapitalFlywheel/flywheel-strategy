import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeHeartbeat(
  service: string,
  ok: boolean,
  details: Record<string, unknown> = {}
) {
  const root = process.env.PUBLIC_DATA_ROOT || "data/public";
  const path = join(root, "status", `${service}.json`);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify({ service, ok, updatedAt: Date.now(), ...details }, null, 2));
  await rename(temporary, path);
}
