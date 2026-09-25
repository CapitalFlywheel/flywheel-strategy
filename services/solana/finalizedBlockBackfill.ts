import { createHash, randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, PublicKey, type VersionedBlockResponse } from "@solana/web3.js";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import type { DiscoveredTransferTransaction } from "./holderJournal";
import { assertIndependentRpcProviders, requireMatchingValues } from "./rpcConsensus";
import { assertReadableTransactionVersion, MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION } from "./rpcTransactionVersion";

interface BackfillCheckpoint {
  version: 2;
  mint: string;
  fromSlot: number;
  throughSlot: number;
  throughBlockhash: string;
  throughTime: number;
  nextSlot: number;
  transactions: DiscoveredTransferTransaction[];
  digest: string;
}

export interface FinalizedBlockBackfillArgs {
  mint: string;
  fromSlot: number;
  throughSlot: number;
  throughBlockhash: string;
  throughTime: number;
  stateRoot: string;
  rpcUrls: readonly [string, string];
  maxSlotsPerRun?: number;
  /** Maximum produced slots fetched at once (two RPC requests per slot). */
  blockConcurrency?: number;
}

const checkpointPath = (stateRoot: string) => resolve(stateRoot, "recovery", "capital-block-backfill.json");
const checkpointDigest = (value: Omit<BackfillCheckpoint, "digest">) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function validateCheckpoint(value: BackfillCheckpoint): BackfillCheckpoint {
  if (value?.version !== 2 || !value.mint || !Number.isSafeInteger(value.fromSlot) || value.fromSlot < 0
    || !Number.isSafeInteger(value.throughSlot) || value.throughSlot < value.fromSlot
    || !Number.isSafeInteger(value.nextSlot) || value.nextSlot < value.fromSlot || value.nextSlot > value.throughSlot + 1
    || !value.throughBlockhash || !Number.isSafeInteger(value.throughTime) || value.throughTime <= 0
    || !Array.isArray(value.transactions) || !/^[a-f0-9]{64}$/.test(value.digest)) {
    throw new Error("HOLDER_BACKFILL_CHECKPOINT_INVALID");
  }
  const { digest, ...payload } = value;
  if (checkpointDigest(payload) !== digest) throw new Error("HOLDER_BACKFILL_CHECKPOINT_INVALID");
  const seen = new Set<string>();
  for (const row of value.transactions) {
    if (!row.signature || !Number.isSafeInteger(row.slot) || row.slot < value.fromSlot || row.slot >= value.nextSlot
      || !Number.isSafeInteger(row.transactionIndex) || row.transactionIndex < 0 || seen.has(row.signature)
      || ((row.blockhash !== undefined || row.blockTime !== undefined)
        && (typeof row.blockhash !== "string" || !row.blockhash
          || !Number.isSafeInteger(row.blockTime) || row.blockTime! <= 0))) {
      throw new Error("HOLDER_BACKFILL_CHECKPOINT_INVALID");
    }
    seen.add(row.signature);
  }
  return value;
}

async function readCheckpoint(stateRoot: string): Promise<BackfillCheckpoint | undefined> {
  const value = await readJsonIfExists<BackfillCheckpoint>(checkpointPath(stateRoot));
  if (Number(value?.version) === 1) {
    // Version 1 predates mint-key candidate detection and cannot prove full
    // coverage for transient token accounts. Preserve it for audit, then
    // rescan from the caller's trusted cache cursor or launch slot.
    await rename(checkpointPath(stateRoot), `${checkpointPath(stateRoot)}.superseded-${randomUUID()}`);
    return undefined;
  }
  return value ? validateCheckpoint(value) : undefined;
}

async function saveCheckpoint(stateRoot: string, payload: Omit<BackfillCheckpoint, "digest">) {
  await writeDurableJson(checkpointPath(stateRoot), { ...payload, digest: checkpointDigest(payload) });
}

export async function pendingFinalizedBlockBackfillTarget(stateRoot: string, mint: string, launchSlot: number) {
  const checkpoint = await readCheckpoint(stateRoot);
  if (!checkpoint) return undefined;
  if (checkpoint.mint !== new PublicKey(mint).toBase58() || checkpoint.fromSlot < launchSlot) {
    throw new Error("HOLDER_BACKFILL_IDENTITY_MISMATCH");
  }
  return { slot: checkpoint.throughSlot, blockhash: checkpoint.throughBlockhash, blockTime: checkpoint.throughTime };
}

