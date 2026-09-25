import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { assertRewardPlanHash, type FinalizedHolderJournal, type RewardEpochPlan } from "./epochPlanner";
import { readAgreedFinalizedTransaction, type FinalizedTokenTransaction } from "./finalizedTransfers";
import { type SolanaTransfer } from "./holderAccounting";
import { requireMatchingValues } from "./rpcConsensus";
import { readFinalizedBlockSignatures } from "./rpcTransactionVersion";

export interface DiscoveredTransferTransaction {
  signature: string;
  slot: number;
  transactionIndex: number;
  /** Present for candidates from the independently agreed full-block scan.
   * Legacy version-2 checkpoints may lack these fields and use the old
   * accounts-mode block read until that checkpoint is fully consumed. */
  blockhash?: string;
  blockTime?: number;
}

export interface MintTransferSource {
  discover(mint: string, fromTime: number, throughTime: number): Promise<DiscoveredTransferTransaction[]>;
  discoverFinalizedBlocks?(args: {
    mint: string;
    fromSlot: number;
    throughSlot: number;
    throughBlockhash: string;
    throughTime: number;
    stateRoot: string;
    rpcUrls: readonly [string, string];
    maxSlotsPerRun?: number;
    blockConcurrency?: number;
  }): Promise<DiscoveredTransferTransaction[]>;
  acknowledgeFinalizedBlocks?(args: {
    mint: string;
    fromSlot: number;
    throughSlot: number;
    throughBlockhash: string;
    throughTime: number;
    stateRoot: string;
    rpcUrls: readonly [string, string];
    maxSlotsPerRun?: number;
    blockConcurrency?: number;
  }): Promise<void>;
}

export interface CachedJournal {
  /** V1 lost intra-transaction sales; V2 trusted incomplete vendor discovery. */
  version: 3;
  mint: string;
  launchSlot: number;
  launchSignature: string;
  launchTime: number;
  indexedThroughSlot: number;
  indexedThroughTime: number;
  coverage: {
    kind: "two-rpc-finalized-full-blocks";
    fromSlot: number;
    throughSlot: number;
    throughBlockhash: string;
  };
  transactions: Array<DiscoveredTransferTransaction & { blockTime: number; blockhash: string; transfers: Array<Omit<SolanaTransfer, "rawAmount"> & { rawAmount: string }> }>;
  digest: string;
}

function cachePath(stateRoot: string) { return resolve(stateRoot, "capital-transfers.json"); }

