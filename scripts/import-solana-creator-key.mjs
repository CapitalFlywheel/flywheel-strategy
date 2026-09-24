import { writeFile } from "node:fs/promises";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

// Run only in an ephemeral container with the protected key directory mounted.
// The secret arrives through stdin, never a command argument, environment value
// or chat message. Accept a 32-byte seed or 64-byte keypair in base58/JSON
// form, but always verify the derived public address before writing. The
// destination must not already exist.
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
  try {
    const parsed = input.startsWith("[") || input.startsWith('"') ? JSON.parse(input) : input;
    if (Array.isArray(parsed)) {
      if (parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        throw new Error("CREATOR_SECRET_FORMAT_INVALID");
      }
      raw = Uint8Array.from(parsed);
    } else if (typeof parsed === "string") {
      raw = /^0x(?:[a-fA-F0-9]{64}|[a-fA-F0-9]{128})$/.test(parsed)
        ? Uint8Array.from(Buffer.from(parsed.slice(2), "hex"))
        : bs58.decode(parsed);
    } else {
      throw new Error("CREATOR_SECRET_FORMAT_INVALID");
    }
  } catch {
    throw new Error("CREATOR_SECRET_FORMAT_INVALID");
  }
  if (raw.length !== 32 && raw.length !== 64) throw new Error("CREATOR_SECRET_LENGTH_INVALID");
  let creator;
  try {
    creator = raw.length === 32 ? Keypair.fromSeed(raw) : Keypair.fromSecretKey(raw);
  } catch {
    throw new Error("CREATOR_SECRET_FORMAT_INVALID");
  }
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
