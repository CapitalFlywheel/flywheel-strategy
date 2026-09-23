import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { requireMatchingValues } from "./rpcConsensus";

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

function decodePumpCreateLogs(args: {
  signature: string;
  slot: number;
  blockTime: number;
  logs: readonly string[];
}) {
  const candidates: PumpCreateCandidate[] = [];
  for (const log of args.logs) {
    const encoded = log.startsWith("Program data: ") ? log.slice("Program data: ".length) : undefined;
    if (!encoded) continue;
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
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction?.blockTime || !transaction.meta?.logMessages) return [];
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
