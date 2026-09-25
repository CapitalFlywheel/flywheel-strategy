import { describe, expect, it, vi } from "vitest";
import { inspectSolanaStagingWeb, inspectSolanaWeb } from "./solana-staging-web-readiness";

function rpcResponse(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200, headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("running staging web readiness", () => {
  it("probes the finalized RPC, signed-vote API and disabled historical transaction route", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(rpcResponse(123))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ballot: null }), {
        status: 200, headers: { "content-type": "application/json; charset=utf-8" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "vote_disabled" }), { status: 503 }));
    const report = await inspectSolanaStagingWeb(fetcher);
    expect(report.readOnlyRpcReady).toBe(true);
    expect(report.offchainVotingApiReady).toBe(true);
    expect(report.legacyTransactionVoteDisabled).toBe(true);
    expect(report.voteEndToEndVerified).toBe(false);
    expect(fetcher).toHaveBeenNthCalledWith(1, "http://127.0.0.1:8788/api/solana/rpc", expect.objectContaining({
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight",
        params: [{ commitment: "finalized" }] }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "http://127.0.0.1:8788/api/solana/offchain-governance",
      expect.objectContaining({ method: "GET" }));
    expect(fetcher).toHaveBeenNthCalledWith(3, "http://127.0.0.1:8788/api/solana/governance-vote",
      expect.objectContaining({ method: "GET" }));
  });

  it("reports a missing web upstream or offchain API with fixed codes only", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("https://secret-upstream.example/key", { status: 503 }))
      .mockResolvedValueOnce(new Response("provider-secret", { status: 503 }))
      .mockResolvedValueOnce(new Response("disabled", { status: 503 }));
    const report = await inspectSolanaStagingWeb(fetcher);
    expect(report.readOnlyRpcReady).toBe(false);
    expect(report.offchainVotingApiReady).toBe(false);
    expect(report.legacyTransactionVoteDisabled).toBe(true);
    expect(report.checks.map((check) => check.code)).toEqual([
      "WEB_PUBLIC_RPC_UNAVAILABLE", "WEB_OFFCHAIN_VOTE_API_UNAVAILABLE", "OK",
    ]);
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("rejects malformed or oversized RPC replies and does not mistake an outage for voting release", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("x".repeat(1_025), { status: 200 }))
      .mockRejectedValueOnce(new Error("https://private-provider.example/token"))
      .mockResolvedValueOnce(new Response("disabled", { status: 503 }));
    const report = await inspectSolanaStagingWeb(fetcher);
    expect(report.readOnlyRpcReady).toBe(false);
    expect(report.offchainVotingApiReady).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private-provider");
  });

  it("detects an HTML SPA fallback on the canonical public API route", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("<!doctype html><html></html>", {
        status: 200, headers: { "content-type": "text/html" },
      }))
      .mockResolvedValueOnce(new Response("<!doctype html><html></html>", { status: 200 }))
      .mockResolvedValueOnce(new Response("<!doctype html><html></html>", { status: 200 }));
    const report = await inspectSolanaWeb("public", fetcher);
    expect(report.phase).toBe("public-solana-web");
    expect(report.readOnlyRpcReady).toBe(false);
    expect(report.offchainVotingApiReady).toBe(false);
    expect(report.legacyTransactionVoteDisabled).toBe(false);
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://flywheelstrategy.xyz/api/solana/rpc", expect.any(Object));
    expect(JSON.stringify(report)).not.toContain("<html>");
  });

  it("does not mistake a generic proxy 405 for the exact offchain vote handler", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(rpcResponse(123))
      .mockResolvedValueOnce(new Response("Method Not Allowed", { status: 405 }))
      .mockResolvedValueOnce(new Response("disabled", { status: 503 }));
    const report = await inspectSolanaStagingWeb(fetcher);
    expect(report.readOnlyRpcReady).toBe(true);
    expect(report.offchainVotingApiReady).toBe(false);
  });
});
