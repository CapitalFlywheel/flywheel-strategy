const STAGING_ORIGIN = "http://127.0.0.1:8788";
const PUBLIC_ORIGIN = "https://flywheelstrategy.xyz";
const TIMEOUT_MS = 8_000;
const MAX_REPLY_BYTES = 1_024;

type Check = { id: string; status: "pass" | "block"; code: string };
export type StagingWebReadiness = {
  phase: "isolated-solana-staging-web" | "public-solana-web";
  readOnlyRpcReady: boolean;
  voteRelayReleased: boolean;
  voteEndToEndVerified: false;
  checks: Check[];
  note: string;
};

async function smallJsonResponse(response: Response): Promise<unknown> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && Number(advertised) > MAX_REPLY_BYTES) throw new Error("WEB_RPC_REPLY_TOO_LARGE");
  if (!response.body) throw new Error("WEB_RPC_REPLY_EMPTY");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_REPLY_BYTES) throw new Error("WEB_RPC_REPLY_TOO_LARGE");
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(parts.map((part) => Buffer.from(part))).toString("utf8")) as unknown;
}

/** Probes the actual web route, never its private upstream URL. */
export async function inspectSolanaWeb(target: "staging" | "public", fetcher: typeof fetch = fetch): Promise<StagingWebReadiness> {
  const origin = target === "staging" ? STAGING_ORIGIN : PUBLIC_ORIGIN;
  const checks: Check[] = [];
  let rpcReady = false;
  let voteRelayReleased = false;
  try {
    const response = await fetcher(`${origin}/api/solana/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [{ commitment: "finalized" }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 200 && response.headers.get("content-type")?.startsWith("application/json")) {
      const value = await smallJsonResponse(response) as { jsonrpc?: unknown; id?: unknown; result?: unknown };
      rpcReady = value?.jsonrpc === "2.0" && value.id === 1
        && typeof value.result === "number" && Number.isSafeInteger(value.result) && value.result > 0;
    }
  } catch { /* Never return provider text, upstream URL or credentials. */ }
  checks.push({ id: "running-web-finalized-rpc", status: rpcReady ? "pass" : "block",
    code: rpcReady ? "OK" : "WEB_PUBLIC_RPC_UNAVAILABLE" });

  try {
    // GET can never broadcast a transaction. Disabled route returns 503;
    // an enabled route rejects this wrong method with 405.
    const response = await fetcher(`${origin}/api/solana/governance-vote`, {
      method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 405 && response.headers.get("content-type")?.startsWith("application/json")) {
      const body = await smallJsonResponse(response) as { error?: unknown };
      voteRelayReleased = body?.error === "method_not_allowed";
    }
  } catch { /* A failed route is a blocker, not a release signal. */ }
  checks.push({ id: "running-web-vote-relay-release", status: voteRelayReleased ? "pass" : "block",
    code: voteRelayReleased ? "OK" : "WEB_VOTE_RELAY_UNAVAILABLE_OR_DISABLED" });

  return {
    phase: target === "staging" ? "isolated-solana-staging-web" : "public-solana-web",
    readOnlyRpcReady: rpcReady, voteRelayReleased,
    voteEndToEndVerified: false, checks,
    note: "This probes the running web route, including the same-origin RPC relay; it never signs or broadcasts. Even a released vote route does not prove the browser wallet path or finalized onchain voting. Those require an authorized canary and real-device checks",
  };
}

export async function inspectSolanaStagingWeb(fetcher: typeof fetch = fetch) {
  return inspectSolanaWeb("staging", fetcher);
}

async function main() {
  const report = await inspectSolanaWeb(process.argv.includes("--public") ? "public" : "staging");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.readOnlyRpcReady || !report.voteRelayReleased) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("solana-staging-web-readiness.ts")) {
  void main().catch(() => {
    process.stderr.write("SOLANA_STAGING_WEB_READINESS_FAILED\n");
    process.exitCode = 1;
  });
}