export function holderCacheDigest(cache: Omit<CachedJournal, "digest">) {
  const canonical = {
    version: cache.version, mint: cache.mint, launchSlot: cache.launchSlot,
    launchSignature: cache.launchSignature, launchTime: cache.launchTime,
    indexedThroughSlot: cache.indexedThroughSlot, indexedThroughTime: cache.indexedThroughTime,
    coverage: { kind: cache.coverage.kind, fromSlot: cache.coverage.fromSlot,
      throughSlot: cache.coverage.throughSlot, throughBlockhash: cache.coverage.throughBlockhash },
    transactions: cache.transactions.map((row) => ({
      signature: row.signature, slot: row.slot, transactionIndex: row.transactionIndex,
      blockTime: row.blockTime, blockhash: row.blockhash,
      transfers: row.transfers.map((movement) => ({
        signature: movement.signature, slot: movement.slot, transactionIndex: movement.transactionIndex,
        instructionIndex: movement.instructionIndex, timestamp: movement.timestamp,
        from: movement.from ?? null, to: movement.to ?? null, rawAmount: movement.rawAmount,
      })),
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Local corruption check, not authentication against a compromised server. */
export function assertVerifiedHolderCache(value: unknown): asserts value is CachedJournal {
  const cache = value as Partial<CachedJournal> | null;
  if (!cache || cache.version !== 3 || !cache.mint || !cache.launchSignature
    || !Number.isSafeInteger(cache.launchSlot) || cache.launchSlot! <= 0
    || !Number.isSafeInteger(cache.launchTime) || cache.launchTime! <= 0
    || !Number.isSafeInteger(cache.indexedThroughSlot) || cache.indexedThroughSlot! < cache.launchSlot!
    || !Number.isSafeInteger(cache.indexedThroughTime) || cache.indexedThroughTime! < cache.launchTime!
    || cache.coverage?.kind !== "two-rpc-finalized-full-blocks"
    || cache.coverage.fromSlot !== cache.launchSlot
    || cache.coverage.throughSlot !== cache.indexedThroughSlot
    || typeof cache.coverage.throughBlockhash !== "string" || !cache.coverage.throughBlockhash
    || !Array.isArray(cache.transactions)
    || typeof cache.digest !== "string" || !/^[a-f0-9]{64}$/.test(cache.digest)) {
    throw new Error("HOLDER_INDEX_CACHE_INTEGRITY_INVALID");
  }
  const { digest, ...payload } = cache;
  let expected: string;
  try { expected = holderCacheDigest(payload as Omit<CachedJournal, "digest">); }
  catch { throw new Error("HOLDER_INDEX_CACHE_INTEGRITY_INVALID"); }
  if (expected !== digest) throw new Error("HOLDER_INDEX_CACHE_DIGEST_MISMATCH");
}

export function holderMovements(transaction: FinalizedTokenTransaction, transactionIndex: number) {
  if (transaction.transactionIndex !== transactionIndex) throw new Error("HOLDER_TRANSACTION_INDEX_MISMATCH");
  if (!Array.isArray(transaction.movements)) throw new Error("HOLDER_ORDERED_MOVEMENTS_REQUIRED");
  return transaction.movements.map((movement, index): SolanaTransfer => {
    const rawAmount = BigInt(movement.rawAmount);
    if (movement.instructionIndex !== index || rawAmount <= 0n || (!movement.from && !movement.to)) {
      throw new Error("HOLDER_ORDERED_MOVEMENT_INVALID");
    }
    return { signature: transaction.signature, slot: transaction.slot, transactionIndex,
      instructionIndex: index, timestamp: transaction.blockTime,
      from: movement.from, to: movement.to, rawAmount };
  });
}

export interface HolderJournalEnvironment {
  rpcUrls: readonly [string, string];
  stateRoot: string;
  journalPath: string;
  mint: string;
  launchSlot: number;
  launchSignature: string;
  launchTime: number;
  epochSeconds: number;
  overlapSeconds?: number;
  backfillSlotsPerRun?: number;
  backfillBlockConcurrency?: number;
  forceFinalizedBackfill?: boolean;
}

export async function refreshHolderJournal(args: {
  environment: HolderJournalEnvironment;
  source: MintTransferSource;
  finalizedThroughSlot: number;
  finalizedThroughTime: number;
  finalizedBlockhash: string;
}) {
  const { environment, source } = args;
  new PublicKey(environment.mint);
  if (args.finalizedThroughSlot < environment.launchSlot || args.finalizedThroughTime < environment.launchTime) throw new Error("HOLDER_INDEX_BEFORE_LAUNCH");
  const path = cachePath(environment.stateRoot);
  const loaded = await readJsonIfExists<Partial<CachedJournal>>(path);
  if (!environment.launchSignature) throw new Error("HOLDER_LAUNCH_SIGNATURE_REQUIRED");
  if (loaded && (loaded.mint !== environment.mint || loaded.launchSlot !== environment.launchSlot
    || loaded.launchSignature !== environment.launchSignature || loaded.launchTime !== environment.launchTime)) {
    throw new Error("HOLDER_INDEX_IDENTITY_MISMATCH");
  }
  if (loaded && ![1, 2, 3].includes(loaded.version as number)) throw new Error("HOLDER_INDEX_VERSION_UNSUPPORTED");
  if (loaded?.version === 3 && loaded.digest !== undefined) assertVerifiedHolderCache(loaded);
  // Old vendor-only caches are retained on disk until a complete independently
  // verified launch-to-target scan replaces them. A pre-digest v3 cache is
  // treated the same way. No unverified old row is reused.
  const previous = loaded?.version === 3 && loaded.digest !== undefined ? loaded as CachedJournal : undefined;
  if (previous && args.finalizedThroughSlot < previous.indexedThroughSlot) throw new Error("HOLDER_INDEX_SLOT_REWIND");
  if (previous && args.finalizedThroughTime < previous.indexedThroughTime) throw new Error("HOLDER_INDEX_TIME_REWIND");
  if (!source.discoverFinalizedBlocks || !source.acknowledgeFinalizedBlocks) throw new Error("HOLDER_BACKFILL_SOURCE_UNAVAILABLE");
  const backfillArgs: Parameters<NonNullable<MintTransferSource["discoverFinalizedBlocks"]>>[0] = {
    mint: environment.mint,
    fromSlot: previous ? previous.indexedThroughSlot : environment.launchSlot,
    throughSlot: args.finalizedThroughSlot,
    throughBlockhash: args.finalizedBlockhash,
    throughTime: args.finalizedThroughTime,
    stateRoot: environment.stateRoot,
    rpcUrls: environment.rpcUrls,
    maxSlotsPerRun: environment.backfillSlotsPerRun,
    blockConcurrency: environment.backfillBlockConcurrency,
  };
  const found = await source.discoverFinalizedBlocks(backfillArgs);
  const unique = new Map<string, DiscoveredTransferTransaction>();
  let verifiedLaunch: FinalizedTokenTransaction | undefined;
  for (const row of found) {
    if (!row.signature || !Number.isSafeInteger(row.slot) || !Number.isSafeInteger(row.transactionIndex)
      || row.transactionIndex < 0 || row.slot < backfillArgs.fromSlot || row.slot > args.finalizedThroughSlot) {
      throw new Error("HOLDER_INDEX_DISCOVERY_OUT_OF_RANGE");
    }
    if ((row.blockhash !== undefined || row.blockTime !== undefined)
      && (typeof row.blockhash !== "string" || !row.blockhash
        || !Number.isSafeInteger(row.blockTime) || row.blockTime! < environment.launchTime
        || row.blockTime! > args.finalizedThroughTime)) {
      throw new Error("HOLDER_INDEX_BLOCK_EVIDENCE_INVALID");
    }
    const existing = unique.get(row.signature);
    if (existing && (existing.slot !== row.slot || existing.transactionIndex !== row.transactionIndex
      || existing.blockhash !== row.blockhash || existing.blockTime !== row.blockTime)) {
      throw new Error("HOLDER_INDEX_DISCOVERY_CONFLICT");
    }
    unique.set(row.signature, row);
  }
  if (!previous && !unique.has(environment.launchSignature)) {
    // Seed a launch transaction absent from the mint-balance candidates only
    // after verifying its finalized movements and canonical block position.
    const launch = await readAgreedFinalizedTransaction(environment.rpcUrls, environment.launchSignature, environment.mint, { includeOrderedMovements: true });
    if (!launch || launch.slot !== environment.launchSlot || launch.blockTime !== environment.launchTime) throw new Error("HOLDER_LAUNCH_TRANSACTION_UNVERIFIED");
    verifiedLaunch = launch;
    const positions = await Promise.all(environment.rpcUrls.map(async (url) => {
      const block = await readFinalizedBlockSignatures(new Connection(url, "finalized"), environment.launchSlot);
      const transactionIndex = block.signatures.indexOf(environment.launchSignature);
      if (transactionIndex < 0) throw new Error("HOLDER_LAUNCH_SIGNATURE_NOT_IN_BLOCK");
      return { blockhash: block.blockhash, blockTime: block.blockTime, transactionIndex };
    }));
    const position = requireMatchingValues(positions, "HOLDER_LAUNCH_BLOCK_RPC_DISAGREEMENT");
    if (position.blockhash !== launch.blockhash || position.blockTime !== launch.blockTime) throw new Error("HOLDER_LAUNCH_BLOCK_MISMATCH");
    unique.set(environment.launchSignature, { signature: environment.launchSignature, slot: launch.slot, transactionIndex: position.transactionIndex });
  }
  for (const row of previous?.transactions ?? []) {
    if (row.slot >= backfillArgs.fromSlot && row.blockTime <= args.finalizedThroughTime && !unique.has(row.signature)) {
      throw new Error("HOLDER_INDEX_PREVIOUS_TRANSFER_MISSING");
    }
  }
  const cachedBySignature = new Map((previous?.transactions ?? []).map((row) => [row.signature, row]));
  const refreshed: CachedJournal["transactions"] = [];
  const discovered = [...unique.values()];
  for (let index = 0; index < discovered.length; index += 4) {
    refreshed.push(...await Promise.all(discovered.slice(index, index + 4).map(async (row) => {
      const cached = cachedBySignature.get(row.signature);
      if (cached) {
        if (cached.slot !== row.slot || cached.transactionIndex !== row.transactionIndex
          || (row.blockhash !== undefined && cached.blockhash !== row.blockhash)
          || (row.blockTime !== undefined && cached.blockTime !== row.blockTime)) {
          throw new Error("HOLDER_INDEX_CACHED_TRANSACTION_CONFLICT");
        }
        return cached;
      }
      const agreedBlockPosition = row.blockhash !== undefined && row.blockTime !== undefined
        ? { signature: row.signature, slot: row.slot, transactionIndex: row.transactionIndex,
          blockhash: row.blockhash, blockTime: row.blockTime }
        : undefined;
      const transaction = row.signature === environment.launchSignature && verifiedLaunch
        ? verifiedLaunch : await readAgreedFinalizedTransaction(environment.rpcUrls, row.signature, environment.mint,
          { includeOrderedMovements: true, agreedBlockPosition });
      if (!transaction || transaction.slot !== row.slot || transaction.blockTime < environment.launchTime
        || transaction.blockTime > args.finalizedThroughTime
        || (agreedBlockPosition && (transaction.blockhash !== agreedBlockPosition.blockhash
          || transaction.blockTime !== agreedBlockPosition.blockTime
          || transaction.transactionIndex !== agreedBlockPosition.transactionIndex
          || transaction.signature !== agreedBlockPosition.signature))) {
        throw new Error("HOLDER_INDEX_TRANSACTION_UNVERIFIED");
      }
      return {
        ...row,
        blockTime: transaction.blockTime,
        blockhash: transaction.blockhash,
        transfers: holderMovements(transaction, row.transactionIndex).map((movement) => ({ ...movement, rawAmount: movement.rawAmount.toString() })),
      };
    })));
  }
  const retained = (previous?.transactions ?? []).filter((row) => row.slot < backfillArgs.fromSlot);
  const transactions = [...retained, ...refreshed].sort((a, b) => a.slot - b.slot || a.transactionIndex - b.transactionIndex || a.signature.localeCompare(b.signature));
  if (new Set(transactions.map((row) => row.signature)).size !== transactions.length) throw new Error("HOLDER_INDEX_DUPLICATE_TRANSACTION");
  if (!transactions.length || transactions[0].signature !== environment.launchSignature || transactions[0].slot !== environment.launchSlot) throw new Error("HOLDER_LAUNCH_MINT_NOT_INDEXED");
  let priorSlot = environment.launchSlot;
  let priorTime = environment.launchTime;
  for (const row of transactions) {
    if (row.blockTime < priorTime || row.blockTime < environment.launchTime
      || row.slot === priorSlot && row.blockTime !== priorTime) throw new Error("HOLDER_INDEX_TIME_REGRESSION");
    priorSlot = row.slot;
    priorTime = row.blockTime;
  }
  const cachePayload: Omit<CachedJournal, "digest"> = {
    version: 3, mint: environment.mint, launchSlot: environment.launchSlot, launchSignature: environment.launchSignature, launchTime: environment.launchTime,
    indexedThroughSlot: args.finalizedThroughSlot, indexedThroughTime: args.finalizedThroughTime, transactions,
    coverage: { kind: "two-rpc-finalized-full-blocks", fromSlot: environment.launchSlot,
      throughSlot: args.finalizedThroughSlot, throughBlockhash: args.finalizedBlockhash },
  };
  const cache: CachedJournal = { ...cachePayload, digest: holderCacheDigest(cachePayload) };
  const current = await readJsonIfExists<RewardEpochPlan>(resolve(environment.stateRoot, "reward-epochs", "current.json"));
  // A completed full-ledger scan may be acknowledged only after every
  // discovered candidate was independently re-read and the journal passed its
  // overlap and ordering checks. If the following durable cache write fails,
  // the next run safely rescans rather than advancing an incomplete cursor.
  await source.acknowledgeFinalizedBlocks(backfillArgs);
  await writeDurableJson(path, cache);

  if (current) {
    if (current.version !== 4) throw new Error("HOLDER_OLD_REWARD_PLAN_UNSAFE");
    assertRewardPlanHash(current);
    if (current.capitalMint !== environment.mint || current.launchSignature !== environment.launchSignature
      || current.coverage.fromSlot !== environment.launchSlot
      || !Number.isSafeInteger(current.windowEnd) || current.windowEnd < environment.launchTime
      || current.windowEnd > args.finalizedThroughTime
      || current.finalizedThroughSlot > args.finalizedThroughSlot) {
      throw new Error("HOLDER_PREVIOUS_PLAN_IDENTITY_MISMATCH");
    }
  }
  if (current && !current.finalized) return { indexed: transactions.length, published: false };
  const windowStart = current?.windowEnd ?? environment.launchTime;
  const epochId = current ? BigInt(current.epochId) + 1n : 1n;
  if (args.finalizedThroughTime - windowStart < environment.epochSeconds) return { indexed: transactions.length, published: false };
  const journal: FinalizedHolderJournal = {
    version: 3,
    epochId: epochId.toString(),
    capitalMint: environment.mint,
    launchSignature: environment.launchSignature,
    windowStart,
    windowEnd: args.finalizedThroughTime,
    finalizedThroughSlot: args.finalizedThroughSlot,
    finalizedBlockhash: args.finalizedBlockhash,
    coverage: cache.coverage,
    transfers: transactions.flatMap((row) => row.transfers),
  };
  await writeDurableJson(environment.journalPath, journal);
  return { indexed: transactions.length, published: true, epochId: journal.epochId, hash: createHash("sha256").update(JSON.stringify(journal)).digest("hex") };
}
