import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { PublicKey } from "@solana/web3.js";

const MAX_REQUEST_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 2_000_000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const WINDOW_MS = 60_000;
const GLOBAL_REQUESTS_PER_WINDOW = 240;
const CLIENT_REQUESTS_PER_WINDOW = 40;
const MAX_CONCURRENT = 8;
const MAX_CLIENTS = 2_048;

type JsonRpcRequest = { jsonrpc: "2.0"; id: string | number; method: string; params: unknown[] };
type RpcReply = { status: number; body: object };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function publicKey(value: unknown) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

function signature(value: unknown) {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value);
}

function slot(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function config(value: unknown, allowedExtra: string[] = []) {
  if (!object(value) || !exactKeys(value, ["commitment", ...allowedExtra]) || value.commitment !== "finalized") return false;
  if ("encoding" in value && value.encoding !== "base64") return false;
  if ("minContextSlot" in value && !slot(value.minContextSlot)) return false;
  return true;
}

/** Only the finalized public reads currently made by this site's wallet/governance views. */
export function validatePublicSolanaRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!object(value) || !exactKeys(value, ["jsonrpc", "id", "method", "params"])
    || value.jsonrpc !== "2.0"
    || !(typeof value.id === "string" && value.id.length <= 64
      || typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id >= 0)
    || typeof value.method !== "string" || !Array.isArray(value.params)) return false;
  const p = value.params;
  switch (value.method) {
    case "getAccountInfo":
      return p.length === 2 && publicKey(p[0]) && config(p[1], ["encoding", "minContextSlot"]);
    case "getMultipleAccounts":
      return p.length === 2 && Array.isArray(p[0]) && p[0].length >= 1 && p[0].length <= 16
        && p[0].every(publicKey) && config(p[1], ["encoding", "minContextSlot"]);
    case "getBlockTime":
      return p.length === 1 && slot(p[0]);
    case "getBlock":
      return p.length === 2 && slot(p[0])
        && config(p[1], ["transactionDetails", "rewards", "maxSupportedTransactionVersion"])
        && (p[1] as Record<string, unknown>).transactionDetails === "none"
        && (p[1] as Record<string, unknown>).rewards === false
        && (p[1] as Record<string, unknown>).maxSupportedTransactionVersion === 1;
    case "getSignaturesForAddress":
      return p.length === 2 && publicKey(p[0]) && config(p[1], ["limit"])
        && slot((p[1] as Record<string, unknown>).limit)
        && Number((p[1] as Record<string, unknown>).limit) >= 1
        && Number((p[1] as Record<string, unknown>).limit) <= 5;
    case "getLatestBlockhash":
    case "getBlockHeight":
      return p.length === 1 && config(p[0]);
    case "getSignatureStatuses":
      return p.length === 2 && Array.isArray(p[0]) && p[0].length === 1 && signature(p[0][0])
        && object(p[1]) && exactKeys(p[1], ["searchTransactionHistory"])
        && p[1].searchTransactionHistory === true;
    default:
      // In particular, sendTransaction, simulateTransaction, getProgramAccounts,
      // subscriptions, batches and arbitrary methods are not public proxy APIs.
      return false;
  }
}

export class PublicSolanaRpcLimiter {
  private global = { count: 0, resetAt: 0 };
  private clients = new Map<string, { count: number; resetAt: number }>();
  private concurrent = 0;

  acquire(client: string, now = Date.now()): (() => void) | undefined {
    if (now >= this.global.resetAt) this.global = { count: 0, resetAt: now + WINDOW_MS };
    if (this.global.count >= GLOBAL_REQUESTS_PER_WINDOW || this.concurrent >= MAX_CONCURRENT) return;
    let entry = this.clients.get(client);
    if (!entry || now >= entry.resetAt) {
      if (this.clients.size >= MAX_CLIENTS) {
        for (const [key, old] of this.clients) if (now >= old.resetAt) this.clients.delete(key);
        if (this.clients.size >= MAX_CLIENTS) return;
      }
      entry = { count: 0, resetAt: now + WINDOW_MS };
      this.clients.set(client, entry);
    }
    if (entry.count >= CLIENT_REQUESTS_PER_WINDOW) return;
    entry.count++;
    this.global.count++;
    this.concurrent++;
    let released = false;
    return () => { if (!released) { this.concurrent--; released = true; } };
  }
}

export const publicSolanaRpcLimit = new PublicSolanaRpcLimiter();

function reply(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function boundedResponse(response: Response) {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) throw new Error("UPSTREAM_TOO_LARGE");
  if (!response.body) throw new Error("UPSTREAM_EMPTY");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("UPSTREAM_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as unknown;
}

export async function forwardPublicSolanaRpc(value: JsonRpcRequest, upstreamUrl: string | undefined,
  fetcher: typeof fetch = fetch): Promise<RpcReply> {
  if (!upstreamUrl) return { status: 503, body: { error: "rpc_unavailable" } };
  let parsed: URL;
  try {
    parsed = new URL(upstreamUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("RPC_URL_INVALID");
  } catch { return { status: 503, body: { error: "rpc_unavailable" } }; }
  try {
    const response = await fetcher(parsed.toString(), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
      redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return { status: 503, body: { error: "rpc_unavailable" } };
    const upstream = await boundedResponse(response);
    if (!object(upstream) || upstream.jsonrpc !== "2.0" || upstream.id !== value.id) throw new Error("UPSTREAM_INVALID");
    if ("error" in upstream) {
      // Never echo provider error text: some providers embed authenticated URLs.
      return { status: 502, body: { jsonrpc: "2.0", id: value.id,
        error: { code: -32000, message: "RPC upstream rejected request" } } };
    }
    if (!("result" in upstream)) throw new Error("UPSTREAM_INVALID");
    return { status: 200, body: { jsonrpc: "2.0", id: value.id, result: upstream.result } };
  } catch { return { status: 503, body: { error: "rpc_unavailable" } }; }
}

export async function handlePublicSolanaRpc(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") return reply(response, 405, { error: "method_not_allowed" });
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return reply(response, 415, { error: "json_required" });
  }
  // A browser on another origin cannot use this as an open JSON-RPC relay.
  const origin = request.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== request.headers.host) return reply(response, 403, { error: "origin_not_allowed" }); }
    catch { return reply(response, 403, { error: "origin_not_allowed" }); }
  }
  // Nginx sets X-Real-IP on the loopback hop; use the socket identity otherwise.
  const remote = request.socket.remoteAddress ?? "unknown";
  const forwarded = request.headers["x-real-ip"];
  const client = (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")
    && typeof forwarded === "string" && forwarded.length <= 64 && isIP(forwarded)
    ? forwarded : remote;
  const release = publicSolanaRpcLimit.acquire(client);
  if (!release) return reply(response, 429, { error: "rpc_rate_limited" });
  try {
    let value: unknown;
    try { value = await requestBody(request); }
    catch { return reply(response, 400, { error: "invalid_json_rpc" }); }
    if (!validatePublicSolanaRpcRequest(value)) return reply(response, 400, { error: "rpc_method_not_allowed" });
    const result = await forwardPublicSolanaRpc(value, process.env.SOLANA_PUBLIC_RPC_UPSTREAM_URL);
    return reply(response, result.status, result.body);
  } finally { release(); }
}
