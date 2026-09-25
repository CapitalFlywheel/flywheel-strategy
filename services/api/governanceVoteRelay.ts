import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { Connection, PublicKey, SystemProgram, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { deriveGovernanceReserveRoute, verifyGovernanceReserveRoute } from "../solana/governanceVaultRoute";

// This is deliberately independent of the website flag. Both gates need a
// reviewed executor, audited immutable program and a real mobile-wallet test.
export const GOVERNANCE_VOTE_BROADCAST_RELEASED = false;
const TEST_ONLY_PROGRAM = "3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh";
const OFFICIAL_MSTRX_MINT = "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ";
const PROPOSAL_DISCRIMINATOR = createHash("sha256").update("account:Proposal").digest().subarray(0, 8);
const CONFIG_DISCRIMINATOR = createHash("sha256").update("account:Config").digest().subarray(0, 8);
const CAST_VOTE_DISCRIMINATOR = createHash("sha256").update("global:cast_vote").digest().subarray(0, 8);
const MAX_REQUEST_BYTES = 4_096;
const MAX_RAW_TRANSACTION_BYTES = 1_800;
const MAX_PROOF_HASHES = 32;
const MAX_RESPONSE_BYTES = 1_024;
const WINDOW_MS = 60_000;
const MAX_CLIENTS = 2_048;
const CLIENT_REQUESTS_PER_WINDOW = 3;
const GLOBAL_REQUESTS_PER_WINDOW = 30;
const MAX_CONCURRENT = 2;
const UPSTREAM_TIMEOUT_MS = 8_000;

type VoteRpc = { jsonrpc: "2.0"; id: string | number; method: "sendTransaction";
  params: [string, { encoding: "base64"; skipPreflight?: false; preflightCommitment?: "finalized";
    maxRetries?: 0 }] };
type Route = { program: PublicKey; activeProposalId: bigint; capitalMint: PublicKey; reserveVault: PublicKey };
type VoteSnapshot = {
  config: AccountInfo<Buffer> | null;
  vault: AccountInfo<Buffer> | null;
  proposal: AccountInfo<Buffer> | null;
  record: AccountInfo<Buffer> | null;
};

type Settings = NonNullable<ReturnType<typeof env>>;
let immutableProgramProof: { key: string; promise: Promise<void> } | undefined;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function json(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

/** No arbitrary JSON-RPC method, batch, encoding, preflight bypass or retry budget. */
export function validateVoteRpcRequest(value: unknown): value is VoteRpc {
  if (!object(value) || !exactKeys(value, ["jsonrpc", "id", "method", "params"])
    || value.jsonrpc !== "2.0" || value.method !== "sendTransaction"
    || !(typeof value.id === "string" && value.id.length <= 64
      || typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id >= 0)
    || !Array.isArray(value.params) || value.params.length !== 2
    || typeof value.params[0] !== "string" || value.params[0].length > 2_400
    || !object(value.params[1])) return false;
  const options = value.params[1];
  return exactKeys(options, ["encoding", "skipPreflight", "preflightCommitment", "maxRetries"])
    && options.encoding === "base64"
    && (!Object.hasOwn(options, "skipPreflight") || options.skipPreflight === false)
    && (!Object.hasOwn(options, "preflightCommitment") || options.preflightCommitment === "finalized")
    && (!Object.hasOwn(options, "maxRetries") || options.maxRetries === 0);
}

export class GovernanceVoteLimiter {
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

const voteLimiter = new GovernanceVoteLimiter();

function exactBase64Transaction(value: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("VOTE_TRANSACTION_ENCODING_INVALID");
  }
  const raw = Buffer.from(value, "base64");
  if (raw.length === 0 || raw.length > MAX_RAW_TRANSACTION_BYTES || raw.toString("base64") !== value) {
    throw new Error("VOTE_TRANSACTION_ENCODING_INVALID");
  }
  return raw;
}

/** Parse only the immutable governance v3 proposal fields relevant to this signed vote. */
export function inspectActiveVoteProposal(data: Buffer, expected: {
  program: PublicKey; proposal: PublicKey; id: bigint; config: PublicKey;
  capitalMint: PublicKey; reserveVault: PublicKey; optionIndex: number;
}) {
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(expected.id);
  const [expectedConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], expected.program);
  const [expectedProposal, proposalBump] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), idBytes], expected.program);
  if (!expected.config.equals(expectedConfig) || !expected.proposal.equals(expectedProposal)
    || data.length !== 726 || !data.subarray(0, 8).equals(PROPOSAL_DISCRIMINATOR)
    || data[8] !== 3 || !new PublicKey(data.subarray(9, 41)).equals(expected.config)
    || !new PublicKey(data.subarray(41, 73)).equals(expected.capitalMint)
    || !new PublicKey(data.subarray(73, 105)).equals(expected.reserveVault)
    || data.readBigUInt64LE(105) !== expected.id) throw new Error("VOTE_PROPOSAL_INVALID");
  const optionCount = data.readUInt32LE(289);
  if (optionCount < 2 || optionCount > 6 || expected.optionIndex >= optionCount) {
    throw new Error("VOTE_PROPOSAL_OPTIONS_INVALID");
  }
  const tallyOffset = 293 + optionCount * 53;
  const totalCastOffset = tallyOffset + 6 * 16;
  const statusOffset = totalCastOffset + 16;
  if (statusOffset + 3 > data.length || ![0, 6].includes(data[statusOffset])
    || data[statusOffset + 1] !== 255 || data[statusOffset + 2] !== proposalBump
    || data.subarray(statusOffset + 3).some((byte) => byte !== 0)) {
    throw new Error("VOTE_PROPOSAL_NOT_ACTIVE");
  }
  const u128 = (offset: number) => data.readBigUInt64LE(offset) | data.readBigUInt64LE(offset + 8) << 64n;
  const totalAvailableWeight = u128(265);
  const totalCast = u128(totalCastOffset);
  let tallySum = 0n;
  for (let index = 0; index < 6; index++) {
    const weight = u128(tallyOffset + index * 16);
    if (index >= optionCount && weight !== 0n) throw new Error("VOTE_PROPOSAL_TALLY_INVALID");
    tallySum += weight;
  }
  if (tallySum !== totalCast || totalCast > totalAvailableWeight) {
    throw new Error("VOTE_PROPOSAL_TALLY_INVALID");
  }
  const now = Math.floor(Date.now() / 1_000);
  const startsAt = Number(data.readBigInt64LE(113));
  const endsAt = Number(data.readBigInt64LE(121));
  // Offchain time is only a conservative admission check; the program Clock
  // remains authoritative. Do not broadcast a transaction near an edge.
  if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(endsAt)
    || startsAt > now - 2 || endsAt < now + 2) throw new Error("VOTE_WINDOW_NOT_OPEN");
  return { immutablePrefix: data.subarray(0, tallyOffset), status: data[statusOffset],
    frozenReserveRaw: data.readBigUInt64LE(281) };
}

