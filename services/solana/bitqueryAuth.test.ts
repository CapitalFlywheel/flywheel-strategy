import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BitqueryOAuthTokenSource, bitqueryAuthFromEnv } from "./bitqueryAuth";
import { BitqueryTransferSource } from "./bitqueryTransferSource";

afterEach(() => vi.unstubAllGlobals());

function tokenResponse(token: string, expiresIn = 100) {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "bearer", scope: "api" }), { status: 200 });
}

describe("Bitquery bearer authentication", () => {
  it("requests client-credentials tokens, shares a concurrent refresh and renews before expiry", async () => {
    let now = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      const body = options?.body;
      expect(body).toBeInstanceOf(URLSearchParams);
      expect((body as URLSearchParams).get("grant_type")).toBe("client_credentials");
      expect((body as URLSearchParams).get("client_id")).toBe("client-id");
      expect((body as URLSearchParams).get("client_secret")).toBe("client-secret");
      expect((body as URLSearchParams).get("scope")).toBe("api");
      return tokenResponse(`token-${fetchMock.mock.calls.length}`);
    });
    const auth = new BitqueryOAuthTokenSource("client-id", "client-secret", fetchMock as typeof fetch, () => now);
    expect(await Promise.all([auth.getToken(), auth.getToken()])).toEqual(["token-1", "token-1"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    now = 89_999;
    expect(await auth.getToken()).toBe("token-1");
    now = 90_000;
    expect(await auth.getToken()).toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a static token only when no OAuth credentials are configured", async () => {
    expect(bitqueryAuthFromEnv({ BITQUERY_API_KEY: "static-token" })).toBe("static-token");
    expect(bitqueryAuthFromEnv({ BITQUERY_CLIENT_ID: "id", BITQUERY_CLIENT_SECRET: "secret", BITQUERY_API_KEY: "static-token" }))
      .toBeInstanceOf(BitqueryOAuthTokenSource);
    expect(() => bitqueryAuthFromEnv({ BITQUERY_CLIENT_ID: "id", BITQUERY_API_KEY: "static-token" }))
      .toThrow("BITQUERY_OAUTH_CREDENTIALS_INCOMPLETE");
    expect(() => bitqueryAuthFromEnv({})).toThrow("BITQUERY_AUTH_REQUIRED");
  });

  it("fails closed with sanitized errors on transport and invalid token responses", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => { throw new Error("client-secret https://oauth2.bitquery.io/oauth2/token"); });
    const auth = new BitqueryOAuthTokenSource("client-id", "client-secret", fetchMock as typeof fetch);
    await expect(auth.getToken()).rejects.toThrow("BITQUERY_OAUTH_TRANSPORT_FAILED");
    await expect(auth.getToken()).rejects.not.toThrow(/client-secret|https:/);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ access_token: "bad token", expires_in: 100, token_type: "bearer", scope: "api" })));
    await expect(auth.getToken()).rejects.toThrow("BITQUERY_OAUTH_RESPONSE_INVALID");
  });

  it("refreshes once on a 401 before continuing a transfer scan", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    let authRequests = 0;
    let graphqlRequests = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).includes("oauth2.bitquery.io")) {
        authRequests += 1;
        return tokenResponse(`token-${authRequests}`);
      }
      graphqlRequests += 1;
      const headers = options?.headers as Record<string, string>;
      if (graphqlRequests === 1) {
        expect(headers.Authorization).toBe("Bearer token-1");
        return new Response("", { status: 401 });
      }
      expect(headers.Authorization).toBe("Bearer token-2");
      const query = JSON.parse(String(options?.body)).query as string;
      if (query.includes("TransferCoverage")) {
        return new Response(JSON.stringify({ data: { Solana: { Transfers: [{ Block: {
          oldest: new Date(50_000).toISOString(), newest: new Date(250_000).toISOString(),
        } }] } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { Solana: { Transfers: [] } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const auth = new BitqueryOAuthTokenSource("client-id", "client-secret", globalThis.fetch);
    const rows = await new BitqueryTransferSource(auth).discover(mint, 100, 200);
    expect(rows).toEqual([]);
    expect(authRequests).toBe(2);
    expect(graphqlRequests).toBe(3);
  });
});