function blockSummary(block: VersionedBlockResponse, slot: number, mint: string) {
  if (!block || !block.blockhash || !Number.isSafeInteger(block.blockTime) || (block.blockTime ?? 0) <= 0
    || !Array.isArray(block.transactions)) throw new Error("HOLDER_BACKFILL_BLOCK_INVALID");
  const candidates: DiscoveredTransferTransaction[] = [];
  const signatures: string[] = [];
  const succeeded: boolean[] = [];
  const versions: Array<"legacy" | 0 | 1> = [];
  for (let index = 0; index < block.transactions.length; index += 1) {
    const row = block.transactions[index];
    const signature = row.transaction?.signatures?.[0];
    if (!signature || !row.meta || row.meta.err === undefined) throw new Error("HOLDER_BACKFILL_TRANSACTION_META_MISSING");
    assertReadableTransactionVersion(row.version);
    const message = row.transaction.message;
    const staticKeys = message.staticAccountKeys;
    const lookups = message.addressTableLookups;
    const loaded = row.meta.loadedAddresses;
    if (!Array.isArray(staticKeys) || !staticKeys.every((key) => key instanceof PublicKey)
      || !Array.isArray(lookups)) throw new Error("HOLDER_BACKFILL_ACCOUNT_KEYS_MISSING");
    if (loaded && (!Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly)
      || ![...loaded.writable, ...loaded.readonly].every((key) => key instanceof PublicKey))) {
      throw new Error("HOLDER_BACKFILL_LOADED_ADDRESSES_INVALID");
    }
    // v1 has no address lookup tables. Never fabricate missing account keys
    // from an inconsistent RPC response when deciding whether a mint moved.
    if ((row.version !== 0 && lookups.length > 0)
      || (lookups.length === 0 && ((loaded?.writable.length ?? 0) > 0 || (loaded?.readonly.length ?? 0) > 0))) {
      throw new Error("HOLDER_BACKFILL_ADDRESS_LAYOUT_INVALID");
    }
    if (lookups.length > 0 && !loaded) throw new Error("HOLDER_BACKFILL_LOADED_ADDRESSES_MISSING");
    signatures.push(signature);
    succeeded.push(row.meta.err === null);
    versions.push(row.version);
    if (row.meta.err !== null) continue;
    // A provider that omits token-balance arrays cannot prove that this mint
    // was absent from the transaction. Do not treat missing arrays as empty.
    if (!Array.isArray(row.meta.preTokenBalances) || !Array.isArray(row.meta.postTokenBalances)) {
      throw new Error("HOLDER_BACKFILL_TOKEN_BALANCES_MISSING");
    }
    const accountMentionsMint = [...staticKeys, ...(loaded?.writable ?? []),
      ...(loaded?.readonly ?? [])].some((key) => key.toBase58() === mint);
    if (accountMentionsMint || [...row.meta.preTokenBalances, ...row.meta.postTokenBalances]
      .some((balance) => balance.mint === mint)) {
      candidates.push({ signature, slot, transactionIndex: index,
        blockhash: block.blockhash, blockTime: block.blockTime! });
    }
  }
  if (new Set(signatures).size !== signatures.length) throw new Error("HOLDER_BACKFILL_DUPLICATE_SIGNATURE");
  return { blockhash: block.blockhash, blockTime: block.blockTime!, signatures, succeeded, versions, candidates };
}

/**
 * Scan every finalized produced slot, not merely the transaction IDs returned
 * by an index vendor. Checkpoint only after both independent RPCs agree on the
 * complete block signature list and on which transactions touch the mint.
 */
