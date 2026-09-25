import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { forwardPublicSolanaRpc, PublicSolanaRpcLimiter, validatePublicSolanaRpcRequest } from "./publicSolanaRpc";

const address = Keypair.generate().publicKey.toBase58();
const request = (method: string, params: unknown[]) => ({ jsonrpc: "2.0" as const, id: 1, method, params });

describe("public Solana JSON-RPC relay", () => {
  it("allows only the bounded finalized reads used by governance and vote status", () => {
    expect(validatePublicSolanaRpcRequest(request("getAccountInfo", [address, { encoding: "base64", commitment: "finalized" }]))).toBe(true);
    expect(validatePublicSolanaRpcRequest(request("getMultipleAccounts", [[address], { encoding: "base64", commitment: "finalized" }]))).toBe(true);
    // Matches governanceClient.getBlock exactly, including v1 transaction support.
    expect(validatePublicSolanaRpcRequest(request("getBlock", [123, {
      commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 1,
    }]))).toBe(true);
    expect(validatePublicSolanaRpcRequest(request("getLatestBlockhash", [{ commitment: "finalized" }]))).toBe(true);
    expect(validatePublicSolanaRpcRequest(request("getSignatureStatuses", [["1".repeat(88)], { searchTransactionHistory: true }]))).toBe(true);
    expect(validatePublicSolanaRpcRequest(request("getBlockHeight", [{ commitment: "finalized" }]))).toBe(true);
  });

  it("rejects writes, batches, broad scans, weaker commitments and arbitrary options", () => {
    expect(validatePublicSolanaRpcRequest(request("sendTransaction", ["base64transaction", {}]))).toBe(false);
    expect(validatePublicSolanaRpcRequest(request("getProgramAccounts", [address]))).toBe(false);
    expect(validatePublicSolanaRpcRequest([request("getAccountInfo", [address, { commitment: "finalized" }])])).toBe(false);
    expect(validatePublicSolanaRpcRequest(request("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "finalized" }]))).toBe(false);
    expect(validatePublicSolanaRpcRequest(request("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]))).toBe(false);
    expect(validatePublicSolanaRpcRequest(request("getBlock", [123, { commitment: "finalized", transactionDetails: "full", rewards: false }]))).toBe(false);
    expect(validatePublicSolanaRpcRequest(request("getBlock", [123, { commitment: "finalized", transactionDetails: "signatures", rewards: false }]))).toBe(false);
    expect(validatePublicSolanaRpcRequest(request("getBlock", [123, { commitment: "finalized", transactionDetails: "none", rewards: false }]))).toBe(false);
    expect(validatePublicSolanaRpcRequest(request("getBlock", [123, {
      commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0,
    }]))).toBe(false);
    expect(validatePublicSolanaRpcRequest(request("getBlock", [123, {
      commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 1, encoding: "jsonParsed",
    }]))).toBe(false);
    expect(validatePublicSolanaRpcRequest(request("getSignaturesForAddress", [address, { commitment: "finalized", limit: 1000 }]))).toBe(false);
  });

  it("never reflects authenticated upstream URL or provider error text", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
      error: { code: -32000, message: "key leaked: https://rpc.example/private-token" } }), { status: 200 }));
    const result = await forwardPublicSolanaRpc(request("getBlockHeight", [{ commitment: "finalized" }]),
      "https://rpc.example/private-token", fetcher);
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain("private-token");
    expect(fetcher).toHaveBeenCalledWith("https://rpc.example/private-token", expect.objectContaining({ redirect: "error" }));
  });

  it("fails closed on missing upstream, redirects, mismatched IDs and oversized responses", async () => {
    const valid = request("getBlockHeight", [{ commitment: "finalized" }]);
    expect((await forwardPublicSolanaRpc(valid, undefined)).status).toBe(503);
    expect((await forwardPublicSolanaRpc(valid, "http://insecure.example")).status).toBe(503);
    expect((await forwardPublicSolanaRpc(valid, "https://rpc.example", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 5 }), { status: 200 })))).status).toBe(503);
    expect((await forwardPublicSolanaRpc(valid, "https://rpc.example", vi.fn().mockResolvedValue(
      new Response("x".repeat(2_000_001), { status: 200 })))).status).toBe(503);
  });

  it("enforces per-client and global concurrency budgets", () => {
    const limiter = new PublicSolanaRpcLimiter();
    const releases = Array.from({ length: 8 }, (_, index) => limiter.acquire(`client-${index}`, 100));
    expect(releases.every(Boolean)).toBe(true);
    expect(limiter.acquire("ninth", 100)).toBeUndefined();
    releases.forEach((release) => release?.());
    for (let index = 0; index < 40; index++) {
      const release = limiter.acquire("single", 100);
      expect(release).toBeTypeOf("function");
      release?.();
    }
    expect(limiter.acquire("single", 100)).toBeUndefined();
    expect(limiter.acquire("single", 60_101)).toBeTypeOf("function");
  });
});
