import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { prepareBitqueryEnv } from "./lib/bitqueryImportEnv.mjs";

// One-off staging setup: credentials arrive via stdin, never command arguments.
const destination = process.argv[2];
if (destination !== "/config/.env.solana") {
  console.error("BITQUERY_IMPORT_ARGUMENTS_INVALID");
  process.exit(2);
}

let temporary;
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 8192) throw new Error("BITQUERY_INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) ?? {};
  const oldContent = await readFile(destination, "utf8");
  const { nextContent, status } = prepareBitqueryEnv(input, oldContent);
  temporary = `/config/.env.solana.tmp-${randomBytes(12).toString("hex")}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(nextContent, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, destination);
  temporary = undefined;
  console.log(status);
} catch (error) {
  console.error(error instanceof Error && [
    "BITQUERY_INPUT_TOO_LARGE", "BITQUERY_CREDENTIALS_INVALID", "BITQUERY_API_KEY_INVALID",
    "BITQUERY_ENV_ROUNDTRIP_FAILED",
  ].includes(error.message) ? error.message : "BITQUERY_IMPORT_FAILED");
  process.exitCode = 1;
} finally {
  if (temporary) await unlink(temporary).catch(() => undefined);
}
