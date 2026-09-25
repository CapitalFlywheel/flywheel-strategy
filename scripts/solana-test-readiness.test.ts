import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { assertFreshSolanaTestState, assessSolanaTestReadiness, EXPECTED_TEST_CREATOR,
  EXPECTED_TEST_RESERVE, readReleaseGates, type TestReadinessDeps } from "./solana-test-readiness";

const MSTRX_MINT = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("flywheel-ready-state-")) {
      throw new Error("UNSAFE_TEST_TEMP_ROOT");
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function runtimeEnv() {
  const root = await mkdtemp(join(tmpdir(), "flywheel-ready-state-"));
  temporaryRoots.push(root);
  return {
    SOLANA_STATE_ROOT: join(root, "solana"),
    CONTROL_DATA_ROOT: join(root, "control"),
    PUBLIC_DATA_ROOT: join(root, "public"),
    SOLANA_HOLDER_JOURNAL_PATH: join(root, "journal", "holder.jsonl"),
  };
}

function fixture() {
  return {
    SOLANA_CLUSTER: "mainnet-beta",
    SOLANA_RPC_PRIMARY_URL: "https://primary.example/rpc?private=never-print-this",
    SOLANA_RPC_FALLBACK_URL: "https://fallback.example/rpc?private=never-print-this-either",
    SOLANA_ADMIN_OWNER: EXPECTED_TEST_CREATOR,
    SOLANA_CREATOR_PUBLIC_KEY: EXPECTED_TEST_CREATOR,
    SOLANA_CREATOR_KEYPAIR_PATH: "/protected/test-creator.json",
    SOLANA_RECOVERY_PUBLIC_KEY: EXPECTED_TEST_CREATOR,
    SOLANA_SHARED_ADMIN_CREATOR: "true",
    SOLANA_OPERATOR_PUBLIC_KEY: Keypair.generate().publicKey.toBase58(),
    SOLANA_OPERATOR_KEYPAIR_PATH: "/protected/test-operator.json",
    SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY: Keypair.generate().publicKey.toBase58(),
    SOLANA_HOLDER_SETTLEMENT_KEYPAIR_PATH: "/protected/test-holder.json",
    SOLANA_MARKETING_PUBLIC_KEY: EXPECTED_TEST_CREATOR,
    SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY: EXPECTED_TEST_RESERVE,
    SOLANA_MSTRX_MINT: MSTRX_MINT,
    SOLANA_HOLDER_JOURNAL_PATH: "/protected/test-holder-journal.jsonl",
  };
}

function deps(): TestReadinessDeps {
  return {
    rpcSmoke: vi.fn(async () => true),
    roleKeypairs: vi.fn(async () => true),
    freshState: vi.fn(async () => true),
  };
}

function check(report: Awaited<ReturnType<typeof assessSolanaTestReadiness>>, id: string) {
  return report.checks.find((entry) => entry.id === id);
}

describe("owner-wallet Solana test readiness", () => {
  it("accepts the approved creator and owner-controlled reserve without a governance program", async () => {
    const report = await assessSolanaTestReadiness(fixture(), await readReleaseGates(), deps());
    expect(report.ready).toBe(true);
    expect(check(report, "owner-controlled-test-reserve")?.status).toBe("pass");
    expect(report.checks.some((entry) => entry.id.includes("governance"))).toBe(false);
    expect(JSON.stringify(report)).not.toContain("never-print-this");
  });

  it("rejects a wrong reserve or creator and known production-wallet reuse", async () => {
    const env = fixture();
    env.SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY = Keypair.generate().publicKey.toBase58();
    env.SOLANA_CREATOR_PUBLIC_KEY = Keypair.generate().publicKey.toBase58();
    const report = await assessSolanaTestReadiness({ ...env,
      SOLANA_PRODUCTION_DEPLOYER_PUBLIC_KEY: env.SOLANA_OPERATOR_PUBLIC_KEY }, await readReleaseGates(), deps());
    expect(report.ready).toBe(false);
    expect(check(report, "owner-controlled-test-reserve")?.code).toBe("TEST_RESERVE_WALLET_INVALID");
    expect(check(report, "disposable-wallet-roles")?.status).toBe("block");
    expect(check(report, "production-deployer-excluded")?.status).toBe("block");
  });

  it("does not expose RPC or key paths on failure", async () => {
    const checks = deps();
    vi.mocked(checks.rpcSmoke).mockRejectedValueOnce(new Error("never-print-this"));
    const report = await assessSolanaTestReadiness(fixture(), await readReleaseGates(), checks);
    expect(check(report, "two-rpc-finalized-full-block-v1")?.code).toBe("RPC_FULL_BLOCK_V1_CHECK_FAILED");
    expect(JSON.stringify(report)).not.toContain("never-print-this");
  });
});

describe("fresh Solana runtime inspection", () => {
  it("accepts empty roots and an unarmed status", async () => {
    const env = await runtimeEnv();
    await mkdir(join(env.CONTROL_DATA_ROOT, "solana-status-visible"), { recursive: true });
    await writeFile(join(env.CONTROL_DATA_ROOT, "solana-status-visible", "solana-status.json"), JSON.stringify({
      automationState: "stopped", launch: { configured: true, armed: false, activated: false },
    }));
    await expect(assertFreshSolanaTestState(env)).resolves.toBeUndefined();
  });

  it("rejects prior activated launch and receipts", async () => {
    const env = await runtimeEnv();
    await mkdir(join(env.CONTROL_DATA_ROOT, "solana-status-visible"), { recursive: true });
    await writeFile(join(env.CONTROL_DATA_ROOT, "solana-status-visible", "solana-status.json"), JSON.stringify({
      automationState: "stopped", launch: { configured: true, armed: false, activated: true },
    }));
    await expect(assertFreshSolanaTestState(env)).rejects.toThrow("TEST_STATE_NOT_FRESH");
    const other = await runtimeEnv();
    await mkdir(other.SOLANA_STATE_ROOT, { recursive: true });
    await writeFile(join(other.SOLANA_STATE_ROOT, "fee-settlement.json"), "{}");
    await expect(assertFreshSolanaTestState(other)).rejects.toThrow("TEST_STATE_NOT_FRESH");
  });
});
