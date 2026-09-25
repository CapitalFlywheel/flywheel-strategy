import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSolanaRunnerSingleton } from "./runnerSingleton";

const projectRoot = resolve(process.cwd());
const wrapper = resolve(projectRoot, "scripts/solana-singleton.sh");
const temporaryRoots: string[] = [];
const probes: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(probes.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = awaitExit(child);
      child.kill("SIGKILL");
      await exited;
    }
  }));
  const tempPrefix = resolve(tmpdir(), "solana-singleton-");
  for (const path of temporaryRoots.splice(0)) {
    if (!path.startsWith(tempPrefix)) throw new Error("TEST_TEMP_PATH_OUTSIDE_EXPECTED_ROOT");
    await rm(path, { recursive: true, force: true });
  }
});

describe("Solana runner singleton wiring", () => {
  it("guards both financial process entrypoints in Compose and npm", async () => {
    const [compose, pkg, dockerfile, script, control, indexer] = await Promise.all([
      readFile(resolve(projectRoot, "compose.yaml"), "utf8"),
      readFile(resolve(projectRoot, "package.json"), "utf8"),
      readFile(resolve(projectRoot, "Dockerfile"), "utf8"),
      readFile(wrapper, "utf8"),
      readFile(resolve(projectRoot, "services/solana/controlRunner.ts"), "utf8"),
      readFile(resolve(projectRoot, "services/solana/holderIndexerRunner.ts"), "utf8"),
    ]);
    const commands = JSON.parse(pkg).scripts as Record<string, string>;
    expect(commands["solana:control-runner"]).toBe("sh scripts/solana-singleton.sh control-runner");
    expect(commands["solana:holder-indexer"]).toBe("sh scripts/solana-singleton.sh holder-indexer");
    expect(compose).toContain('command: ["sh", "scripts/solana-singleton.sh", "control-runner"]');
    expect(compose).toContain('command: ["sh", "scripts/solana-singleton.sh", "holder-indexer"]');
    expect(dockerfile).toContain("RUN apk add --no-cache flock");
    expect(script).toContain('lock_root="$state_root/.locks"');
    expect(script).toContain("flock -E 75 -x -w 15 9");
    expect(script).toContain("exec flock -F -n 9 node --import tsx");
    expect(script).toContain('export SOLANA_SINGLETON_GUARD="$service"');
    expect(control).toContain('assertSolanaRunnerSingleton("control-runner")');
    expect(indexer).toContain('assertSolanaRunnerSingleton("holder-indexer")');
    expect(script).not.toMatch(/\brm\s+.*lock_file/);
  });

  it("rejects an unguarded direct financial entrypoint before state access", () => {
    expect(() => assertSolanaRunnerSingleton("control-runner")).toThrow("SOLANA_RUNNER_SINGLETON_REQUIRED");
    expect(() => assertSolanaRunnerSingleton("holder-indexer")).toThrow("SOLANA_RUNNER_SINGLETON_REQUIRED");
  });
});

const hasLinuxFlock = process.platform === "linux" && spawnSync("flock", ["--version"]).status === 0;
const linuxIt = hasLinuxFlock ? it : it.skip;

function probe(root: string, durationMs: number) {
  const child = spawn("sh", [wrapper, "test-probe"], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: "test", SOLANA_STATE_ROOT: root,
      SOLANA_SINGLETON_PROBE_MS: String(durationMs) },
    stdio: "pipe",
  });
  probes.push(child);
  return child;
}

async function awaitAcquired(child: ChildProcessWithoutNullStreams) {
  let output = "";
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`LOCK_ACQUISITION_TIMEOUT:${output}`)), 5_000);
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("SOLANA_SINGLETON_ACQUIRED:control-runner")) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`LOCK_PROBE_EXITED:${code}:${output}`));
    });
  });
}

async function awaitExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

describe("Linux flock lifecycle", () => {
  linuxIt("keeps a second runner out until the first exits and ignores a leftover pathname", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "solana-singleton-"));
    temporaryRoots.push(root);
    const lockRoot = resolve(root, ".locks");
    await mkdir(lockRoot);
    await writeFile(resolve(lockRoot, "control-runner.lock"), "left from previous crash");
    const first = probe(root, 800);
    await awaitAcquired(first);
    const second = probe(root, 50);
    let secondOutput = "";
    second.stderr.on("data", (chunk: Buffer) => { secondOutput += chunk.toString(); });
    await new Promise((delay) => setTimeout(delay, 150));
    expect(secondOutput).not.toContain("SOLANA_SINGLETON_ACQUIRED");
    expect(await awaitExit(first)).toBe(0);
    expect(await awaitExit(second)).toBe(0);
    expect(secondOutput).toContain("SOLANA_SINGLETON_ACQUIRED:control-runner");
  }, 7_000);

  linuxIt("releases the kernel lock after a killed runner without deleting its file", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "solana-singleton-crash-"));
    temporaryRoots.push(root);
    const first = probe(root, 10_000);
    await awaitAcquired(first);
    first.kill("SIGKILL");
    await awaitExit(first);
    const replacement = probe(root, 50);
    await awaitAcquired(replacement);
    expect(await awaitExit(replacement)).toBe(0);
  }, 7_000);
});