/** Cheap, fully local admission before even one provider read. */
export function precheckSignedCastVote(raw: Buffer, program: PublicKey) {
  if (raw.length === 0 || raw.length > MAX_RAW_TRANSACTION_BYTES) throw new Error("VOTE_TRANSACTION_INVALID");
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(raw); }
  catch { throw new Error("VOTE_TRANSACTION_INVALID"); }
  const message = tx.message;
  if (message.version !== "legacy" || tx.signatures.length !== 1
    || message.header.numRequiredSignatures !== 1 || message.header.numReadonlySignedAccounts !== 0
    || message.header.numReadonlyUnsignedAccounts !== 2 || message.staticAccountKeys.length !== 5
    || message.compiledInstructions.length !== 1
    || !Buffer.from(tx.serialize()).equals(raw)) throw new Error("VOTE_TRANSACTION_INVALID");
  const keys = message.staticAccountKeys;
  const voter = keys[0];
  if (!voter || !nacl.sign.detached.verify(message.serialize(), tx.signatures[0], voter.toBytes())) {
    throw new Error("VOTE_SIGNATURE_INVALID");
  }
  const ix = message.compiledInstructions[0];
  const keyIndex = (key: PublicKey) => keys.findIndex((candidate) => candidate.equals(key));
  if (new Set(keys.map((key) => key.toBase58())).size !== 5
    || keyIndex(program) < 0 || keyIndex(SystemProgram.programId) < 0
    || !keys[ix.programIdIndex]?.equals(program)
    || ix.accountKeyIndexes.length !== 5
    || ix.accountKeyIndexes[2] !== 0 || ix.accountKeyIndexes[3] !== 0
    || !keys[ix.accountKeyIndexes[4]]?.equals(SystemProgram.programId)
    || ix.accountKeyIndexes[0] === ix.accountKeyIndexes[1]
    || [0, 1].some((index) => ix.accountKeyIndexes[index] === 0)
    || !message.isAccountWritable(0)
    || !message.isAccountWritable(ix.accountKeyIndexes[0])
    || !message.isAccountWritable(ix.accountKeyIndexes[1])
    || message.isAccountWritable(keyIndex(SystemProgram.programId))
    || message.isAccountWritable(keyIndex(program))) throw new Error("VOTE_INSTRUCTION_INVALID");
  const data = Buffer.from(ix.data);
  if (data.length < 29 || !data.subarray(0, 8).equals(CAST_VOTE_DISCRIMINATOR)) {
    throw new Error("VOTE_INSTRUCTION_INVALID");
  }
  const optionIndex = data[8];
  const weight = data.readBigUInt64LE(9) | data.readBigUInt64LE(17) << 64n;
  const proofCount = data.readUInt32LE(25);
  if (optionIndex >= 6 || weight === 0n || proofCount > MAX_PROOF_HASHES
    || data.length !== 29 + proofCount * 32) throw new Error("VOTE_INSTRUCTION_INVALID");
  return { signature: bs58.encode(tx.signatures[0]),
    proposal: keys[ix.accountKeyIndexes[0]], record: keys[ix.accountKeyIndexes[1]], optionIndex, voter };
}

