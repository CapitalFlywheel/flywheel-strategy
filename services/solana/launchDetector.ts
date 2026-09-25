import { resolve } from "node:path";
import { PUMP_PROGRAM_ID, PUMP_SDK } from "@pump-fun/pump-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { requireMatchingValues } from "./rpcConsensus";
import { assertReadableTransactionVersion, MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION } from "./rpcTransactionVersion";

export interface PumpCreateCandidate {
  signature: string;
  slot: number;
  blockTime: number;
  mint: string;
  creator: string;
  user: string;
  quoteMint: string;
  tokenProgram: string;
  creatorFeeBps: bigint;
  isHolderReward: boolean;
}

export function selectArmedLaunchCandidate(args: {
  candidates: readonly PumpCreateCandidate[];
  creator: string;
  armedAtMs: number;
}) {
  const creator = new PublicKey(args.creator).toBase58();
  const candidates = args.candidates.filter((candidate) => (
    candidate.creator === creator && candidate.blockTime >= Math.floor(args.armedAtMs / 1_000)
  ));
  if (candidates.length > 1) throw new Error("MULTIPLE_PUMP_LAUNCHES_AFTER_ARM");
  return candidates[0];
}

export function pumpProgramDataLogs(logs: readonly string[]) {
  const stack: string[] = [];
  const data: string[] = [];
  for (const log of logs) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/.exec(log);
    if (invoke) { stack.push(invoke[1]); continue; }
    const finish = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed:.*)$/.exec(log);
    if (finish) {
      if (stack.at(-1) !== finish[1]) throw new Error("PUMP_CREATE_LOG_STACK_INVALID");
      stack.pop();
      continue;
    }
    if (log.startsWith("Program data: ") && stack.at(-1) === PUMP_PROGRAM_ID.toBase58()) {
      data.push(log.slice("Program data: ".length));
    }
  }
  if (stack.length) throw new Error("PUMP_CREATE_LOG_STACK_INVALID");
  return data;
}

function decodePumpCreateLogs(args: {
  signature: string;
  slot: number;
  blockTime: number;
  logs: readonly string[];
}) {
  const candidates: PumpCreateCandidate[] = [];
  for (const encoded of pumpProgramDataLogs(args.logs)) {
    try {
      const event = PUMP_SDK.decodeCreateEventBc(Buffer.from(encoded, "base64"));
      candidates.push({
        signature: args.signature,
        slot: args.slot,
        blockTime: args.blockTime,
        mint: event.mint.toBase58(),
        creator: event.creator.toBase58(),
        user: event.user.toBase58(),
        quoteMint: event.quoteMint.toBase58(),
        tokenProgram: event.tokenProgram.toBase58(),
        creatorFeeBps: BigInt(event.creatorFeeBps.toString()),
        isHolderReward: event.isHolderReward,
      });
    } catch {
      // Other Anchor events share the same log prefix and are intentionally ignored
    }
  }
  return candidates;
}

/** Re-read the exact creation transaction, not merely a matching creator history entry. */
export async function verifyAgreedPumpCreateCandidate(
  rpcUrls: readonly [string, string], candidate: PumpCreateCandidate,
) {
  const results = await Promise.all(rpcUrls.map(async (rpcUrl) => {
    const connection = new Connection(rpcUrl, "finalized");
    const transaction = await connection.getTransaction(candidate.signature, {
      commitment: "finalized", maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
    });
    if (!transaction?.blockTime || transaction.meta?.err !== null || !Array.isArray(transaction.meta?.logMessages)) {
      throw new Error("PUMP_CREATE_TRANSACTION_NOT_FINALIZED");
    }
    assertReadableTransactionVersion(transaction.version);
    const matches = decodePumpCreateLogs({
      signature: candidate.signature, slot: transaction.slot,
      blockTime: transaction.blockTime, logs: transaction.meta.logMessages,
    }).filter((event) => event.mint === candidate.mint);
    if (matches.length !== 1) throw new Error("PUMP_CREATE_EVENT_NOT_UNIQUE");
    const block = await connection.getBlock(transaction.slot, {
      commitment: "finalized", maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
      transactionDetails: "full", rewards: false,
    });
    const matchingRows = block?.transactions.filter((row) => row.transaction.signatures.includes(candidate.signature));
    if (!block || matchingRows?.length !== 1 || matchingRows[0].version !== transaction.version) {
      throw new Error("PUMP_CREATE_FINALIZED_BLOCK_INVALID");
    }
    return { event: matches[0], blockhash: block.blockhash };
  }));
  const agreed = requireMatchingValues(results, "PUMP_CREATE_EVENT_RPC_DISAGREEMENT").event;
  if (agreed.signature !== candidate.signature || agreed.slot !== candidate.slot
    || agreed.blockTime !== candidate.blockTime || agreed.mint !== candidate.mint
    || agreed.creator !== candidate.creator || agreed.user !== candidate.user
    || agreed.quoteMint !== candidate.quoteMint || agreed.tokenProgram !== candidate.tokenProgram
    || agreed.creatorFeeBps !== candidate.creatorFeeBps
    || agreed.isHolderReward !== candidate.isHolderReward) throw new Error("PUMP_CREATE_EVENT_IDENTITY_MISMATCH");
  return agreed;
}

