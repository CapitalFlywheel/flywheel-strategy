import { describe, expect, it } from "vitest";
import { splitMstrx60_40 } from "./mstrxTransfers";

describe("MSTRx creator-fee allocation", () => {
  it("routes exact raw units 60/40 with dust assigned to reserve", () => {
    expect(splitMstrx60_40(101n)).toEqual({ grossRaw: 101n, holderRaw: 60n, reserveRaw: 41n });
    expect(splitMstrx60_40(100_000_000n)).toEqual({ grossRaw: 100_000_000n, holderRaw: 60_000_000n, reserveRaw: 40_000_000n });
  });
});