/** Exact active-proposal PDA and voter-record PDA after a finalized config read. */
export function verifySignedCastVote(raw: Buffer, route: Route) {
  if (route.activeProposalId <= 0n || route.activeProposalId > (1n << 64n) - 1n) {
    throw new Error("VOTE_TRANSACTION_INVALID");
  }
  const vote = precheckSignedCastVote(raw, route.program);
  const proposalId = Buffer.alloc(8);
  proposalId.writeBigUInt64LE(route.activeProposalId);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], route.program);
  const [proposal] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), proposalId], route.program);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from("vote"), proposal.toBuffer(), vote.voter.toBuffer()], route.program);
  if (!vote.proposal.equals(proposal) || !vote.record.equals(record)) throw new Error("VOTE_ACCOUNTS_INVALID");
  return { ...vote, proposal, record, config };
}

function env() {
  const primary = process.env.SOLANA_RPC_PRIMARY_URL?.trim();
  const fallback = process.env.SOLANA_RPC_FALLBACK_URL?.trim();
  const program = process.env.SOLANA_GOVERNANCE_PROGRAM?.trim();
  const hash = process.env.SOLANA_GOVERNANCE_PROGRAM_CODE_SHA256?.trim();
  const capitalMint = process.env.SOLANA_CAPITAL_MINT?.trim();
  const admin = process.env.SOLANA_ADMIN_OWNER?.trim();
  if (process.env.SOLANA_CLUSTER !== "mainnet-beta" || !primary || !fallback
    || !program || !hash || !capitalMint || !admin || !/^[a-f0-9]{64}$/.test(hash)) return;
  try {
    const primaryUrl = new URL(primary);
    const fallbackUrl = new URL(fallback);
    if ([primaryUrl, fallbackUrl].some((url) => url.protocol !== "https:" || url.username || url.password || url.hash)
      || primaryUrl.host === fallbackUrl.host || new PublicKey(program).toBase58() === TEST_ONLY_PROGRAM) return;
    return { rpcUrls: [primary, fallback] as const, program, expectedProgramCodeSha256: hash,
      capitalMint: new PublicKey(capitalMint).toBase58(), admin: new PublicKey(admin).toBase58() };
  } catch { return; }
}

