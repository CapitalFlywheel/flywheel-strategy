export const governanceActions = [
  "ACCUMULATE",
  "BUYBACK_HOLD",
  "BUYBACK_BURN",
  "BUYBACK_LOCK",
  "LOCK_MSTR",
  "MARKETING_SALE",
] as const;

export const governanceLocks = [
  "1_MONTH", "3_MONTHS", "6_MONTHS", "1_YEAR",
  "2_YEARS", "3_YEARS", "5_YEARS", "FOREVER",
] as const;

export type GovernanceAction = typeof governanceActions[number];
export type GovernanceLock = typeof governanceLocks[number];

export interface GovernanceDraftOption {
  action: GovernanceAction;
  reservePercent?: number;
  lock?: GovernanceLock;
}

export interface GovernanceDraft {
  durationHours: number;
  options: GovernanceDraftOption[];
}

const actionSet = new Set<string>(governanceActions);
const lockSet = new Set<string>(governanceLocks);
const needsLock = new Set<GovernanceAction>(["BUYBACK_LOCK", "LOCK_MSTR"]);

function fail(code: string): never {
  throw new Error(`GOVERNANCE_DRAFT_${code}`);
}

export function normalizeGovernanceDraft(payload: unknown): GovernanceDraft {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("INVALID");
  const source = payload as Record<string, unknown>;
  const durationHours = Number(source.durationHours);
  if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 12) fail("BAD_DURATION");
  if (!Array.isArray(source.options) || source.options.length < 2 || source.options.length > 6) {
    fail("BAD_OPTION_COUNT");
  }

  const seen = new Set<string>();
  const options = source.options.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("BAD_OPTION");
    const option = value as Record<string, unknown>;
    if (typeof option.action !== "string" || !actionSet.has(option.action) || seen.has(option.action)) {
      fail("BAD_OR_DUPLICATE_ACTION");
    }
    const action = option.action as GovernanceAction;
    seen.add(action);

    if (action === "ACCUMULATE") return { action };

    const reservePercent = Number(option.reservePercent);
    if (!Number.isInteger(reservePercent) || reservePercent < 1 || reservePercent > 100) {
      fail("BAD_RESERVE_PERCENT");
    }

    if (needsLock.has(action)) {
      if (typeof option.lock !== "string" || !lockSet.has(option.lock)) fail("BAD_LOCK");
      return { action, reservePercent, lock: option.lock as GovernanceLock };
    }
    if (option.lock !== undefined) fail("UNEXPECTED_LOCK");
    return { action, reservePercent };
  });

  return { durationHours, options };
}
