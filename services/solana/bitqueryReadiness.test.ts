import { afterEach, describe, expect, it, vi } from "vitest";
import { probeBitqueryLaunchReadiness } from "./bitqueryReadiness";
import { BitqueryTransferSource } from "./bitqueryTransferSource";

const nowSeconds = 10_000;
const nowMs = nowSeconds * 1_000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function coverage(oldest: number, newest: number) {
  return new Response(JSON.stringify({ data: { Solana: { Transfers: [{ Block: {
    oldest: new Date(oldest * 1_000).toISOString(),
    newest: new Date(newest * 1_000).toISOString(),
  } }] } } }), { status: 200 });
}

describe("Bitquery prelaunch readiness", () => {
  it("authenticates with OAuth and runs only a small global coverage query", async () => {
    vi.stubEnv("BITQUERY_CLIENT_ID", "client-id");
    vi.stubEnv("BITQUERY_CLIENT_SECRET", "client-secret");
    vi.stubEnv("BITQUERY_API_KEY", "");
    const fetchMock = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).includes("oauth2.bitquery.io")) {
        expect((options?.body as URLSearchParams).get("scope")).toBe("api");
        return new Response(JSON.stringify({ access_token: "oauth-token", expires_in: 3_600, token_type: "bearer", scope: "api" }));
      }
      expect((options?.headers as Record<string, string>).Authorization).toBe("Bearer oauth-token");
      expect(JSON.parse(String(options?.body)).query).toContain("TransferCoverage");
      return coverage(nowSeconds - 3_601, nowSeconds - 300);
    });
    vi.stubGlobal("fetch", fetchMock);
    await probeBitqueryLaunchReadiness(undefined, nowMs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [nowSeconds - 3_599, nowSeconds - 300, "TRANSFER_SOURCE_HISTORY_UNAVAILABLE"],
    [nowSeconds - 3_601, nowSeconds - 302, "TRANSFER_SOURCE_TAIL_UNAVAILABLE"],
  ])("fails closed when realtime coverage cannot span the required window", async (oldest, newest, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => coverage(oldest, newest)));
    await expect(probeBitqueryLaunchReadiness(new BitqueryTransferSource("test-key"), nowMs)).rejects.toThrow(code);
  });

  it("cannot pass without working credentials", async () => {
    vi.stubEnv("BITQUERY_CLIENT_ID", "");
    vi.stubEnv("BITQUERY_CLIENT_SECRET", "");
    vi.stubEnv("BITQUERY_API_KEY", "");
    await expect(probeBitqueryLaunchReadiness(undefined, nowMs)).rejects.toThrow("BITQUERY_AUTH_REQUIRED");
    vi.stubEnv("BITQUERY_CLIENT_ID", "client-id");
    vi.stubEnv("BITQUERY_CLIENT_SECRET", "client-secret");
    const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeBitqueryLaunchReadiness(undefined, nowMs)).rejects.toThrow("BITQUERY_OAUTH_HTTP_401");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
