import { writeFile } from "node:fs/promises";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

// Run only in an ephemeral container with the protected key directory mounted.
// The secret arrives through stdin, never a command argument, environment value
// or chat message. The destination must not already exist.
const [expectedAddress, destination] = process.argv.slice(2);
if (!expectedAddress || destination !== "/keys/creator.json") {
  console.error("CREATOR_IMPORT_ARGUMENTS_INVALID");
  process.exit(2);
}

try {
  const expected = new PublicKey(expectedAddress).toBase58();
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4096) throw new Error("CREATOR_SECRET_INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8").trim();
  let raw;
  if (input.startsWith("[")) {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error("CREATOR_SECRET_FORMAT_INVALID");
    }
    raw = Uint8Array.from(parsed);
  } else {
    raw = bs58.decode(input);
  }
  if (raw.length !== 64) throw new Error("CREATOR_SECRET_LENGTH_INVALID");
  const creator = Keypair.fromSecretKey(raw);
  if (creator.publicKey.toBase58() !== expected) throw new Error("CREATOR_SECRET_ADDRESS_MISMATCH");
  await writeFile(destination, JSON.stringify(Array.from(creator.secretKey)), { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(`CREATOR_KEY_INSTALLED:${expected}`);
} catch (error) {
  // Never print a library exception that could echo sensitive input.
  const safeCodes = new Set([
    "CREATOR_SECRET_INPUT_TOO_LARGE", "CREATOR_SECRET_FORMAT_INVALID",
    "CREATOR_SECRET_LENGTH_INVALID", "CREATOR_SECRET_ADDRESS_MISMATCH",
  ]);
  const code = error && typeof error === "object" && "code" in error && error.code === "EEXIST"
    ? "CREATOR_KEY_ALREADY_INSTALLED"
    : error instanceof Error && safeCodes.has(error.message) ? error.message : "CREATOR_IMPORT_FAILED";
  console.error(code);
  process.exit(1);
}