export async function detectCreatorPumpLaunch(args: {
  rpcUrl: string;
  creator: string;
  armedAtMs: number;
  limit?: number;
  maxPages?: number;
}) {
  const connection = new Connection(args.rpcUrl, "finalized");
  const eligible: Array<{ signature: string; blockTime: number }> = [];
  const pageSize = args.limit ?? 1_000;
  const maxPages = args.maxPages ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error("PUMP_LAUNCH_SCAN_BOUNDS_INVALID");
  let before: string | undefined;
  let reachedArmBoundary = false;
  let reachedHistoryEnd = false;
  for (let page = 0; page < maxPages; page += 1) {
    const signatures = await connection.getSignaturesForAddress(new PublicKey(args.creator), { limit: pageSize, before }, "finalized");
    for (const entry of signatures) {
      if (typeof entry.blockTime === "number" && entry.blockTime < Math.floor(args.armedAtMs / 1_000)) {
        reachedArmBoundary = true;
        break;
      }
      if (!entry.err && typeof entry.blockTime === "number") eligible.push({ signature: entry.signature, blockTime: entry.blockTime });
    }
    if (reachedArmBoundary) break;
    if (signatures.length < pageSize) { reachedHistoryEnd = true; break; }
    before = signatures.at(-1)?.signature;
  }
  if (!reachedArmBoundary && !reachedHistoryEnd) throw new Error("PUMP_LAUNCH_SCAN_LIMIT");
  const transactions = await Promise.all(eligible.map(async (entry) => {
    const transaction = await connection.getTransaction(entry.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
    });
    if (!transaction?.blockTime || !transaction.meta || transaction.meta.err !== null
      || !Array.isArray(transaction.meta.logMessages)) throw new Error("PUMP_LAUNCH_TRANSACTION_UNAVAILABLE");
    assertReadableTransactionVersion(transaction.version);
    return decodePumpCreateLogs({
      signature: entry.signature,
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      logs: transaction.meta.logMessages,
    });
  }));
  return selectArmedLaunchCandidate({
    candidates: transactions.flat(),
    creator: args.creator,
    armedAtMs: args.armedAtMs,
  });
}

export async function detectAgreedCreatorPumpLaunch(args: {
  rpcUrls: readonly [string, string];
  creator: string;
  armedAtMs: number;
}) {
  const candidates = await Promise.all(args.rpcUrls.map((rpcUrl) => detectCreatorPumpLaunch({
    rpcUrl, creator: args.creator, armedAtMs: args.armedAtMs,
  })));
  if (candidates.some((candidate) => !candidate)) return undefined;
  return requireMatchingValues(candidates as PumpCreateCandidate[], "PUMP_LAUNCH_RPC_DISAGREEMENT");
}

type StoredCandidate = Omit<PumpCreateCandidate, "creatorFeeBps"> & { creatorFeeBps: string };
interface DurableLaunchScan {
  version: 1;
  creator: string;
  armedAtMs: number;
  anchorSignature: string | null;
  lastScannedHead: string | null;
  candidate?: StoredCandidate;
  pending?: { before?: string; scanHead?: string };
}

const durableScanPath = (stateRoot: string) => resolve(stateRoot, "launch-detector.json");
const storeCandidate = (candidate: PumpCreateCandidate): StoredCandidate => ({
  ...candidate, creatorFeeBps: candidate.creatorFeeBps.toString(),
});
const restoreCandidate = (candidate?: StoredCandidate): PumpCreateCandidate | undefined => candidate
  ? { ...candidate, creatorFeeBps: BigInt(candidate.creatorFeeBps) } : undefined;

