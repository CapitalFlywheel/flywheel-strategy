import { fstatSync, statSync } from "node:fs";
import { resolve } from "node:path";

type SolanaRunnerService = "control-runner" | "holder-indexer";

// This is an accidental-bypass check, not protection against a malicious host
// administrator. The shell wrapper owns descriptor 9 and holds its kernel
// flock while Node is running. Never delete or rotate the lock pathname.
export function assertSolanaRunnerSingleton(service: SolanaRunnerService) {
  if (process.platform !== "linux" || process.env.SOLANA_SINGLETON_GUARD !== service) {
    throw new Error("SOLANA_RUNNER_SINGLETON_REQUIRED");
  }
  try {
    const path = resolve(process.env.SOLANA_STATE_ROOT || "data/solana", ".locks", `${service}.lock`);
    const expected = statSync(path, { bigint: true });
    const inherited = fstatSync(9, { bigint: true });
    if (!expected.isFile() || expected.dev !== inherited.dev || expected.ino !== inherited.ino) {
      throw new Error("SOLANA_RUNNER_SINGLETON_REQUIRED");
    }
  } catch {
    // Do not expose a state-root path or an OS error in a public heartbeat.
    throw new Error("SOLANA_RUNNER_SINGLETON_REQUIRED");
  }
}
