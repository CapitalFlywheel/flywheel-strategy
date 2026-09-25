import { PublicKey } from "@solana/web3.js";

export const GOVERNANCE_MIN_DURATION_SECONDS = 60 * 60;
export const GOVERNANCE_MAX_DURATION_SECONDS = 12 * 60 * 60;
export const GOVERNANCE_EXECUTION_DELAY_SECONDS = 5 * 60;
export const GOVERNANCE_QUORUM_BPS = 700;
export const GOVERNANCE_PERMANENT_LOCK_SECONDS = 0xffff_ffff;
export const GOVERNANCE_LOOKBACK_SECONDS = 24 * 60 * 60;

export const RESERVE_ACTIONS = [
  "ACCUMULATE",
  "BUYBACK_HOLD",
  "BUYBACK_BURN",
  "BUYBACK_LOCK",
  "LOCK_MSTRX",
  "MARKETING_SALE",
] as const;

export type ReserveAction = typeof RESERVE_ACTIONS[number];
export interface GovernanceOption {
  action: ReserveAction;
  lockDurationSeconds?: number;
  recipient?: string;
  /** CAPITAL raw units for buybacks, lamports for marketing sale; zero otherwise. */
  minOutputRaw?: bigint;
}

export interface FrozenGovernanceOption extends GovernanceOption {
  reserveRawMstrx: bigint;
  minOutputRaw: bigint;
}

export interface GovernanceProposal {
  id: bigint;
  startsAt: number;
  endsAt: number;
  executableAt: number;
  snapshotRoot: string;
  totalAvailableWeight: bigint;
  frozenReserveRawMstrx: bigint;
  options: FrozenGovernanceOption[];
}

export type GovernanceResult =
  | { status: "rejected"; reason: "QUORUM_NOT_REACHED" | "TIED_RESULT" }
  | { status: "executed"; winningOption: number; action: FrozenGovernanceOption; winningWeight: bigint; releasedRawMstrx: bigint }
  | { status: "passed"; winningOption: number; action: FrozenGovernanceOption; winningWeight: bigint };

const LOCK_DURATIONS = new Set([
  ...[30, 90, 180, 365, 730, 1095, 1825].map((days) => days * 86_400),
  GOVERNANCE_PERMANENT_LOCK_SECONDS,
]);
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

function assertPublicKey(value: string) {
  if (new PublicKey(value).toBase58() !== value) throw new Error("GOVERNANCE_RECIPIENT_INVALID");
}

export function governanceWindowStart(snapshotAt: number, launchedAt: number) {
  if (!Number.isSafeInteger(snapshotAt) || !Number.isSafeInteger(launchedAt)
    || launchedAt <= 0 || snapshotAt <= launchedAt) throw new Error("GOVERNANCE_WINDOW_INVALID");
  return Math.max(launchedAt, snapshotAt - GOVERNANCE_LOOKBACK_SECONDS);
}

/**
 * Pure reference policy for the Solana governance implementation. This does
 * not authorize a vote or a reserve transfer: the deployed program must
 * enforce the same rules against its own custody state.
 */
