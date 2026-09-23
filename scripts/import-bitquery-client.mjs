import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { parse as parseDotenv } from "dotenv";

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
  const clientId = input.clientId;
  const clientSecret = input.clientSecret;
  if (typeof clientId !== "string" || typeof clientSecret !== "string"
    || clientId.length < 8 || clientSecret.length < 8
    || /[\r\n]/.test(clientId) || /[\r\n]/.test(clientSecret)) {
    throw new Error("BITQUERY_CREDENTIALS_INVALID");
  }
  const oldContent = await readFile(destination, "utf8");
  const updates = {
    BITQUERY_CLIENT_ID: clientId,
    BITQUERY_CLIENT_SECRET: clientSecret,
    BITQUERY_API_KEY: "",
  };
  const kept = oldContent.split(/\r?\n/).filter((line) => !(line.split("=", 1)[0] in updates));
  const nextContent = `${kept.filter(Boolean).join("\n")}\n${Object.entries(updates).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
  const parsed = parseDotenv(nextContent);
  if (parsed.BITQUERY_CLIENT_ID !== clientId || parsed.BITQUERY_CLIENT_SECRET !== clientSecret) {
    throw new Error("BITQUERY_ENV_ROUNDTRIP_FAILED");
  }
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
  console.log("BITQUERY_CREDENTIALS_INSTALLED");
} catch (error) {
  console.error(error instanceof Error && [
    "BITQUERY_INPUT_TOO_LARGE", "BITQUERY_CREDENTIALS_INVALID", "BITQUERY_ENV_ROUNDTRIP_FAILED",
  ].includes(error.message) ? error.message : "BITQUERY_IMPORT_FAILED");
  process.exitCode = 1;
} finally {
  if (temporary) await unlink(temporary).catch(() => undefined);
}