function validateDurableScan(value: DurableLaunchScan, creator: string, armedAtMs: number) {
  if (value?.version !== 1 || value.creator !== creator || value.armedAtMs !== armedAtMs
    || (value.anchorSignature !== null && typeof value.anchorSignature !== "string")
    || (value.lastScannedHead !== null && typeof value.lastScannedHead !== "string")
    || (value.pending !== undefined && (!value.pending || typeof value.pending !== "object"
      || (value.pending.before !== undefined && typeof value.pending.before !== "string")
      || (value.pending.scanHead !== undefined && typeof value.pending.scanHead !== "string")
      || (value.pending.before !== undefined && value.pending.scanHead === undefined)))
    || (value.candidate !== undefined && (!value.candidate || value.candidate.creator !== creator
      || typeof value.candidate.signature !== "string" || typeof value.candidate.mint !== "string"
      || !Number.isSafeInteger(value.candidate.slot) || !Number.isSafeInteger(value.candidate.blockTime)
      || !/^\d+$/.test(value.candidate.creatorFeeBps)))) {
    throw new Error("PUMP_LAUNCH_SCAN_STATE_INVALID");
  }
  return value;
}

async function agreedCreatorSignatures(
  connections: readonly [Connection, Connection], creator: PublicKey, limit: number, before?: string,
) {
  const pages = await Promise.all(connections.map((connection) => connection.getSignaturesForAddress(
    creator, { limit, ...(before ? { before } : {}) }, "finalized",
  )));
  const normalized = pages.map((page) => page.map((entry) => ({
    signature: entry.signature, slot: entry.slot, blockTime: entry.blockTime,
    err: entry.err === null ? null : JSON.stringify(entry.err),
  })));
  requireMatchingValues(normalized, "PUMP_LAUNCH_SIGNATURE_PAGE_RPC_DISAGREEMENT");
  return pages[0];
}

/** Capture the finalized creator-history boundary before the user creates the Pump token. */
export async function armDurableCreatorPumpLaunchScan(args: {
  rpcUrls: readonly [string, string]; creator: string; armedAtMs: number; stateRoot: string;
}) {
  if (!Number.isSafeInteger(args.armedAtMs) || args.armedAtMs <= 0) throw new Error("PUMP_LAUNCH_ARM_TIME_INVALID");
  // A previous arm may have written its anchor before the runner saved armed
  // status. Never replace that anchor and silently skip an intervening launch.
  let prior;
  try { prior = await readJsonIfExists(durableScanPath(args.stateRoot)); }
  catch { throw new Error("PUMP_LAUNCH_SCAN_ALREADY_ARMED_OR_STALE"); }
  if (prior !== undefined) {
    throw new Error("PUMP_LAUNCH_SCAN_ALREADY_ARMED_OR_STALE");
  }
  const creator = new PublicKey(args.creator).toBase58();
  const connections = args.rpcUrls.map((url) => new Connection(url, "finalized")) as [Connection, Connection];
  const head = (await agreedCreatorSignatures(connections, new PublicKey(creator), 1))[0]?.signature ?? null;
  const state: DurableLaunchScan = {
    version: 1, creator, armedAtMs: args.armedAtMs,
    anchorSignature: head, lastScannedHead: head,
  };
  await writeDurableJson(durableScanPath(args.stateRoot), state);
}

/** Re-arm the *same* history boundary after a pause or a crash during arming. */
export async function resumeDurableCreatorPumpLaunchScan(args: {
  creator: string; stateRoot: string; expectedArmedAtMs?: number;
}): Promise<number | undefined> {
  let stored;
  try { stored = await readJsonIfExists<DurableLaunchScan>(durableScanPath(args.stateRoot)); }
  catch { throw new Error("PUMP_LAUNCH_SCAN_STATE_INVALID"); }
  if (stored === undefined) return undefined;
  if (!stored || typeof stored !== "object") throw new Error("PUMP_LAUNCH_SCAN_STATE_INVALID");
  const creator = new PublicKey(args.creator).toBase58();
  const state = validateDurableScan(stored, creator, stored.armedAtMs);
  if (!Number.isSafeInteger(state.armedAtMs) || state.armedAtMs <= 0
    || (args.expectedArmedAtMs !== undefined && args.expectedArmedAtMs !== state.armedAtMs)) {
    throw new Error("PUMP_LAUNCH_SCAN_STATE_INVALID");
  }
  return state.armedAtMs;
}

