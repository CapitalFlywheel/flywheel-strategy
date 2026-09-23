const OAUTH_TOKEN_URL = "https://oauth2.bitquery.io/oauth2/token";

export interface BitqueryBearerTokenSource {
  getToken(): Promise<string>;
  invalidate?(): void;
}

interface OAuthResponse {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
}

export class BitqueryOAuthTokenSource implements BitqueryBearerTokenSource {
  private cached?: { token: string; usableUntil: number };
  private pending?: Promise<string>;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (!clientId.trim() || !clientSecret.trim()) throw new Error("BITQUERY_OAUTH_CREDENTIALS_REQUIRED");
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.usableUntil) return this.cached.token;
    if (!this.pending) {
      this.pending = this.refresh().finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async refresh(): Promise<string> {
    const requestedAt = this.now();
    let response: Response;
    try {
      response = await this.fetcher(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope: "api",
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("BITQUERY_OAUTH_TRANSPORT_FAILED");
    }
    if (!response.ok) throw new Error(`BITQUERY_OAUTH_HTTP_${response.status}`);

    let data: OAuthResponse;
    try {
      data = await response.json() as OAuthResponse;
    } catch {
      throw new Error("BITQUERY_OAUTH_RESPONSE_INVALID");
    }
    const token = data?.access_token;
    const seconds = data?.expires_in;
    if (typeof token !== "string" || !token.trim() || /[\s\x00-\x1f]/.test(token)
      || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0
      || String(data?.token_type).toLowerCase() !== "bearer"
      || typeof data?.scope !== "string" || !data.scope.split(/\s+/).includes("api")) {
      throw new Error("BITQUERY_OAUTH_RESPONSE_INVALID");
    }
    const lifetimeMs = seconds * 1_000;
    if (!Number.isSafeInteger(lifetimeMs)) throw new Error("BITQUERY_OAUTH_RESPONSE_INVALID");
    const safetyMs = Math.min(60_000, lifetimeMs * 0.1);
    this.cached = { token, usableUntil: requestedAt + lifetimeMs - safetyMs };
    return token;
  }
}

export function bitqueryAuthFromEnv(env: NodeJS.ProcessEnv = process.env): string | BitqueryBearerTokenSource {
  const clientId = env.BITQUERY_CLIENT_ID?.trim();
  const clientSecret = env.BITQUERY_CLIENT_SECRET?.trim();
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) throw new Error("BITQUERY_OAUTH_CREDENTIALS_INCOMPLETE");
    return new BitqueryOAuthTokenSource(clientId, clientSecret);
  }
  const apiKey = env.BITQUERY_API_KEY?.trim();
  if (!apiKey) throw new Error("BITQUERY_AUTH_REQUIRED");
  return apiKey;
}
