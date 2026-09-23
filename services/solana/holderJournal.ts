import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { readJsonIfExists, writeDurableJson } from "./durableJson";
import { type FinalizedHolderJournal, type RewardEpochPlan } from "./epochPlanner";
import { readAgreedFinalizedTransaction, type FinalizedTokenTransaction } from "./finalizedTransfers";
import { type SolanaTransfer } from "./holderAccounting";
import { requireMatchingValues } from "./rpcConsensus";

export interface DiscoveredTransferTransaction {
  signature: string;
  slot: number;
  transactionIndex: number;
}

export interface MintTransferSource {
  discover(mint: string, fromTime: number, throughTime: number): Promise<DiscoveredTransferTransaction[]>;
}

interface CachedJournal {
  version: 1;
  mint: string;
  launchSlot: number;
  launchSignature: string;
  launchTime: number;
  indexedThroughSlot: number;
  indexedThroughTime: number;
  transactions: Array<DiscoveredTransferTransaction & { blockTime: number; blockhash: string; transfers: Array<Omit<SolanaTransfer, "rawAmount"> & { rawAmount: string }> }>;
}

function cachePath(stateRoot: string) { return resolve(stateRoot, "capital-transfers.json"); }

export function holderMovements(transaction: FinalizedTokenTransaction, transactionIndex: number) {
  const totals = new Map<string, bigint>();
  for (const delta of transaction.deltas) totals.set(delta.owner, (totals.get(delta.owner) ?? 0n) + BigInt(delta.rawAmount));
  const senders = [...totals].filter(([, amount]) => amount < 0n).sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, amount]) => ({ owner, remaining: -amount }));
  const receivers = [...totals].filter(([, amount]) => amount > 0n).sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, amount]) => ({ owner, remaining: amount }));
  const movements: SolanaTransfer[] = [];
  let instructionIndex = 0;
  let sender = 0;
  let receiver = 0;
  const add = (from: string | undefined, to: string | undefined, rawAmount: bigint) => {
    if (rawAmount <= 0n) return;
    movements.push({ signature: transaction.signature, slot: transaction.slot, transactionIndex, instructionIndex: instructionIndex++, timestamp: transaction.blockTime, from, to, rawAmount });
  };
  while (sender < senders.length && receiver < receivers.length) {
    const amount = senders[sender].remaining < receivers[receiver].remaining ? senders[sender].remaining : receivers[receiver].remaining;
    add(senders[sender].owner, receivers[receiver].owner, amount);
    senders[sender].remaining -= amount;
    receivers[receiver].remaining -= amount;
    if (senders[sender].remaining === 0n) sender += 1;
    if (receivers[receiver].remaining === 0n) receiver += 1;
  }
  for (; sender < senders.length; sender += 1) add(senders[sender].owner, undefined, senders[sender].remaining);
  for (; receiver < receivers.length; receiver += 1) add(undefined, receivers[receiver].owner, receivers[receiver].remaining);
  return movements;
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
  const previous = await readJsonIfExists<CachedJournal>(path);
  if (!environment.launchSignature) throw new Error("HOLDER_LAUNCH_SIGNATURE_REQUIRED");
  if (previous && (previous.version !== 1 || previous.mint !== environment.mint || previous.launchSlot !== environment.launchSlot || previous.launchSignature !== environment.launchSignature)) throw new Error("HOLDER_INDEX_IDENTITY_MISMATCH");
  if (previous && args.finalizedThroughSlot < previous.indexedThroughSlot) throw new Error("HOLDER_INDEX_SLOT_REWIND");
  const overlap = environment.overlapSeconds ?? 3_600;
  const fromTime = previous ? Math.max(environment.launchTime, previous.indexedThroughTime - overlap) : environment.launchTime;
  const found = await source.discover(environment.mint, fromTime, args.finalizedThroughTime + 1);
  const unique = new Map<string, DiscoveredTransferTransaction>();
  let verifiedLaunch: FinalizedTokenTransaction | undefined;
  for (const row of found) {
    if (!Number.isInteger(row.slot) || !Number.isInteger(row.transactionIndex) || row.slot < environment.launchSlot || row.slot > args.finalizedThroughSlot) continue;
    const existing = unique.get(row.signature);
    if (existing && (existing.slot !== row.slot || existing.transactionIndex !== row.transactionIndex)) throw new Error("HOLDER_INDEX_DISCOVERY_CONFLICT");
    unique.set(row.signature, row);
  }
  if (!previous && !unique.has(environment.launchSignature)) {
    // A mint-creation transaction need not appear in a Transfers cube. Seed it
    // from the independently agreed finalized transaction and block ordering.
    const launch = await readAgreedFinalizedTransaction(environment.rpcUrls, environment.launchSignature, environment.mint);
    if (!launch || launch.slot !== environment.launchSlot || launch.blockTime !== environment.launchTime) throw new Error("HOLDER_LAUNCH_TRANSACTION_UNVERIFIED");
    verifiedLaunch = launch;
    const positions = await Promise.all(environment.rpcUrls.map(async (url) => {
      const block = await new Connection(url, "finalized").getBlockSignatures(environment.launchSlot, "finalized");
      const transactionIndex = block.signatures.indexOf(environment.launchSignature);
      if (transactionIndex < 0) throw new Error("HOLDER_LAUNCH_SIGNATURE_NOT_IN_BLOCK");
      return { blockhash: block.blockhash, blockTime: block.blockTime, transactionIndex };
    }));
    const position = requireMatchingValues(positions, "HOLDER_LAUNCH_BLOCK_RPC_DISAGREEMENT");
    if (position.blockhash !== launch.blockhash || position.blockTime !== launch.blockTime) throw new Error("HOLDER_LAUNCH_BLOCK_MISMATCH");
    unique.set(environment.launchSignature, { signature: environment.launchSignature, slot: launch.slot, transactionIndex: position.transactionIndex });
  }
  // Preserve the separately verified launch transaction across overlap scans:
  // a mint creation may never be emitted by the Transfers cube.
  const cachedLaunch = previous?.transactions.find((row) => row.signature === environment.launchSignature);
  if (cachedLaunch && cachedLaunch.blockTime >= fromTime && !unique.has(environment.launchSignature)) {
    unique.set(environment.launchSignature, {
      signature: cachedLaunch.signature, slot: cachedLaunch.slot, transactionIndex: cachedLaunch.transactionIndex,
    });
  }
  for (const row of previous?.transactions ?? []) {
    if (row.blockTime >= fromTime && row.blockTime <= args.finalizedThroughTime && !unique.has(row.signature)) {
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
        if (cached.slot !== row.slot || cached.transactionIndex !== row.transactionIndex) throw new Error("HOLDER_INDEX_CACHED_TRANSACTION_CONFLICT");
        return cached;
      }
      const transaction = row.signature === environment.launchSignature && verifiedLaunch
        ? verifiedLaunch : await readAgreedFinalizedTransaction(environment.rpcUrls, row.signature, environment.mint);
      if (!transaction || transaction.slot !== row.slot || (row.signature !== environment.launchSignature && transaction.blockTime < fromTime) || transaction.blockTime > args.finalizedThroughTime) throw new Error("HOLDER_INDEX_TRANSACTION_UNVERIFIED");
      return {
        ...row,
        blockTime: transaction.blockTime,
        blockhash: transaction.blockhash,
        transfers: holderMovements(transaction, row.transactionIndex).map((movement) => ({ ...movement, rawAmount: movement.rawAmount.toString() })),
      };
    })));
  }
  const retained = (previous?.transactions ?? []).filter((row) => row.blockTime < fromTime);
  const transactions = [...retained, ...refreshed].sort((a, b) => a.slot - b.slot || a.transactionIndex - b.transactionIndex || a.signature.localeCompare(b.signature));
  if (new Set(transactions.map((row) => row.signature)).size !== transactions.length) throw new Error("HOLDER_INDEX_DUPLICATE_TRANSACTION");
  if (!transactions.length || transactions[0].signature !== environment.launchSignature || transactions[0].slot !== environment.launchSlot) throw new Error("HOLDER_LAUNCH_MINT_NOT_INDEXED");
  const cache: CachedJournal = {
    version: 1, mint: environment.mint, launchSlot: environment.launchSlot, launchSignature: environment.launchSignature, launchTime: environment.launchTime,
    indexedThroughSlot: args.finalizedThroughSlot, indexedThroughTime: args.finalizedThroughTime, transactions,
  };
  await writeDurableJson(path, cache);

  const current = await readJsonIfExists<RewardEpochPlan>(resolve(environment.stateRoot, "reward-epochs", "current.json"));
  if (current && !current.finalized) return { indexed: transactions.length, published: false };
  const windowStart = current?.windowEnd ?? environment.launchTime;
  const epochId = current ? BigInt(current.epochId) + 1n : 1n;
  if (args.finalizedThroughTime - windowStart < environment.epochSeconds) return { indexed: transactions.length, published: false };
  const journal: FinalizedHolderJournal = {
    version: 1,
    epochId: epochId.toString(),
    capitalMint: environment.mint,
    windowStart,
    windowEnd: args.finalizedThroughTime,
    finalizedThroughSlot: args.finalizedThroughSlot,
    finalizedBlockhash: args.finalizedBlockhash,
    transfers: transactions.flatMap((row) => row.transfers),
  };
  await writeDurableJson(environment.journalPath, journal);
  return { indexed: transactions.length, published: true, epochId: journal.epochId, hash: createHash("sha256").update(JSON.stringify(journal)).digest("hex") };
}
