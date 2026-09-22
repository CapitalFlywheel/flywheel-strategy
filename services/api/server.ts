import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toBytes,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import {
  normalizePostlaunchManifest,
  normalizePrelaunchManifest,
  verifyPostlaunchManifest,
  verifyPrelaunchManifest,
} from "../admin/launchManifest";
import { normalizeGovernanceDraft } from "../admin/governanceDraft";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

const port = Number(process.env.PORT || "8787");
const staticRoot = resolve(process.env.WEB_STATIC_ROOT || "dist/web");
const publicDataRoot = resolve(process.env.PUBLIC_DATA_ROOT || "data/public");
const controlDataRoot = resolve(process.env.CONTROL_DATA_ROOT || "data/control");
const adminOwner = process.env.ADMIN_OWNER_ADDRESS
  ? getAddress(process.env.ADMIN_OWNER_ADDRESS)
  : undefined;
const reserveVault = process.env.RESERVE_VAULT_ADDRESS
  ? getAddress(process.env.RESERVE_VAULT_ADDRESS)
  : undefined;
const mstrToken = process.env.VITE_MSTR_ADDRESS
  ? getAddress(process.env.VITE_MSTR_ADDRESS)
  : undefined;
const wethToken = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const v3Quoter = getAddress("0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7");
const reserveQuoteAbi = parseAbi(["function availableBalance() view returns (uint256)"]);
const erc20QuoteAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const adminPanelPath = (() => {
  const value = process.env.ADMIN_PANEL_PATH?.trim().replace(/\/$/, "");
  if (!value) return undefined;
  if (!/^\/[a-zA-Z0-9_-]{16,120}$/.test(value) || value === "/admin") {
    throw new Error("ADMIN_PANEL_PATH must be an unlisted path with at least 16 letters, numbers, dashes or underscores");
  }
  return value;
})();
const solanaAdminApiRoot = adminPanelPath ? `${adminPanelPath}/api/solana` : undefined;
const allowedAdminActions = new Set([
  "start_automation", "stop_automation", "register_prelaunch", "arm_launch_detection",
  "cancel_launch_detection", "activate_postlaunch", "prepare_governance",
]);
const solanaAdminOwner = (() => {
  const value = process.env.SOLANA_ADMIN_OWNER?.trim();
  if (!value) return undefined;
  return new PublicKey(value).toBase58();
})();
const allowedSolanaActions = new Set([
  "verify_launch_config", "arm_launch_detection", "disarm_launch_detection", "activate_postlaunch",
  "sweep_curve_fees", "sweep_pumpswap_fees", "pause_conversions", "resume_conversions",
  "recover_uncommitted",
  "prepare_reward_epoch", "distribute_reward_epoch", "finalize_reward_epoch",
]);
const challenges = new Map<string, { action: string; message: string; expiresAt: number; payload?: unknown }>();
const solanaChallenges = new Map<string, { action: string; message: string; expiresAt: number }>();
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function safePath(root: string, pathname: string): string | undefined {
  const target = resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return;
  return target;
}

async function fileResponse(path: string) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("NOT_FILE");
  return readFile(path);
}