export async function discoverFinalizedBlockTransfers(args: FinalizedBlockBackfillArgs): Promise<DiscoveredTransferTransaction[]> {
  const mint = new PublicKey(args.mint).toBase58();
  assertIndependentRpcProviders(args.rpcUrls);
  if (!Number.isSafeInteger(args.fromSlot) || args.fromSlot < 0 || !Number.isSafeInteger(args.throughSlot)
    || args.throughSlot < args.fromSlot || !args.throughBlockhash
    || !Number.isSafeInteger(args.throughTime) || args.throughTime <= 0) throw new Error("HOLDER_BACKFILL_RANGE_INVALID");
  const maxSlotsPerRun = args.maxSlotsPerRun ?? 512;
  if (!Number.isSafeInteger(maxSlotsPerRun) || maxSlotsPerRun < 1 || maxSlotsPerRun > 2048) {
    throw new Error("HOLDER_BACKFILL_BUDGET_INVALID");
  }
  const blockConcurrency = args.blockConcurrency ?? 4;
  if (!Number.isSafeInteger(blockConcurrency) || blockConcurrency < 1 || blockConcurrency > 8) {
    throw new Error("HOLDER_BACKFILL_CONCURRENCY_INVALID");
  }
  let checkpoint = await readCheckpoint(args.stateRoot);
  if (checkpoint && checkpoint.mint === mint && checkpoint.throughSlot === args.throughSlot
    && checkpoint.throughBlockhash === args.throughBlockhash && checkpoint.throughTime === args.throughTime
    && args.fromSlot < checkpoint.fromSlot) {
    // A prior vendor-only cursor may have started a partial overlap scan.
    // It cannot prove launch-to-target completeness. Preserve that checkpoint
    // for audit and restart from the earlier requested slot, never skip it.
    await rename(checkpointPath(args.stateRoot), `${checkpointPath(args.stateRoot)}.superseded-${randomUUID()}`);
    checkpoint = undefined;
  }
  if (checkpoint && (checkpoint.mint !== mint || checkpoint.fromSlot !== args.fromSlot
    || checkpoint.throughSlot !== args.throughSlot || checkpoint.throughBlockhash !== args.throughBlockhash
    || checkpoint.throughTime !== args.throughTime)) {
    throw new Error("HOLDER_BACKFILL_TARGET_MISMATCH");
  }
  if (!checkpoint) {
    const payload: Omit<BackfillCheckpoint, "digest"> = {
      version: 2, mint, fromSlot: args.fromSlot, throughSlot: args.throughSlot,
      throughBlockhash: args.throughBlockhash, throughTime: args.throughTime,
      nextSlot: args.fromSlot, transactions: [],
    };
    await saveCheckpoint(args.stateRoot, payload);
    checkpoint = { ...payload, digest: checkpointDigest(payload) };
  }
  if (checkpoint.nextSlot > checkpoint.throughSlot) return checkpoint.transactions;
  const connections = args.rpcUrls.map((url) => new Connection(url, "finalized"));
  const floors = await Promise.all(connections.map((connection) => connection.getFirstAvailableBlock()));
  const resumeSlot = checkpoint.nextSlot;
  if (floors.some((floor) => floor > resumeSlot)) throw new Error("HOLDER_BACKFILL_ARCHIVE_UNAVAILABLE");

  const endThisRun = Math.min(checkpoint.throughSlot, checkpoint.nextSlot + maxSlotsPerRun - 1);
  const pinnedTargetSlot = checkpoint.throughSlot;
  const pinnedTargetBlockhash = checkpoint.throughBlockhash;
  const pinnedTargetTime = checkpoint.throughTime;
  while (checkpoint.nextSlot <= endThisRun) {
    const start = checkpoint.nextSlot;
    const end = Math.min(endThisRun, start + 31);
    const produced = requireMatchingValues(await Promise.all(connections.map((connection) =>
      connection.getBlocks(start, end, "finalized"))), "HOLDER_BACKFILL_SLOT_RPC_DISAGREEMENT");
    if (!Array.isArray(produced) || produced.some((slot, index) => !Number.isSafeInteger(slot)
      || slot < start || slot > end || (index > 0 && slot <= produced[index - 1]))) {
      throw new Error("HOLDER_BACKFILL_SLOTS_INVALID");
    }
    if (end === pinnedTargetSlot && !produced.includes(pinnedTargetSlot)) {
      throw new Error("HOLDER_BACKFILL_TARGET_BLOCK_MISSING");
    }
    const nextRows: DiscoveredTransferTransaction[] = [];
    for (let offset = 0; offset < produced.length; offset += blockConcurrency) {
      const verified = await Promise.all(produced.slice(offset, offset + blockConcurrency).map(async (slot) => {
        const summaries = await Promise.all(connections.map(async (connection) => {
          const block = await connection.getBlock(slot, {
            commitment: "finalized", transactionDetails: "full", rewards: false,
            maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
          });
          if (!block) throw new Error("HOLDER_BACKFILL_BLOCK_UNAVAILABLE");
          return blockSummary(block, slot, mint);
        }));
        const agreed = requireMatchingValues(summaries, "HOLDER_BACKFILL_BLOCK_RPC_DISAGREEMENT");
        if (slot === pinnedTargetSlot && (agreed.blockhash !== pinnedTargetBlockhash
          || agreed.blockTime !== pinnedTargetTime)) {
          throw new Error("HOLDER_BACKFILL_TARGET_BLOCK_MISMATCH");
        }
        return agreed;
      }));
      for (const summary of verified) nextRows.push(...summary.candidates);
    }
    const payload: Omit<BackfillCheckpoint, "digest"> = {
      version: 2, mint, fromSlot: checkpoint.fromSlot, throughSlot: checkpoint.throughSlot,
      throughBlockhash: checkpoint.throughBlockhash, throughTime: checkpoint.throughTime,
      nextSlot: end + 1,
      transactions: [...checkpoint.transactions, ...nextRows],
    };
    await saveCheckpoint(args.stateRoot, payload);
    checkpoint = { ...payload, digest: checkpointDigest(payload) };
  }
  if (checkpoint.nextSlot <= checkpoint.throughSlot) throw new Error("HOLDER_INDEX_BACKFILL_IN_PROGRESS");
  return checkpoint.transactions;
}

export async function acknowledgeFinalizedBlockBackfill(args: FinalizedBlockBackfillArgs) {
  const checkpoint = await readCheckpoint(args.stateRoot);
  if (!checkpoint || checkpoint.mint !== args.mint || checkpoint.fromSlot !== args.fromSlot
    || checkpoint.throughSlot !== args.throughSlot || checkpoint.throughBlockhash !== args.throughBlockhash
    || checkpoint.throughTime !== args.throughTime
    || checkpoint.nextSlot <= checkpoint.throughSlot) throw new Error("HOLDER_BACKFILL_ACK_INVALID");
  await unlink(checkpointPath(args.stateRoot));
}