/** Small dynamic state check after immutable code was attested once. */
export function inspectVoteConfigAndVault(configData: Buffer, vaultInfo: {
  owner: PublicKey; data: Buffer;
}, expected: { program: PublicKey; capitalMint: PublicKey; reserveMint: PublicKey;
  reserveVault: PublicKey; admin: PublicKey }) {
  const [config, configBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], expected.program);
  if (configData.length !== 306 || !configData.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)
    || configData[8] !== 3
    || !new PublicKey(configData.subarray(9, 41)).equals(expected.admin)
    || !new PublicKey(configData.subarray(41, 73)).equals(expected.capitalMint)
    || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((key) => key.equals(new PublicKey(configData.subarray(73, 105))))
    || !new PublicKey(configData.subarray(105, 137)).equals(expected.reserveMint)
    || !new PublicKey(configData.subarray(137, 169)).equals(expected.reserveVault)
    || configData.readBigInt64LE(201) <= 0n || configData.readBigUInt64LE(209) === 0n
    || configData.subarray(217, 281).every((byte) => byte === 0)
    || configData[305] !== configBump) throw new Error("VOTE_CONFIG_INVALID");
  const lastProposalId = configData.readBigUInt64LE(281);
  const activeProposalId = configData.readBigUInt64LE(289);
  const committed = configData.readBigUInt64LE(297);
  if (activeProposalId === 0n || activeProposalId > lastProposalId
    || !vaultInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("VOTE_CONFIG_NOT_ACTIVE");
  let vault;
  try { vault = unpackAccount(expected.reserveVault, { ...vaultInfo, executable: false, lamports: 0,
    rentEpoch: 0 }, TOKEN_2022_PROGRAM_ID); }
  catch { throw new Error("VOTE_VAULT_INVALID"); }
  if (!vault.isInitialized || vault.isFrozen || !vault.mint.equals(expected.reserveMint)
    || !vault.owner.equals(config) || vault.delegate !== null || vault.closeAuthority !== null
    || vault.amount < committed) throw new Error("VOTE_VAULT_INVALID");
  return { activeProposalId, committed, identity: configData.subarray(0, 281) };
}

/** Finalized nodes may differ on new free deposits or vote tallies. */
export function verifyDualVoteSnapshots(snapshots: readonly [VoteSnapshot, VoteSnapshot], expected: {
  program: PublicKey; capitalMint: PublicKey; reserveMint: PublicKey; reserveVault: PublicKey;
  admin: PublicKey; voter: PublicKey; proposal: PublicKey; record: PublicKey; optionIndex: number;
}) {
  const checked = snapshots.map((snapshot) => {
    if (!snapshot.config || !snapshot.config.owner.equals(expected.program)
      || !snapshot.vault || !snapshot.proposal || !snapshot.proposal.owner.equals(expected.program)
      || snapshot.record !== null) throw new Error("VOTE_ONCHAIN_STATE_INVALID");
    const configuration = inspectVoteConfigAndVault(snapshot.config.data, snapshot.vault, expected);
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(configuration.activeProposalId);
    const [proposal] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), idBytes], expected.program);
    const [record] = PublicKey.findProgramAddressSync([
      Buffer.from("vote"), proposal.toBuffer(), expected.voter.toBuffer(),
    ], expected.program);
    if (!proposal.equals(expected.proposal) || !record.equals(expected.record)) {
      throw new Error("VOTE_ACCOUNTS_INVALID");
    }
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], expected.program);
    const ballot = inspectActiveVoteProposal(snapshot.proposal.data, {
      program: expected.program, proposal, id: configuration.activeProposalId,
      config, capitalMint: expected.capitalMint,
      reserveVault: expected.reserveVault, optionIndex: expected.optionIndex,
    });
    if (ballot.frozenReserveRaw !== configuration.committed) {
      throw new Error("VOTE_COMMITMENT_MISMATCH");
    }
    return { ...configuration, ...ballot };
  });
  if (checked[0].activeProposalId !== checked[1].activeProposalId
    || checked[0].committed !== checked[1].committed
    || !checked[0].identity.equals(checked[1].identity)
    || checked[0].status !== checked[1].status
    || !checked[0].immutablePrefix.equals(checked[1].immutablePrefix)) {
    throw new Error("VOTE_RPC_DISAGREEMENT");
  }
  return checked[0].activeProposalId;
}

/** Upgrade authority None is irreversible; cache only that expensive, dual-RPC code proof. */
async function requireImmutableProgram(settings: Settings, route: ReturnType<typeof deriveGovernanceReserveRoute>) {
  const key = createHash("sha256").update(JSON.stringify([
    ...settings.rpcUrls, settings.program, settings.expectedProgramCodeSha256,
    settings.capitalMint, settings.admin,
  ])).digest("hex");
  if (!immutableProgramProof || immutableProgramProof.key !== key) {
    const promise = verifyGovernanceReserveRoute(settings.rpcUrls, {
      governanceProgram: settings.program, reserveAuthority: route.authority.toBase58(),
      capitalMint: settings.capitalMint, reserveMint: OFFICIAL_MSTRX_MINT,
      admin: settings.admin, expectedProgramCodeSha256: settings.expectedProgramCodeSha256,
    }).then(() => undefined);
    immutableProgramProof = { key, promise };
    void promise.catch(() => {
      if (immutableProgramProof?.promise === promise) immutableProgramProof = undefined;
    });
  }
  await immutableProgramProof.promise;
}

