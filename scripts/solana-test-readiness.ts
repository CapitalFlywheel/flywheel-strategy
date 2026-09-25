import "dotenv/config";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION } from "../services/solana/rpcTransactionVersion";
import { loadKeypair } from "../services/solana/transactions";
import { inspectSolanaRpcSmoke, rpcProbe } from "./solana-rpc-smoke";

// This is the disposable owner/creator/recovery address approved for the
// isolated Solana test. Never substitute a production creator here.
export const EXPECTED_TEST_CREATOR = "9tiKUSwJrdJQzySro2pWJmWLw83NpdGwrvTCUesSP9NQ";
export const EXPECTED_TEST_RESERVE = "8VffEDVrevGdRgDZP1rEDjWiZ3UvR256993C1ugCS73r";
const MSTRX_MINT = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const ZERO_KEY = new PublicKey(new Uint8Array(32));

const GATE_FILES = {
  execution: "../services/solana/releaseGates.ts",
  onchainProposals: "../programs/solana-governance/src/lib.rs",
  onchainBuybackExecutor: "../programs/solana-governance/src/lib.rs",
  onchainBuybackFunding: "../programs/solana-governance/src/lib.rs",
  onchainMarketingExecutor: "../programs/solana-governance/src/marketing_sale.rs",
  clientProposals: "../services/solana/governanceProposalInstruction.ts",
  clientExecutors: "../services/solana/governanceProposalInstruction.ts",
  voteRelay: "../services/api/governanceVoteRelay.ts",
  websiteVotes: "../apps/web/src/main.tsx",
  websiteExecutors: "../apps/web/src/governanceClient.ts",
  marketingControl: "../services/solana/governanceMarketingExecutionControl.ts",
  owedEscrow: "../services/solana/rewardPipeline.ts",
  freeReserveWithdrawal: "../services/solana/controlAuth.ts",
  finalizeVote: "../services/solana/controlAuth.ts",
  proposalControl: "../services/solana/controlAuth.ts",
} as const;

const GATE_DECLARATIONS = {
  execution: /^export const SOLANA_GOVERNANCE_EXECUTION_RELEASED = (true|false);\s*$/gm,
  onchainProposals: /^pub const GOVERNANCE_PROPOSALS_RELEASED: bool = (true|false);\s*$/gm,
  onchainBuybackExecutor: /^pub const BUYBACK_EXECUTOR_RELEASED: bool = (true|false);\s*$/gm,
  onchainBuybackFunding: /^pub const BUYBACK_TRADER_FUNDING_RELEASED: bool = (true|false);\s*$/gm,
  onchainMarketingExecutor: /^pub const MARKETING_SALE_EXECUTOR_RELEASED: bool = (true|false);\s*$/gm,
  clientProposals: /^const GOVERNANCE_PROPOSALS_RELEASED = (true|false);\s*$/gm,
  clientExecutors: /^const RELEASED_EXECUTORS: ReadonlySet<ReserveAction> = new Set\(([\s\S]*?)\);[ \t]*$/gm,
  voteRelay: /^export const GOVERNANCE_VOTE_BROADCAST_RELEASED = (true|false);\s*$/gm,
  websiteVotes: /^const VOTE_TRANSACTIONS_RELEASED = (true|false);\s*$/gm,
  websiteExecutors: /^const EXECUTOR_ACTIONS_RELEASED: ReadonlySet<typeof ACTIONS\[number\]> = new Set\(([\s\S]*?)\);[ \t]*$/gm,
  marketingControl: /^export const MARKETING_EXECUTION_CONTROL_RELEASED = (true|false);\s*$/gm,
  owedEscrow: /^export const OWED_ESCROW_RELEASED = (true|false);\s*$/gm,
  freeReserveWithdrawal: /^export const SOLANA_GOVERNANCE_RESERVE_WITHDRAWAL_RELEASED = (true|false);\s*$/gm,
  finalizeVote: /^export const SOLANA_GOVERNANCE_FINALIZE_RELEASED = (true|false);\s*$/gm,
  proposalControl: /^export const SOLANA_GOVERNANCE_PROPOSAL_CONTROL_RELEASED = (true|false);\s*$/gm,
} as const;

export type GateName = keyof typeof GATE_FILES;
export type GateState = Record<GateName, boolean | null>;
export type ReadinessCheck = { id: string; status: "pass" | "block" | "skipped"; code: string };
export type ReadinessReport = {
  phase: "isolated-solana-test-token";
  ready: boolean;
  checks: ReadinessCheck[];
  note: string;
};

