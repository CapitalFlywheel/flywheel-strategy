import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, describe, expect, it } from "vitest";
import { buildBindCapitalMintInstruction, ensureGovernanceCapitalBound, type GovernanceBindEnvironment } from "./governanceAutoBind";
import { deriveGovernanceReserveRoute } from "./governanceVaultRoute";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + "\\")) throw new Error("TEST_CLEANUP_PATH_INVALID");
    await rm(root, { recursive: true, force: true });
  }
});

async function environment(): Promise<GovernanceBindEnvironment> {
  const stateRoot = await mkdtemp(join(tmpdir(), "flywheel-bind-"));
  roots.push(stateRoot);
  const governanceProgram = Keypair.generate().publicKey.toBase58();
  const reserveMint = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
  const reserveAuthority = deriveGovernanceReserveRoute(governanceProgram, reserveMint).authority.toBase58();
  const admin = Keypair.generate().publicKey.toBase58();
  return {
    rpcUrls: ["https://a.example", "https://b.example"], stateRoot,
    governanceProgram, expectedProgramCodeSha256: "a".repeat(64), reserveAuthority, reserveMint,
    admin, adminKeypairPath: "unused", expectedCreator: admin,
    launch: {
      signature: bs58.encode(Buffer.alloc(64, 7)), slot: 456, blockTime: 1_700_000_000,
      mint: Keypair.generate().publicKey.toBase58(), creator: admin, user: admin,
      quoteMint: reserveMint, tokenProgram: Keypair.generate().publicKey.toBase58(),
      creatorFeeBps: 200n, isHolderReward: false,
    },
  };
}

const prepared = (index: number) => ({
  signature: `sig-${index}`, transactionBase64: "AA==", blockhash: `hash-${index}`,
  lastValidBlockHeight: 100 + index,
});