async function responseJson(response: Response): Promise<unknown> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES || !response.body) throw new Error("VOTE_RPC_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("VOTE_RPC_INVALID");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}

/** Server-side only. All exceptions are sanitized by the HTTP handler. */
async function broadcastVote(value: VoteRpc) {
  if (!GOVERNANCE_VOTE_BROADCAST_RELEASED) throw new Error("VOTE_NOT_RELEASED");
  const settings = env();
  if (!settings) throw new Error("VOTE_ROUTE_NOT_CONFIGURED");
  const raw = exactBase64Transaction(value.params[0]);
  const route = deriveGovernanceReserveRoute(settings.program, OFFICIAL_MSTRX_MINT);
  // Reject malformed signatures, extra instructions and non-vote methods
  // before paying for any RPC call or reading large immutable ProgramData.
  const prechecked = precheckSignedCastVote(raw, route.program);
  await requireImmutableProgram(settings, route);
  const snapshots = await Promise.all(settings.rpcUrls.map(async (url): Promise<VoteSnapshot> => {
    const connection = new Connection(url, "finalized");
    const accounts = await connection.getMultipleAccountsInfoAndContext(
      [route.authority, route.ata, prechecked.proposal, prechecked.record], "finalized");
    const [config, vault, proposal, record] = accounts.value;
    return { config, vault, proposal, record };
  }));
  const activeProposalId = verifyDualVoteSnapshots([snapshots[0], snapshots[1]], {
    program: route.program, capitalMint: new PublicKey(settings.capitalMint), reserveMint: route.mint,
    reserveVault: route.ata, admin: new PublicKey(settings.admin), voter: prechecked.voter,
    proposal: prechecked.proposal, record: prechecked.record, optionIndex: prechecked.optionIndex,
  });
  const vote = verifySignedCastVote(raw, { program: route.program, activeProposalId,
    capitalMint: new PublicKey(settings.capitalMint), reserveVault: route.ata });
  const response = await fetch(settings.rpcUrls[0], {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [value.params[0], {
      encoding: "base64", skipPreflight: false, preflightCommitment: "finalized", maxRetries: 0,
    }] }),
    redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("VOTE_RPC_REJECTED");
  const result = await responseJson(response);
  if (!object(result) || result.jsonrpc !== "2.0" || result.id !== 1
    || result.result !== vote.signature || "error" in result) throw new Error("VOTE_RPC_REJECTED");
  return vote.signature;
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("VOTE_REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function handleGovernanceVoteRpc(request: IncomingMessage, response: ServerResponse) {
  if (!GOVERNANCE_VOTE_BROADCAST_RELEASED) return json(response, 503, { error: "voting_unavailable" });
  if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json(response, 415, { error: "json_required" });
  }
  const origin = request.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const local = request.headers.host?.startsWith("localhost:") || request.headers.host?.startsWith("127.0.0.1:");
      if (parsed.host !== request.headers.host || parsed.protocol !== (local ? "http:" : "https:")) {
        return json(response, 403, { error: "origin_not_allowed" });
      }
    } catch { return json(response, 403, { error: "origin_not_allowed" }); }
  }
  if (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") {
    return json(response, 403, { error: "origin_not_allowed" });
  }
  const remote = request.socket.remoteAddress ?? "unknown";
  const forwarded = request.headers["x-real-ip"];
  const client = (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")
    && typeof forwarded === "string" && forwarded.length <= 64 && isIP(forwarded)
    ? forwarded : remote;
  const release = voteLimiter.acquire(client);
  if (!release) return json(response, 429, { error: "vote_rate_limited" });
  try {
    let value: unknown;
    try { value = await requestBody(request); }
    catch { return json(response, 400, { error: "vote_request_invalid" }); }
    if (!validateVoteRpcRequest(value)) return json(response, 400, { error: "vote_request_invalid" });
    try {
      const signature = await broadcastVote(value);
      return json(response, 200, { jsonrpc: "2.0", id: value.id, result: signature });
    } catch {
      // No upstream error text or authenticated URLs are reflected to browsers.
      return json(response, 503, { jsonrpc: "2.0", id: value.id,
        error: { code: -32000, message: "Vote could not be verified or broadcast" } });
    }
  } finally { release(); }
}