function jsonResponse(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function verifiedReserveQuote(requestedAmount?: bigint) {
  const primaryUrl = process.env.ROBINHOOD_RPC_URL?.trim();
  const fallbackUrl = process.env.ROBINHOOD_RPC_FALLBACK_URL?.trim();
  if (!primaryUrl || !fallbackUrl || !reserveVault || !mstrToken || !adminOwner) {
    return { ok: false, reason: "quote_providers_unavailable" } as const;
  }

  const clients = [
    createPublicClient({ transport: http(primaryUrl, { timeout: 12_000 }) }),
    createPublicClient({ transport: http(fallbackUrl, { timeout: 12_000 }) }),
  ];
  const latest = await Promise.all(clients.map((client) => client.getBlockNumber()));
  const commonBlock = (latest[0] < latest[1] ? latest[0] : latest[1]) - 2n;
  if (commonBlock <= 0n || (latest[0] > latest[1] ? latest[0] - latest[1] : latest[1] - latest[0]) > 8n) {
    return { ok: false, reason: "quote_providers_out_of_sync" } as const;
  }

  const blocks = await Promise.all(clients.map((client) => client.getBlock({ blockNumber: commonBlock })));
  if (!blocks[0].hash || blocks[0].hash !== blocks[1].hash) {
    return { ok: false, reason: "quote_block_disagreement" } as const;
  }

  const snapshots = await Promise.all(clients.map(async (client) => {
    const available = await client.readContract({
      address: reserveVault,
      abi: reserveQuoteAbi,
      functionName: "availableBalance",
      blockNumber: commonBlock,
    });
    const walletMstr = await client.readContract({
      address: mstrToken,
      abi: erc20QuoteAbi,
      functionName: "balanceOf",
      args: [adminOwner],
      blockNumber: commonBlock,
    });
    const amountIn = requestedAmount ?? (available > 0n ? available : walletMstr);
    if (amountIn < 0n || (available > 0n ? amountIn !== available : amountIn > walletMstr)) {
      throw new Error("QUOTE_AMOUNT_INVALID");
    }
    if (amountIn === 0n) return { available, walletMstr, amountIn, amountOut: 0n };
    const path = encodePacked(["address", "uint24", "address"], [mstrToken, 10_000, wethToken]);
    const data = encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactInput", args: [path, amountIn] });
    const result = await client.call({ to: v3Quoter, data, blockNumber: commonBlock });
    if (!result.data) throw new Error("QUOTE_EMPTY");
    const amountOut = decodeFunctionResult({ abi: quoterAbi, functionName: "quoteExactInput", data: result.data })[0];
    return { available, walletMstr, amountIn, amountOut };
  }));

  const [left, right] = snapshots;
  if (left.available !== right.available || left.walletMstr !== right.walletMstr
    || left.amountIn !== right.amountIn || left.amountOut !== right.amountOut) {
    return { ok: false, reason: "quote_state_disagreement" } as const;
  }

  return {
    ok: true,
    blockNumber: commonBlock.toString(),
    blockHash: blocks[0].hash,
    source: left.available > 0n && left.amountIn === left.available ? "reserve" : "admin_wallet",
    amountIn: left.amountIn.toString(),
    amountOut: left.amountOut.toString(),
    providers: 2,
  } as const;
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function cleanChallenges(now = Date.now()) {
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAt < now) challenges.delete(id);
  }
  for (const [id, challenge] of solanaChallenges) {
    if (challenge.expiresAt < now) solanaChallenges.delete(id);
  }
}

function adminChallenge(action: string, payload?: unknown) {
  if (!adminOwner || !allowedAdminActions.has(action)) return;
  cleanChallenges();
  if (challenges.size >= 500) challenges.delete(challenges.keys().next().value as string);
  const id = randomBytes(20).toString("hex");
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 5 * 60_000;
  const readableActions: Record<string, string> = {
    start_automation: "START AUTOMATION",
    stop_automation: "STOP AUTOMATION",
    register_prelaunch: "REGISTER PRELAUNCH CONTRACTS",
    arm_launch_detection: "ARM PONS LAUNCH DETECTION",
    cancel_launch_detection: "CANCEL PONS LAUNCH DETECTION",
    activate_postlaunch: "ACTIVATE NEW PROJECT",
    prepare_governance: "PREPARE GOVERNANCE PROPOSAL",
  };
  const payloadHash = payload === undefined ? undefined : keccak256(toBytes(JSON.stringify(payload)));
  const message = [
    "MSTR SYSTEM ADMIN",
    `Action: ${readableActions[action]}`,
    `Owner: ${adminOwner}`,
    "Chain: Robinhood Chain (4663)",
    ...(payloadHash ? [`Payload: ${payloadHash}`] : []),
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    `Nonce: ${id}`,
  ].join("\n");
  challenges.set(id, { action, message, expiresAt, payload });
  return { id, action, message, expiresAt, owner: adminOwner };
}

