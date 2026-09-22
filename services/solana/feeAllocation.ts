export const BASIS_POINTS = 10_000n;
export const HOLDER_REWARD_BPS = 6_000n;
export const STRATEGIC_RESERVE_BPS = 4_000n;

export interface FeeAllocation {
  receivedRawMstrx: bigint;
  holderRawMstrx: bigint;
  reserveRawMstrx: bigint;
}

export function allocateCreatorFees(receivedRawMstrx: bigint): FeeAllocation {
  if (receivedRawMstrx < 0n) throw new Error("RECEIPTS_NEGATIVE");
  const holderRawMstrx = receivedRawMstrx * HOLDER_REWARD_BPS / BASIS_POINTS;
  const reserveRawMstrx = receivedRawMstrx - holderRawMstrx;
  return { receivedRawMstrx, holderRawMstrx, reserveRawMstrx };
}

export function assertConserved(allocation: FeeAllocation) {
  if (allocation.holderRawMstrx + allocation.reserveRawMstrx !== allocation.receivedRawMstrx) {
    throw new Error("ALLOCATION_NOT_CONSERVED");
  }
}
