import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

export const HOUR_SECONDS = 3_600;
export const MAX_LOYALTY_HOURS = 720;

export interface SolanaTransfer {
  signature: string;
  slot: number;
  transactionIndex?: number;
  instructionIndex: number;
  timestamp: number;
  from?: string;
  to?: string;
  rawAmount: bigint;
}

interface Lot { rawAmount: bigint; acquiredAt: number }

function key(value: string) {
  return new PublicKey(value).toBase58();
}

export function loyaltyBps(ageSeconds: number) {
  if (ageSeconds <= 0) return 10_000;
  const hours = Math.min(Math.floor(ageSeconds / HOUR_SECONDS), MAX_LOYALTY_HOURS);
  return 10_000 + Math.floor(5_000 * Math.sqrt(hours / MAX_LOYALTY_HOURS));
}

export function weightedRawSeconds(rawAmount: bigint, acquiredAt: number, from: number, to: number) {
  if (rawAmount <= 0n || to <= from) return 0n;
  let cursor = Math.max(from, acquiredAt);
  let total = 0n;
  while (cursor < to) {
    const age = cursor - acquiredAt;
    const hours = Math.floor(age / HOUR_SECONDS);
    const boundary = hours >= MAX_LOYALTY_HOURS ? to : acquiredAt + (hours + 1) * HOUR_SECONDS;
    const end = Math.min(to, boundary);
    total += rawAmount * BigInt(end - cursor) * BigInt(loyaltyBps(age)) / 10_000n;
    cursor = end;
  }
  return total;
}

export class SolanaHoldingEngine {
  private readonly lots = new Map<string, Lot[]>();
  private readonly weights = new Map<string, bigint>();
  private readonly lastAccruedAt = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly excluded: Set<string>;
  private lastEventTimestamp: number | undefined;

  constructor(private readonly start: number, private readonly end: number, excluded: Iterable<string>) {
    if (end <= start) throw new Error("INVALID_WINDOW");
    this.excluded = new Set([...excluded].map(key));
  }

  apply(transfer: SolanaTransfer) {
    if (transfer.rawAmount < 0n) throw new Error("NEGATIVE_AMOUNT");
    const eventId = `${transfer.signature}:${transfer.slot}:${transfer.instructionIndex}`;
    if (this.seen.has(eventId)) return;
    if (!Number.isSafeInteger(transfer.timestamp) || transfer.timestamp < 0
      || this.lastEventTimestamp !== undefined && transfer.timestamp < this.lastEventTimestamp) {
      throw new Error("HOLDER_EVENT_TIME_REGRESSION");
    }
    this.lastEventTimestamp = transfer.timestamp;
    if (transfer.timestamp > this.end) return;
    this.seen.add(eventId);
    const from = transfer.from ? key(transfer.from) : undefined;
    const to = transfer.to ? key(transfer.to) : undefined;
    if (from && to && from === to || transfer.rawAmount === 0n) return;
    if (from) { this.accrue(from, transfer.timestamp); this.consume(from, transfer.rawAmount); }
    if (to) {
      this.accrue(to, transfer.timestamp);
      const lots = this.lots.get(to) ?? [];
      lots.push({ rawAmount: transfer.rawAmount, acquiredAt: transfer.timestamp });
      this.lots.set(to, lots);
      if (!this.lastAccruedAt.has(to)) this.lastAccruedAt.set(to, Math.max(transfer.timestamp, this.start));
    }
  }

  finalize() {
    for (const account of this.lots.keys()) this.accrue(account, this.end);
    return new Map([...this.weights].filter(([account, weight]) => !this.excluded.has(account) && weight > 0n));
  }

  private accrue(account: string, until: number) {
    // Later epochs replay launch-to-date transfers to reconstruct current
    // lots. Events before the reward window mutate lots but accrue no weight.
    if (until <= this.start) return;
    const start = Math.max(this.lastAccruedAt.get(account) ?? this.start, this.start);
    const end = Math.min(until, this.end);
    if (end < start) throw new Error("HOLDER_ACCRUAL_TIME_REGRESSION");
    if (end <= start || this.excluded.has(account)) { this.lastAccruedAt.set(account, end); return; }
    const added = (this.lots.get(account) ?? []).reduce(
      (sum, lot) => sum + weightedRawSeconds(lot.rawAmount, lot.acquiredAt, start, end), 0n,
    );
    this.weights.set(account, (this.weights.get(account) ?? 0n) + added);
    this.lastAccruedAt.set(account, end);
  }

  private consume(account: string, rawAmount: bigint) {
    const lots = this.lots.get(account) ?? [];
    let remaining = rawAmount;
    for (let index = lots.length - 1; index >= 0 && remaining > 0n; index -= 1) {
      const consumed = lots[index].rawAmount < remaining ? lots[index].rawAmount : remaining;
      lots[index].rawAmount -= consumed;
      remaining -= consumed;
      if (lots[index].rawAmount === 0n) lots.splice(index, 1);
    }
    if (remaining) throw new Error("TRANSFER_EXCEEDS_BALANCE");
    this.lots.set(account, lots);
  }
}

export interface PushAllocation { recipient: string; rawMstrx: bigint }
export interface PushBatch { id: string; allocations: PushAllocation[]; rawTotal: bigint }

export function buildPushDistribution(weights: ReadonlyMap<string, bigint>, fundedRawMstrx: bigint, batchSize = 12) {
  if (fundedRawMstrx <= 0n) throw new Error("EMPTY_REWARD");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("INVALID_BATCH_SIZE");
  const rows = [...weights].map(([recipient, weight]) => ({ recipient: key(recipient), weight })).filter((row) => row.weight > 0n).sort((a, b) => a.recipient.localeCompare(b.recipient));
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0n);
  if (!totalWeight) throw new Error("EMPTY_WEIGHT");
  const provisional = rows.map((row) => ({ ...row, rawMstrx: fundedRawMstrx * row.weight / totalWeight, remainder: fundedRawMstrx * row.weight % totalWeight }));
  let assigned = provisional.reduce((sum, row) => sum + row.rawMstrx, 0n);
  const remainderOrder = [...provisional].sort((a, b) => a.remainder === b.remainder ? a.recipient.localeCompare(b.recipient) : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; assigned < fundedRawMstrx; index += 1) { remainderOrder[index].rawMstrx += 1n; assigned += 1n; }
  const allocations = provisional.filter((row) => row.rawMstrx > 0n).map(({ recipient, rawMstrx }) => ({ recipient, rawMstrx }));
  const batches: PushBatch[] = [];
  for (let index = 0; index < allocations.length; index += batchSize) {
    const batchAllocations = allocations.slice(index, index + batchSize);
    const payload = batchAllocations.map((row) => `${row.recipient}:${row.rawMstrx}`).join("|");
    batches.push({ id: createHash("sha256").update(payload).digest("hex"), allocations: batchAllocations, rawTotal: batchAllocations.reduce((sum, row) => sum + row.rawMstrx, 0n) });
  }
  if (batches.reduce((sum, batch) => sum + batch.rawTotal, 0n) !== fundedRawMstrx) throw new Error("DISTRIBUTION_NOT_CONSERVED");
  return { fundedRawMstrx, totalWeight, allocations, batches };
}