/** Unknown/changed declaration syntax is a blocker, never an implicit release. */
export function parseReleaseGate(name: GateName, source: string): boolean | null {
  const matches = Array.from(source.matchAll(GATE_DECLARATIONS[name]));
  if (matches.length !== 1) return null;
  if (name === "clientExecutors" || name === "websiteExecutors") {
    const literal = matches[0][1]?.trim();
    if (literal === "") return false;
    try {
      const actions = JSON.parse(literal ?? "") as unknown;
      const required = ["ACCUMULATE", "BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK", "LOCK_MSTRX", "MARKETING_SALE"];
      return Array.isArray(actions) && actions.length === required.length
        && actions.every((action) => typeof action === "string" && required.includes(action))
        && new Set(actions).size === required.length;
    } catch { return null; }
  }
  return matches[0][1] === "true";
}

export async function readReleaseGates(): Promise<GateState> {
  const entries = await Promise.all((Object.keys(GATE_FILES) as GateName[]).map(async (name) => {
    try {
      const source = await readFile(new URL(GATE_FILES[name], import.meta.url), "utf8");
      return [name, parseReleaseGate(name, source)] as const;
    } catch {
      return [name, null] as const;
    }
  }));
  return Object.fromEntries(entries) as GateState;
}

function publicKey(value: string | undefined): PublicKey | null {
  try {
    const key = value ? new PublicKey(value.trim()) : null;
    return key && !key.equals(ZERO_KEY) ? key : null;
  } catch {
    return null;
  }
}

function safeRpcUrls(env: NodeJS.ProcessEnv): readonly [string, string] | null {
  const values = [env.SOLANA_RPC_PRIMARY_URL, env.SOLANA_RPC_FALLBACK_URL];
  if (values.some((value) => !value?.trim())) return null;
  try {
    const urls = values.map((value) => new URL(value!.trim()));
    if (urls.some((url) => url.protocol !== "https:" || url.username || url.password || url.hash)
      || urls[0].host === urls[1].host) return null;
    return [values[0]!.trim(), values[1]!.trim()];
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** A directory with only empty subdirectories is fresh; links and special files fail closed. */
async function hasRuntimeEntries(root: string, allowLockFiles = false): Promise<boolean> {
  if (!await pathExists(root)) return false;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) return true;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (allowLockFiles && entry.name === ".locks") {
      if (!entry.isDirectory()) return true;
      const lockEntries = await readdir(resolve(root, entry.name), { withFileTypes: true });
      if (lockEntries.some((lock) => !lock.isFile() || !lock.name.endsWith(".lock"))) return true;
      continue;
    }
    if (!entry.isDirectory() || await hasRuntimeEntries(resolve(root, entry.name))) return true;
  }
  return false;
}

function priorLaunchStatus(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("launch" in value)) return true;
  const status = value as Record<string, unknown>;
  const launch = status.launch;
  if (!launch || typeof launch !== "object") return true;
  const fields = launch as Record<string, unknown>;
  return fields.armed !== false || fields.activated !== false
    || !!fields.detectedMint || !!fields.detectedSignature || !!fields.governanceBindState
    || status.automationState !== "stopped" || !!status.governance || !!status.governanceProposal;
}

/**
 * Read-only guard against reusing an activated launch or accounting cursors in
 * the exact roots the Solana runners use. It never deletes, resets or prints state.
 */
