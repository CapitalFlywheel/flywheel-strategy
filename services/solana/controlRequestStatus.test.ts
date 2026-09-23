import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readControlRequestOutcome, writeControlRequestOutcome } from "./controlRequestStatus";

describe("private Solana request outcome", () => {
  let root: string;
  const id = "1234567890-abcdef0123456789";
  const name = `${id}.json`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "flywheel-request-status-"));
    await Promise.all(["solana-requests", "solana-completed", "solana-failed"].map((directory) => mkdir(join(root, directory))));
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("reveals only queued, processed or failed, never raw failure contents", async () => {
    expect(await readControlRequestOutcome(root, id)).toBeUndefined();
    await writeFile(join(root, "solana-requests", name), "{}", "utf8");
    expect(await readControlRequestOutcome(root, id)).toBe("queued");
    await writeFile(join(root, "solana-completed", name), JSON.stringify({ signature: "SENSITIVE_SIGNATURE_HERE" }), "utf8");
    expect(await readControlRequestOutcome(root, id)).toBe("queued");
    await writeControlRequestOutcome(root, id, "processed");
    expect(await readControlRequestOutcome(root, id)).toBe("processed");
    await writeFile(join(root, "solana-failed", name), JSON.stringify({ error: "SENSITIVE_RPC_URL_HERE" }), "utf8");
    expect(await readControlRequestOutcome(root, id)).toBe("processed");
    await writeControlRequestOutcome(root, id, "failed");
    expect(await readControlRequestOutcome(root, id)).toBe("failed");
    const marker = await readFile(join(root, "solana-status-visible", "request-outcomes", name), "utf8");
    expect(marker).not.toContain("SENSITIVE");
  });

  it("rejects path traversal and malformed IDs", async () => {
    await expect(readControlRequestOutcome(root, "../fee-settlement.json")).rejects.toThrow("REQUEST_ID_INVALID");
    await expect(readControlRequestOutcome(root, "123-ABC")).rejects.toThrow("REQUEST_ID_INVALID");
  });
});
