export const HOUR = 60 * 60;
export const DAY = 24 * HOUR;
export const MAX_LOYALTY_HOURS = 30 * 24;
export const BASE_BPS = 10_000;
export const MAX_LOYALTY_BPS = 15_000;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface TransferEvent {
  from: string;
  to: string;
  amount: bigint;
  timestamp: number;
}

export interface TokenLot {
  amount: bigint;
  acquiredAt: number;
}

function addressKey(address: string): string {
  return address.toLowerCase();
}

/**
 * Front-loaded loyalty curve agreed for the project:
 * 1.00x at hour zero, rising with sqrt(age / 720), capped at 1.50x.
 */
export function loyaltyBps(ageSeconds: number): number {
  if (ageSeconds <= 0) return BASE_BPS;
  const ageHours = Math.min(Math.floor(ageSeconds / HOUR), MAX_LOYALTY_HOURS);
  const bonus = Math.floor(5_000 * Math.sqrt(ageHours / MAX_LOYALTY_HOURS));
  return BASE_BPS + bonus;
}

/**
 * Integrates amount × seconds × loyalty coefficient. The loyalty coefficient
 * changes on every complete holding hour, while raw holding time is exact to a second.
 */
export function weightedTokenSeconds(
  amount: bigint,
  acquiredAt: number,
  fromTimestamp: number,
  toTimestamp: number
): bigint {
  if (amount <= 0n || toTimestamp <= fromTimestamp) return 0n;

  let cursor = Math.max(fromTimestamp, acquiredAt);
  let total = 0n;
  while (cursor < toTimestamp) {
    const age = cursor - acquiredAt;
    const completedHours = Math.floor(age / HOUR);
    const nextHourBoundary = completedHours >= MAX_LOYALTY_HOURS
      ? toTimestamp
      : acquiredAt + (completedHours + 1) * HOUR;
    const segmentEnd = Math.min(toTimestamp, nextHourBoundary);
    const seconds = BigInt(segmentEnd - cursor);
    total += amount * seconds * BigInt(loyaltyBps(age)) / BigInt(BASE_BPS);
    cursor = segmentEnd;
  }
  return total;
}

/**
 * Replays ERC-20 Transfer events. Every incoming transfer creates a new lot.
 * Partial sales consume newest lots first, preserving the age of a holder's core position.
 */
export class HoldingWeightEngine {
  private readonly lots = new Map<string, TokenLot[]>();
  private readonly weights = new Map<string, bigint>();
  private readonly lastAccruedAt = new Map<string, number>();

  constructor(
    private readonly windowStart: number,
    private readonly windowEnd: number,
    private readonly excludedAddresses = new Set<string>()
  ) {
    if (windowEnd <= windowStart) throw new Error("INVALID_WINDOW");
    this.excludedAddresses = new Set([...excludedAddresses].map(addressKey));
  }

  apply(event: TransferEvent): void {
    if (event.timestamp > this.windowEnd) return;
    if (event.amount < 0n) throw new Error("NEGATIVE_AMOUNT");

    const from = addressKey(event.from);
    const to = addressKey(event.to);
    if (from === to || event.amount === 0n) return;

    if (from !== ZERO_ADDRESS) {
      this.accrue(from, event.timestamp);
      this.consumeNewestFirst(from, event.amount);
    }

    if (to !== ZERO_ADDRESS) {
      this.accrue(to, event.timestamp);
      const accountLots = this.lots.get(to) ?? [];
      accountLots.push({ amount: event.amount, acquiredAt: event.timestamp });
      this.lots.set(to, accountLots);
      if (!this.lastAccruedAt.has(to)) this.lastAccruedAt.set(to, Math.max(event.timestamp, this.windowStart));
    }
  }

  finalize(): Map<string, bigint> {
    for (const account of this.lots.keys()) this.accrue(account, this.windowEnd);
    return new Map(this.weights);
  }

  getLots(account: string): readonly TokenLot[] {
    return [...(this.lots.get(addressKey(account)) ?? [])];
  }

  private accrue(account: string, until: number): void {
    const start = Math.max(this.lastAccruedAt.get(account) ?? this.windowStart, this.windowStart);
    const end = Math.min(until, this.windowEnd);
    if (end <= start || this.excludedAddresses.has(account)) {
      this.lastAccruedAt.set(account, end);
      return;
    }

    let added = 0n;
    for (const lot of this.lots.get(account) ?? []) {
      added += weightedTokenSeconds(lot.amount, lot.acquiredAt, start, end);
    }
    this.weights.set(account, (this.weights.get(account) ?? 0n) + added);
    this.lastAccruedAt.set(account, end);
  }

  private consumeNewestFirst(account: string, amount: bigint): void {
    const accountLots = this.lots.get(account) ?? [];
    let remaining = amount;
    for (let i = accountLots.length - 1; i >= 0 && remaining > 0n; --i) {
      const lot = accountLots[i];
      const consumed = lot.amount < remaining ? lot.amount : remaining;
      lot.amount -= consumed;
      remaining -= consumed;
      if (lot.amount === 0n) accountLots.splice(i, 1);
    }
    if (remaining !== 0n) throw new Error("TRANSFER_EXCEEDS_BALANCE");
    this.lots.set(account, accountLots);
  }
}

export function governanceLookbackSeconds(projectAgeSeconds: number): number {
  if (projectAgeSeconds <= 0) throw new Error("PROJECT_NOT_LIVE");
  return Math.min(projectAgeSeconds, DAY);
}