describe("automatic one-time governance binding", () => {
  it("serializes exact Anchor discriminator, launch evidence and account roles", async () => {
    const env = await environment();
    const ix = buildBindCapitalMintInstruction(env);
    expect(ix.programId.toBase58()).toBe(env.governanceProgram);
    expect(ix.keys.map(({ pubkey, isWritable, isSigner }) => [pubkey.toBase58(), isWritable, isSigner])).toEqual([
      [env.reserveAuthority, true, false], [env.launch.mint, false, false], [env.admin, false, true],
    ]);
    expect(ix.data.subarray(0, 8)).toEqual(createHash("sha256").update("global:bind_capital_mint").digest().subarray(0, 8));
    expect(ix.data.readBigInt64LE(8)).toBe(BigInt(env.launch.blockTime));
    expect(ix.data.readBigUInt64LE(16)).toBe(BigInt(env.launch.slot));
    expect(ix.data.subarray(24)).toEqual(Buffer.from(bs58.decode(env.launch.signature)));
  });

  it("persists signed bytes before send, retries identical bytes, and activates only after bound", async () => {
    const env = await environment();
    const calls: string[] = [];
    let bound = false;
    const effects = {
      verifyLaunch: async () => { calls.push("verify"); },
      readBinding: async () => { calls.push("read"); return bound ? "bound" as const : "unbound" as const; },
      prepare: async () => { calls.push("prepare"); return prepared(1); },
      broadcast: async (transaction: ReturnType<typeof prepared>) => {
        const state = JSON.parse(await readFile(join(env.stateRoot, "governance-capital-bind.json"), "utf8"));
        expect(state.attempts.at(-1).transaction.signature).toBe(transaction.signature);
        calls.push(`send:${transaction.signature}`);
      },
      transactionState: async () => "pending" as const,
    };
    expect(await ensureGovernanceCapitalBound(env, effects)).toBe(false);
    expect(await ensureGovernanceCapitalBound(env, effects)).toBe(false);
    bound = true;
    expect(await ensureGovernanceCapitalBound(env, effects)).toBe(true);
    expect(calls).toEqual(["verify", "read", "prepare", "send:sig-1", "verify", "read", "send:sig-1", "verify", "read"]);
    const ledger = JSON.parse(await readFile(join(env.stateRoot, "governance-capital-bind.json"), "utf8"));
    expect(ledger).toMatchObject({ finalized: true, attempts: [{ state: "prepared" }] });
  });

  it("replaces only an expired signed attempt and blocks a finalized transaction without matching state", async () => {
    const env = await environment();
    let state: "pending" | "expired" | "finalized" = "pending";
    let count = 0;
    const effects = {
      verifyLaunch: async () => undefined,
      readBinding: async () => "unbound" as const,
      prepare: async () => prepared(++count),
      broadcast: async () => undefined,
      transactionState: async () => state,
    };
    expect(await ensureGovernanceCapitalBound(env, effects)).toBe(false);
    state = "expired";
    expect(await ensureGovernanceCapitalBound(env, effects)).toBe(false);
    expect(count).toBe(2);
    const ledger = JSON.parse(await readFile(join(env.stateRoot, "governance-capital-bind.json"), "utf8"));
    expect(ledger.attempts.map((row: { state: string }) => row.state)).toEqual(["expired", "prepared"]);
    state = "finalized";
    await expect(ensureGovernanceCapitalBound(env, effects)).rejects.toThrow("GOVERNANCE_BIND_FINALIZED_BUT_UNBOUND");
    expect(count).toBe(2);
  });

  it("rejects another program or launch identity rather than replaying an old prepared transaction", async () => {
    const env = await environment();
    const effects = {
      verifyLaunch: async () => undefined,
      readBinding: async () => "unbound" as const,
      prepare: async () => prepared(1),
      broadcast: async () => undefined,
      transactionState: async () => "pending" as const,
    };
    await ensureGovernanceCapitalBound(env, effects);
    await expect(ensureGovernanceCapitalBound({ ...env, launch: { ...env.launch, slot: env.launch.slot + 1 } }, effects))
      .rejects.toThrow("GOVERNANCE_BIND_LEDGER_IDENTITY_MISMATCH");
    await expect(ensureGovernanceCapitalBound({ ...env, expectedProgramCodeSha256: "b".repeat(64) }, effects))
      .rejects.toThrow("GOVERNANCE_BIND_LEDGER_IDENTITY_MISMATCH");
  });

  it("rejects a placeholder program and malformed launch signature before constructing a transaction", async () => {
    const env = await environment();
    expect(() => buildBindCapitalMintInstruction({ ...env, governanceProgram: "3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh" }))
      .toThrow("GOVERNANCE_PROGRAM_PLACEHOLDER");
    expect(() => buildBindCapitalMintInstruction({ ...env, launch: { ...env.launch, signature: bs58.encode(Buffer.alloc(32, 1)) } }))
      .toThrow("GOVERNANCE_LAUNCH_SIGNATURE_INVALID");
  });

  it("does not prepare or send if finalized launch verification or onchain binding check fails", async () => {
    const env = await environment();
    let preparedCount = 0;
    const effects = {
      verifyLaunch: async (): Promise<void> => { throw new Error("PUMP_CREATE_EVENT_RPC_DISAGREEMENT"); },
      readBinding: async () => "unbound" as const,
      prepare: async () => { preparedCount += 1; return prepared(1); },
      broadcast: async () => undefined,
      transactionState: async () => "pending" as const,
    };
    await expect(ensureGovernanceCapitalBound(env, effects)).rejects.toThrow("PUMP_CREATE_EVENT_RPC_DISAGREEMENT");
    expect(preparedCount).toBe(0);
    effects.verifyLaunch = async () => undefined;
    effects.readBinding = async () => { throw new Error("GOVERNANCE_PROGRAM_CODE_MISMATCH"); };
    await expect(ensureGovernanceCapitalBound(env, effects)).rejects.toThrow("GOVERNANCE_PROGRAM_CODE_MISMATCH");
    expect(preparedCount).toBe(0);
  });
});
