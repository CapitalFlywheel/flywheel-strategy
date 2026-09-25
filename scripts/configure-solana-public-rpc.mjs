#!/usr/bin/env node
// Copy a protected read-only Solana RPC URL into a protected web-service env file.
// The value is never printed or included in the browser bundle.
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [sourceArg, targetArg, sourceKey = "SOLANA_RPC_FALLBACK_URL"] = process.argv.slice(2);
if (!sourceArg || !targetArg || !/^[A-Z][A-Z0-9_]*$/.test(sourceKey)) {
  console.error("Usage: configure-solana-public-rpc.mjs <protected-source-env> <protected-web-env> [source-key]");
  process.exit(2);
}

const sourcePath = resolve(sourceArg);
const targetPath = resolve(targetArg);
if (sourcePath === targetPath || dirname(targetPath) === "/") {
  console.error("Invalid source or target path");
  process.exit(2);
}

const targetKey = "SOLANA_PUBLIC_RPC_UPSTREAM_URL";
const source = await readFile(sourcePath, "utf8");
const existing = await readFile(targetPath, "utf8");
const sourceLine = source.split(/\r?\n/).find((line) => line.startsWith(`${sourceKey}=`));
if (!sourceLine) {
  console.error("Protected RPC source key is missing");
  process.exit(1);
}
let value = sourceLine.slice(sourceKey.length + 1).trim();
if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
  value = value.slice(1, -1);
}
let parsed;
try { parsed = new URL(value); } catch { /* handled below */ }
if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password || /[\r\n]/.test(value)) {
  console.error("Protected RPC URL is invalid");
  process.exit(1);
}

const lines = existing.split(/\r?\n/).filter((line) => !line.startsWith(`${targetKey}=`));
while (lines.at(-1) === "") lines.pop();
lines.push(`${targetKey}=${value}`);
const replacement = `${lines.join("\n")}\n`;
const mode = (await stat(targetPath)).mode & 0o777;
const temporaryPath = `${targetPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, replacement, { mode: Math.min(mode, 0o600), flag: "wx" });
await rename(temporaryPath, targetPath);
console.log("Protected public Solana RPC upstream configured");