async function queueAdminAction(challengeId: string, signature: Hex) {
  if (!adminOwner) throw new Error("ADMIN_DISABLED");
  cleanChallenges();
  const challenge = challenges.get(challengeId);
  if (!challenge) throw new Error("CHALLENGE_INVALID");
  challenges.delete(challengeId);
  const valid = await verifyMessage({ address: adminOwner as Address, message: challenge.message, signature });
  if (!valid) throw new Error("SIGNATURE_INVALID");

  let payload = challenge.payload;
  if (challenge.action === "register_prelaunch") {
    const normalized = normalizePrelaunchManifest(payload, adminOwner);
    await verifyPrelaunchManifest(normalized);
    payload = normalized;
  } else if (challenge.action === "activate_postlaunch") {
    const normalized = normalizePostlaunchManifest(payload, adminOwner);
    await verifyPostlaunchManifest(normalized);
    payload = normalized;
  } else if (challenge.action === "prepare_governance") {
    payload = normalizeGovernanceDraft(payload);
  }

  const queueDir = resolve(controlDataRoot, "requests");
  await mkdir(queueDir, { recursive: true });
  const requestId = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  await writeFile(resolve(queueDir, `${requestId}.json`), JSON.stringify({
    id: requestId,
    action: challenge.action,
    signer: adminOwner,
    requestedAt: Date.now(),
    ...(payload === undefined ? {} : { payload }),
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { ok: true, requestId, action: challenge.action };
}

function solanaAdminChallenge(action: string) {
  if (!solanaAdminOwner || !allowedSolanaActions.has(action)) return;
  cleanChallenges();
  const id = randomBytes(20).toString("hex");
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 5 * 60_000;
  const message = [
    "FLYWHEEL STRATEGY SOLANA CONTROL",
    `Action: ${action}`,
    `Owner: ${solanaAdminOwner}`,
    "Network: Solana Mainnet Beta",
    "Allocation: 60% holders / 40% strategic reserve",
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    `Nonce: ${id}`,
  ].join("\n");
  solanaChallenges.set(id, { action, message, expiresAt });
  return { id, action, message, expiresAt, owner: solanaAdminOwner };
}

async function queueSolanaAdminAction(challengeId: string, signer: string, signature: string) {
  if (!solanaAdminOwner) throw new Error("ADMIN_DISABLED");
  const challenge = solanaChallenges.get(challengeId);
  if (!challenge || challenge.expiresAt < Date.now()) throw new Error("CHALLENGE_INVALID");
  solanaChallenges.delete(challengeId);
  const normalizedSigner = new PublicKey(signer).toBase58();
  if (normalizedSigner !== solanaAdminOwner) throw new Error("SIGNER_NOT_OWNER");
  let signatureBytes: Uint8Array;
  try { signatureBytes = bs58.decode(signature); } catch { throw new Error("SIGNATURE_INVALID"); }
  const valid = nacl.sign.detached.verify(
    new TextEncoder().encode(challenge.message),
    signatureBytes,
    new PublicKey(normalizedSigner).toBytes(),
  );
  if (!valid) throw new Error("SIGNATURE_INVALID");

  const queueDir = resolve(controlDataRoot, "solana-requests");
  await mkdir(queueDir, { recursive: true });
  const requestId = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  await writeFile(resolve(queueDir, `${requestId}.json`), JSON.stringify({
    id: requestId,
    network: "solana-mainnet-beta",
    action: challenge.action,
    signer: normalizedSigner,
    requestedAt: Date.now(),
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { ok: true, requestId, action: challenge.action };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      return jsonResponse(response, 200, { ok: true, timestamp: Date.now() });
    }

    if (solanaAdminApiRoot && url.pathname === `${solanaAdminApiRoot}/status` && request.method === "GET") {
      try {
        const body = JSON.parse(await readFile(resolve(controlDataRoot, "solana-status.json"), "utf8"));
        return jsonResponse(response, 200, { ...body, network: "solana-mainnet-beta", owner: solanaAdminOwner });
      } catch {
        return jsonResponse(response, 200, {
          network: "solana-mainnet-beta",
          owner: solanaAdminOwner,
          automationState: "stopped",
          launch: { configured: false, armed: false, activated: false },
          services: {},
          balances: {},
          updatedAt: 0,
        });
      }
    }

    if (solanaAdminApiRoot && url.pathname === `${solanaAdminApiRoot}/challenge` && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (typeof body.action !== "string" || Object.keys(body).some((key) => key !== "action")) {
          return jsonResponse(response, 400, { error: "invalid_request" });
        }
        const challenge = solanaAdminChallenge(body.action);
        return challenge
          ? jsonResponse(response, 200, challenge)
          : jsonResponse(response, 400, { error: solanaAdminOwner ? "action_not_allowed" : "admin_disabled" });
      } catch {
        return jsonResponse(response, 400, { error: "invalid_request" });
      }
    }

    if (solanaAdminApiRoot && url.pathname === `${solanaAdminApiRoot}/action` && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (typeof body.challengeId !== "string" || typeof body.signer !== "string" || typeof body.signature !== "string"
          || Object.keys(body).some((key) => !["challengeId", "signer", "signature"].includes(key))) {
          return jsonResponse(response, 400, { error: "invalid_request" });
        }
        const queued = await queueSolanaAdminAction(body.challengeId, body.signer, body.signature);
        return jsonResponse(response, 202, queued);
      } catch (error) {
        const code = error instanceof Error ? error.message : "ACTION_FAILED";
        return jsonResponse(response, ["SIGNATURE_INVALID", "SIGNER_NOT_OWNER"].includes(code) ? 403 : 400, { error: code.toLowerCase() });
      }
    }

    if (url.pathname === "/admin/api/status" && request.method === "GET") {
      let activated = false;
      try {
        await stat(resolve(controlDataRoot, "main-launch", "postlaunch.json"));
        activated = true;
      } catch {
        activated = false;
      }
      try {
        const body = JSON.parse(await readFile(resolve(controlDataRoot, "status.json"), "utf8"));
        return jsonResponse(response, 200, { ...body, owner: adminOwner, activated });
      } catch {
        return jsonResponse(response, 200, {
          automationState: "unknown",
          services: {},
          updatedAt: 0,
          owner: adminOwner,
          activated,
        });
      }
    }

    if (url.pathname === "/admin/api/reserve-quote" && request.method === "GET") {
      try {
        const amountRaw = url.searchParams.get("amount");
        if (amountRaw && !/^\d{1,78}$/.test(amountRaw)) {
          return jsonResponse(response, 400, { ok: false, reason: "quote_amount_invalid" });
        }
        const quote = await verifiedReserveQuote(amountRaw ? BigInt(amountRaw) : undefined);
        return jsonResponse(response, quote.ok ? 200 : 503, quote);
      } catch {
        return jsonResponse(response, 503, { ok: false, reason: "quote_verification_failed" });
      }
    }

    if (url.pathname === "/admin/api/launch-state" && request.method === "GET") {
      const launchRoot = resolve(controlDataRoot, "main-launch");
      const readOptional = async (name: string) => {
        try { return JSON.parse(await readFile(resolve(launchRoot, name), "utf8")); } catch { return undefined; }
      };
      const [prelaunch, armed, detected, postlaunch] = await Promise.all([
        readOptional("prelaunch.json"), readOptional("armed.json"),
        readOptional("detected.json"), readOptional("postlaunch.json"),
      ]);
      return jsonResponse(response, 200, {
        prelaunchRegistered: Boolean(prelaunch),
        creatorWallet: prelaunch?.ponsFeeCollector,
        armed: Boolean(armed) && !detected,
        detected,
        activated: Boolean(postlaunch),
      });
    }

    if (url.pathname === "/admin/api/governance-prepared" && request.method === "GET") {
      try {
        const body = JSON.parse(await readFile(resolve(controlDataRoot, "governance-prepared.json"), "utf8"));
        return jsonResponse(response, 200, body);
      } catch {
        return jsonResponse(response, 200, { status: "none" });
      }
    }

    if (url.pathname === "/admin/api/challenge" && request.method === "GET") {
      const challenge = adminChallenge(url.searchParams.get("action") || "");
      return challenge
        ? jsonResponse(response, 200, challenge)
        : jsonResponse(response, 400, { error: "action_not_allowed" });
    }


    if (url.pathname === "/admin/api/challenge" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (typeof body.action !== "string") return jsonResponse(response, 400, { error: "invalid_request" });
        const challenge = adminChallenge(body.action, body.payload);
        return challenge
          ? jsonResponse(response, 200, challenge)
          : jsonResponse(response, 400, { error: "action_not_allowed" });
      } catch {
        return jsonResponse(response, 400, { error: "invalid_request" });
      }
    }

    if (url.pathname === "/admin/api/action" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (typeof body.challengeId !== "string" || typeof body.signature !== "string") {
          return jsonResponse(response, 400, { error: "invalid_request" });
        }
        const queued = await queueAdminAction(body.challengeId, body.signature as Hex);
        return jsonResponse(response, 202, queued);
      } catch (error) {
        const code = error instanceof Error ? error.message : "action_failed";
        return jsonResponse(response, code === "SIGNATURE_INVALID" ? 403 : 400, { error: code.toLowerCase() });
      }
    }

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      throw new Error("NOT_FOUND");
    }

    if (adminPanelPath && url.pathname.replace(/\/$/, "") === adminPanelPath && request.method === "GET") {
      const template = await readFile(resolve(staticRoot, "index.html"), "utf8");
      const apiRoot = JSON.stringify(`${adminPanelPath}/api`);
      const body = template.replace("</head>", `<script>window.__FLYWHEEL_ADMIN__=true;window.__FLYWHEEL_ADMIN_API__=${apiRoot}</script></head>`);
      response.writeHead(200, {
        "content-type": mimeTypes[".html"],
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      return response.end(body);
    }

    const dynamic = url.pathname === "/config.json" || url.pathname.startsWith("/snapshots/")
      || (url.pathname.startsWith("/governance/") && url.pathname.endsWith(".json"))
      || url.pathname.startsWith("/status/");
    const root = dynamic ? publicDataRoot : staticRoot;
    const relative = dynamic ? url.pathname : (url.pathname === "/" ? "/index.html" : url.pathname);
    let path = safePath(root, relative);
    if (!path) throw new Error("UNSAFE_PATH");
    try {
      const body = await fileResponse(path);
      response.writeHead(200, {
        "content-type": mimeTypes[extname(path)] || "application/octet-stream",
        "cache-control": dynamic ? "no-store" : "public, max-age=300",
        "x-content-type-options": "nosniff",
      });
      return response.end(body);
    } catch {
      if (dynamic || extname(url.pathname)) throw new Error("NOT_FOUND");
      path = resolve(staticRoot, "index.html");
      const body = await fileResponse(path);
      response.writeHead(200, { "content-type": mimeTypes[".html"], "cache-control": "no-cache" });
      return response.end(body);
    }
  } catch {
    response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: "not_found" }));
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Web and public data server listening on :${port}`));