export function freezeGovernanceProposal(input: {
  id: bigint;
  now: number;
  votingDurationSeconds: number;
  snapshotRoot: string;
  totalAvailableWeight: bigint;
  availableReserveRawMstrx: bigint;
  options: readonly GovernanceOption[];
  marketingWallet?: string;
}): GovernanceProposal {
  if (input.id <= 0n || input.id > U64_MAX || !Number.isSafeInteger(input.now) || input.now <= 0) throw new Error("GOVERNANCE_ID_OR_TIME_INVALID");
  if (!Number.isInteger(input.votingDurationSeconds)
    || input.votingDurationSeconds < GOVERNANCE_MIN_DURATION_SECONDS
    || input.votingDurationSeconds > GOVERNANCE_MAX_DURATION_SECONDS) throw new Error("GOVERNANCE_DURATION_INVALID");
  if (!/^[a-f0-9]{64}$/i.test(input.snapshotRoot) || /^0{64}$/i.test(input.snapshotRoot)
    || input.totalAvailableWeight <= 0n || input.totalAvailableWeight > U128_MAX) throw new Error("GOVERNANCE_SNAPSHOT_INVALID");
  if (input.availableReserveRawMstrx <= 0n || input.availableReserveRawMstrx > U64_MAX) throw new Error("GOVERNANCE_RESERVE_AMOUNT_INVALID");
  if (input.options.length < 2 || input.options.length > RESERVE_ACTIONS.length) throw new Error("GOVERNANCE_OPTIONS_INVALID");

  const seen = new Set<ReserveAction>();
  const options = input.options.map((option): FrozenGovernanceOption => {
    if (!RESERVE_ACTIONS.includes(option.action) || seen.has(option.action)) throw new Error("GOVERNANCE_OPTION_DUPLICATE_OR_UNKNOWN");
    seen.add(option.action);
    const duration = option.lockDurationSeconds ?? 0;
    if (option.action === "BUYBACK_LOCK" || option.action === "LOCK_MSTRX") {
      if (!LOCK_DURATIONS.has(duration)) throw new Error("GOVERNANCE_LOCK_DURATION_INVALID");
    } else if (duration !== 0) throw new Error("GOVERNANCE_LOCK_DURATION_UNEXPECTED");

    if (option.action === "MARKETING_SALE") {
      if (!input.marketingWallet || option.recipient !== input.marketingWallet) throw new Error("GOVERNANCE_MARKETING_RECIPIENT_INVALID");
      assertPublicKey(option.recipient);
    } else if (option.recipient) throw new Error("GOVERNANCE_RECIPIENT_UNEXPECTED");

    const minOutputRaw = option.minOutputRaw ?? 0n;
    const converts = ["BUYBACK_HOLD", "BUYBACK_BURN", "BUYBACK_LOCK", "MARKETING_SALE"].includes(option.action);
    if (typeof minOutputRaw !== "bigint" || minOutputRaw < 0n || minOutputRaw > U64_MAX
      || (converts ? minOutputRaw === 0n : minOutputRaw !== 0n)) {
      throw new Error("GOVERNANCE_MIN_OUTPUT_INVALID");
    }

    return {
      action: option.action,
      ...(duration ? { lockDurationSeconds: duration } : {}),
      ...(option.recipient ? { recipient: option.recipient } : {}),
      reserveRawMstrx: option.action === "ACCUMULATE" ? 0n : input.availableReserveRawMstrx,
      minOutputRaw,
    };
  });
  if (!seen.has("ACCUMULATE")) throw new Error("GOVERNANCE_NO_ACCUMULATE_OPTION");
  const endsAt = input.now + input.votingDurationSeconds;
  if (!Number.isSafeInteger(endsAt) || !Number.isSafeInteger(endsAt + GOVERNANCE_EXECUTION_DELAY_SECONDS)) {
    throw new Error("GOVERNANCE_TIME_OVERFLOW");
  }
  return {
    id: input.id,
    startsAt: input.now,
    endsAt,
    executableAt: endsAt + GOVERNANCE_EXECUTION_DELAY_SECONDS,
    snapshotRoot: input.snapshotRoot.toLowerCase(),
    totalAvailableWeight: input.totalAvailableWeight,
    frozenReserveRawMstrx: input.availableReserveRawMstrx,
    options,
  };
}

export function finalizeGovernanceResult(
  proposal: GovernanceProposal,
  optionWeights: readonly bigint[],
  now: number,
): GovernanceResult {
  if (!Number.isSafeInteger(now) || now < proposal.executableAt) throw new Error("GOVERNANCE_NOT_EXECUTABLE");
  if (optionWeights.length !== proposal.options.length || optionWeights.some((weight) => weight < 0n)) {
    throw new Error("GOVERNANCE_VOTES_INVALID");
  }
  const totalCast = optionWeights.reduce((total, weight) => total + weight, 0n);
  if (totalCast > proposal.totalAvailableWeight) throw new Error("GOVERNANCE_WEIGHT_EXCEEDED");
  if (totalCast * 10_000n < proposal.totalAvailableWeight * BigInt(GOVERNANCE_QUORUM_BPS)) {
    return { status: "rejected", reason: "QUORUM_NOT_REACHED" };
  }
  const winningWeight = optionWeights.reduce((maximum, weight) => weight > maximum ? weight : maximum, 0n);
  const winningOptions = optionWeights.flatMap((weight, index) => weight === winningWeight ? [index] : []);
  if (winningOptions.length !== 1) return { status: "rejected", reason: "TIED_RESULT" };
  const winningOption = winningOptions[0];
  if (proposal.options[winningOption].action === "ACCUMULATE") {
    return {
      status: "executed", winningOption, action: proposal.options[winningOption],
      winningWeight, releasedRawMstrx: proposal.frozenReserveRawMstrx,
    };
  }
  return { status: "passed", winningOption, action: proposal.options[winningOption], winningWeight };
}