export async function assertFreshSolanaTestState(env: NodeJS.ProcessEnv): Promise<void> {
  const stateRoot = resolve(env.SOLANA_STATE_ROOT || "data/solana");
  const controlRoot = resolve(env.CONTROL_DATA_ROOT || "data/control");
  const publicRoot = resolve(env.PUBLIC_DATA_ROOT || "data/public");
  for (const root of [controlRoot, publicRoot]) {
    if (await pathExists(root) && !(await lstat(root)).isDirectory()) throw new Error("TEST_STATE_NOT_FRESH");
  }
  if (await hasRuntimeEntries(stateRoot, true)) throw new Error("TEST_STATE_NOT_FRESH");
  if (env.SOLANA_HOLDER_JOURNAL_PATH?.trim()
    && await pathExists(resolve(env.SOLANA_HOLDER_JOURNAL_PATH.trim()))) throw new Error("TEST_STATE_NOT_FRESH");

  for (const statusPath of [
    resolve(controlRoot, "solana-status-visible", "solana-status.json"),
    resolve(controlRoot, "solana-status.json"),
  ]) {
    if (!await pathExists(statusPath)) continue;
    const status = JSON.parse(await readFile(statusPath, "utf8")) as unknown;
    if (priorLaunchStatus(status)) throw new Error("TEST_STATE_NOT_FRESH");
  }
  for (const parts of [
    ["solana-requests"], ["solana-completed"], ["solana-failed"],
    ["solana-status-visible", "request-outcomes"],
  ]) {
    if (await hasRuntimeEntries(resolve(controlRoot, ...parts))) throw new Error("TEST_STATE_NOT_FRESH");
  }
  if (await pathExists(resolve(publicRoot, "config.json"))
    || await hasRuntimeEntries(resolve(publicRoot, "governance"))
    || await pathExists(resolve(publicRoot, "status", "solana-holder-indexer.json"))) {
    throw new Error("TEST_STATE_NOT_FRESH");
  }
  const snapshots = resolve(publicRoot, "snapshots");
  if (await pathExists(snapshots)) {
    const info = await lstat(snapshots);
    if (!info.isDirectory()) throw new Error("TEST_STATE_NOT_FRESH");
    for (const entry of await readdir(snapshots, { withFileTypes: true })) {
      if (entry.name.startsWith("solana-")) throw new Error("TEST_STATE_NOT_FRESH");
    }
  }
}

export interface TestReadinessDeps {
  rpcSmoke: (urls: readonly [string, string]) => Promise<unknown>;
  roleKeypairs: (env: NodeJS.ProcessEnv) => Promise<unknown>;
  freshState: (env: NodeJS.ProcessEnv) => Promise<unknown>;
}

const liveDeps: TestReadinessDeps = {
  rpcSmoke: async (urls) => inspectSolanaRpcSmoke([rpcProbe(urls[0]), rpcProbe(urls[1])]),
  freshState: assertFreshSolanaTestState,
  roleKeypairs: async (env) => {
    const creator = await loadKeypair(env.SOLANA_CREATOR_KEYPAIR_PATH!);
    const admin = await loadKeypair((env.SOLANA_ADMIN_KEYPAIR_PATH?.trim() || env.SOLANA_CREATOR_KEYPAIR_PATH)!);
    const operator = await loadKeypair(env.SOLANA_OPERATOR_KEYPAIR_PATH!);
    const holder = await loadKeypair(env.SOLANA_HOLDER_SETTLEMENT_KEYPAIR_PATH!);
    if (creator.publicKey.toBase58() !== env.SOLANA_CREATOR_PUBLIC_KEY
      || admin.publicKey.toBase58() !== env.SOLANA_ADMIN_OWNER
      || operator.publicKey.toBase58() !== env.SOLANA_OPERATOR_PUBLIC_KEY
      || holder.publicKey.toBase58() !== env.SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY) {
      throw new Error("TEST_ROLE_KEYPAIR_MISMATCH");
    }
  },
};

