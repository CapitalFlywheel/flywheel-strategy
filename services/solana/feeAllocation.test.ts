import { describe, expect, it } from "vitest";
import { allocateCreatorFees, assertConserved } from "./feeAllocation";

describe("creator fee allocation", () => {
  it("allocates exact receipts 60/40", () => {
    expect(allocateCreatorFees(10_000n)).toEqual({
      receivedRawMstrx: 10_000n,
      holderRawMstrx: 6_000n,
      reserveRawMstrx: 4_000n,
    });
  });

  it("assigns indivisible dust to the reserve and conserves every raw MSTRx unit", () => {
    const allocation = allocateCreatorFees(7n);
    expect(allocation).toEqual({ receivedRawMstrx: 7n, holderRawMstrx: 4n, reserveRawMstrx: 3n });
    expect(() => assertConserved(allocation)).not.toThrow();
  });

  it("rejects negative receipts", () => {
    expect(() => allocateCreatorFees(-1n)).toThrow("RECEIPTS_NEGATIVE");
  });
});