async function agreedCreateEventsForPage(
  connections: readonly [Connection, Connection], page: readonly { signature: string; slot: number; blockTime?: number | null; err: unknown }[],
  batchSize: number,
) {
  const candidates: PumpCreateCandidate[] = [];
  for (let offset = 0; offset < page.length; offset += batchSize) {
    const rows = await Promise.all(page.slice(offset, offset + batchSize).map(async (entry) => {
      if (entry.err !== null) return [];
      if (!Number.isSafeInteger(entry.blockTime) || (entry.blockTime ?? 0) <= 0) throw new Error("PUMP_LAUNCH_TRANSACTION_UNAVAILABLE");
      const eventLists = await Promise.all(connections.map(async (connection) => {
        const transaction = await connection.getTransaction(entry.signature, {
          commitment: "finalized", maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
        });
        if (!transaction || transaction.meta?.err !== null || !Array.isArray(transaction.meta.logMessages)
          || transaction.slot !== entry.slot || transaction.blockTime !== entry.blockTime) {
          throw new Error("PUMP_LAUNCH_TRANSACTION_UNAVAILABLE");
        }
        assertReadableTransactionVersion(transaction.version);
        return decodePumpCreateLogs({
          signature: entry.signature, slot: transaction.slot, blockTime: transaction.blockTime!,
          logs: transaction.meta.logMessages,
        });
      }));
      return requireMatchingValues(eventLists, "PUMP_CREATE_EVENT_RPC_DISAGREEMENT");
    }));
    for (const row of rows) candidates.push(...row);
  }
  return candidates;
}

/**
 * Bounded finalized scan with a durable page cursor. A candidate is returned
 * only after every signature since the arm boundary was checked on both RPCs.
 * A crash replays at most the last uncommitted page; it never skips one.
 */
export async function detectDurableAgreedCreatorPumpLaunch(args: {
  rpcUrls: readonly [string, string]; creator: string; armedAtMs: number; stateRoot: string;
  pageSize?: number; maxPagesPerTick?: number; transactionConcurrency?: number;
}): Promise<PumpCreateCandidate | undefined> {
  const creator = new PublicKey(args.creator).toBase58();
  const pageSize = args.pageSize ?? 50;
  const maxPagesPerTick = args.maxPagesPerTick ?? 4;
  const transactionConcurrency = args.transactionConcurrency ?? 8;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
    || !Number.isInteger(maxPagesPerTick) || maxPagesPerTick < 1 || maxPagesPerTick > 20
    || !Number.isInteger(transactionConcurrency) || transactionConcurrency < 1 || transactionConcurrency > 16) {
    throw new Error("PUMP_LAUNCH_SCAN_BOUNDS_INVALID");
  }
  const path = durableScanPath(args.stateRoot);
  const stored = await readJsonIfExists<DurableLaunchScan>(path);
  if (!stored) throw new Error("PUMP_LAUNCH_SCAN_STATE_MISSING");
  const state = validateDurableScan(stored, creator, args.armedAtMs);
  const connections = args.rpcUrls.map((url) => new Connection(url, "finalized")) as [Connection, Connection];
  state.pending ??= {};
  for (let pageNumber = 0; pageNumber < maxPagesPerTick; pageNumber += 1) {
    const page = await agreedCreatorSignatures(connections, new PublicKey(creator), pageSize, state.pending.before);
    if (!state.pending.scanHead && page.length) state.pending.scanHead = page[0].signature;
    const boundaryIndex = state.lastScannedHead === null ? -1
      : page.findIndex((entry) => entry.signature === state.lastScannedHead);
    const fresh = boundaryIndex >= 0 ? page.slice(0, boundaryIndex) : page;
    const events = await agreedCreateEventsForPage(connections, fresh, transactionConcurrency);
    for (const event of events.filter((candidate) => candidate.creator === creator)) {
      if (state.candidate) throw new Error("MULTIPLE_PUMP_LAUNCHES_AFTER_ARM");
      state.candidate = storeCandidate(event);
    }
    const complete = boundaryIndex >= 0 || (state.lastScannedHead === null && page.length < pageSize);
    if (complete) {
      const scanHead = state.pending.scanHead ?? state.lastScannedHead;
      state.lastScannedHead = scanHead;
      state.pending = undefined;
      await writeDurableJson(path, state);
      // A new finalized transaction may have appeared during pagination.
      // Catch it on the next tick before returning a candidate for binding.
      const currentHead = (await agreedCreatorSignatures(connections, new PublicKey(creator), 1))[0]?.signature ?? null;
      if (currentHead !== scanHead) return undefined;
      const candidate = restoreCandidate(state.candidate);
      if (candidate) await verifyAgreedPumpCreateCandidate(args.rpcUrls, candidate);
      return candidate;
    }
    if (page.length < pageSize) throw new Error("PUMP_LAUNCH_SCAN_ANCHOR_MISSING");
    state.pending.before = page.at(-1)!.signature;
    await writeDurableJson(path, state);
  }
  return undefined;
}