/** Read-only; checks protected keypair identities but never prints, signs or sends them. */
export async function assessSolanaTestReadiness(
  env: NodeJS.ProcessEnv,
  _gates: GateState,
  deps: TestReadinessDeps = liveDeps,
): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const add = (id: string, pass: boolean, code: string) =>
    checks.push({ id, status: pass ? "pass" : "block", code: pass ? "OK" : code });

  add("cluster", env.SOLANA_CLUSTER === "mainnet-beta", "TEST_CLUSTER_UNSUPPORTED");
  add("rpc-version", MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION === 1, "RPC_V1_READS_NOT_PINNED");

  const owner = publicKey(env.SOLANA_ADMIN_OWNER);
  const creator = publicKey(env.SOLANA_CREATOR_PUBLIC_KEY);
  const recovery = publicKey(env.SOLANA_RECOVERY_PUBLIC_KEY);
  const operator = publicKey(env.SOLANA_OPERATOR_PUBLIC_KEY);
  const holder = publicKey(env.SOLANA_HOLDER_SETTLEMENT_PUBLIC_KEY);
  const production = publicKey(env.SOLANA_PRODUCTION_DEPLOYER_PUBLIC_KEY);
  const expectedTest = new PublicKey(EXPECTED_TEST_CREATOR);
  const testRoles = env.SOLANA_SHARED_ADMIN_CREATOR === "true"
    && !!owner?.equals(expectedTest) && !!creator?.equals(expectedTest) && !!recovery?.equals(expectedTest)
    && !!operator && !!holder
    && !operator.equals(expectedTest) && !holder.equals(expectedTest)
    && !operator.equals(holder);
  add("disposable-wallet-roles", testRoles, "TEST_WALLET_ROLES_INVALID");
  const stagingRoles = [owner, creator, recovery, operator, holder];
  add("fresh-test-mint", !env.SOLANA_CAPITAL_MINT?.trim(), "TEST_MINT_ALREADY_CONFIGURED");
  add("official-reward-mint", env.SOLANA_MSTRX_MINT?.trim() === MSTRX_MINT, "MSTRX_MINT_MISSING_OR_MISMATCH");

  const reserve = publicKey(env.SOLANA_RESERVE_SETTLEMENT_PUBLIC_KEY);
  // A production Solana deployer need not exist before an isolated canary.
  // The test creator is hard-pinned; if a production address is already known,
  // reject its reuse anywhere in staging. The operator must never promote the
  // disposable test identity to production later.
  add("production-deployer-excluded", !env.SOLANA_PRODUCTION_DEPLOYER_PUBLIC_KEY?.trim()
    || (!!production && [...stagingRoles, reserve].every((role) => !role?.equals(production))),
  "PRODUCTION_DEPLOYER_IN_STAGING_OR_INVALID");
  add("owner-controlled-test-reserve", !!reserve?.equals(new PublicKey(EXPECTED_TEST_RESERVE))
    && !stagingRoles.some((role) => role?.equals(reserve)), "TEST_RESERVE_WALLET_INVALID");
  const urls = safeRpcUrls(env);
  add("independent-https-rpc", !!urls, "TWO_PRIVATE_RPC_URLS_REQUIRED");
  const keypairPaths = !!env.SOLANA_CREATOR_KEYPAIR_PATH?.trim()
    && !!env.SOLANA_OPERATOR_KEYPAIR_PATH?.trim()
    && !!env.SOLANA_HOLDER_SETTLEMENT_KEYPAIR_PATH?.trim();
  add("role-keypair-paths", keypairPaths, "TEST_ROLE_KEYPAIR_PATHS_MISSING");
  add("holder-journal-path", !!env.SOLANA_HOLDER_JOURNAL_PATH?.trim(), "HOLDER_JOURNAL_PATH_MISSING");

  try {
    await deps.freshState(env);
    checks.push({ id: "fresh-runtime-state", status: "pass", code: "OK" });
  } catch {
    // Filesystem errors may include private host paths. Never surface them.
    checks.push({ id: "fresh-runtime-state", status: "block", code: "TEST_STATE_NOT_FRESH_OR_UNVERIFIED" });
  }

  if (checks.some((check) => check.status === "block")) {
    checks.push({ id: "role-keypair-identities", status: "skipped", code: "STATIC_GATES_BLOCKED" });
  } else {
    try {
      await deps.roleKeypairs(env);
      checks.push({ id: "role-keypair-identities", status: "pass", code: "OK" });
    } catch {
      // Key loading exceptions can contain sensitive file paths. Never surface them.
      checks.push({ id: "role-keypair-identities", status: "block", code: "TEST_ROLE_KEYPAIR_IDENTITY_FAILED" });
    }
  }

  if (checks.some((check) => check.status === "block") || !urls) {
    checks.push({ id: "two-rpc-finalized-full-block-v1", status: "skipped", code: "STATIC_GATES_BLOCKED" });
  } else {
    try {
      // Existing smoke calls getBlock on both providers with
      // maxSupportedTransactionVersion=1 at recent and historical finalized slots.
      await deps.rpcSmoke(urls);
      checks.push({ id: "two-rpc-finalized-full-block-v1", status: "pass", code: "OK" });
    } catch {
      // RPC exceptions may contain authenticated URLs. Never surface them.
      checks.push({ id: "two-rpc-finalized-full-block-v1", status: "block", code: "RPC_FULL_BLOCK_V1_CHECK_FAILED" });
    }
  }

  return {
    phase: "isolated-solana-test-token",
    ready: checks.every((check) => check.status === "pass"),
    checks,
    note: "A passing read-only check does not prove future Pump settings or live fee, payout and migration behavior. The user creates the token; the detector must verify it after creation. The pinned test creator and reserve must never be promoted into production",
  };
}

async function main() {
  const gates = await readReleaseGates();
  const report = await assessSolanaTestReadiness(process.env, gates);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("solana-test-readiness.ts")) {
  void main().catch(() => {
    process.stderr.write("SOLANA_TEST_READINESS_FAILED\n");
    process.exitCode = 1;
  });
}
