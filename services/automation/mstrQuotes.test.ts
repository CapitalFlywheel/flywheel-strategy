import { describe, expect, it } from "vitest";
import { bestQuote, minimumAfterSlippage, type RouteQuote } from "./mstrQuotes";

describe("MSTR route quotes", () => {
  it("sets the execution floor exactly 20% below the fresh quote", () => {
    expect(minimumAfterSlippage(1000n)).toBe(800n);
  });

  it("selects the route returning more MSTR", () => {
    const quotes: RouteQuote[] = [
      { route: "V3_WETH_MSTR", amountOut: 90n, minimumOut: 72n, gasEstimate: 1n },
      { route: "V4_WETH_USDG_MSTR", amountOut: 100n, minimumOut: 80n, gasEstimate: 2n },
    ];
    expect(bestQuote(quotes).route).toBe("V4_WETH_USDG_MSTR");
  });

  it("rejects empty and invalid values", () => {
    expect(() => minimumAfterSlippage(0n)).toThrow("EMPTY_QUOTE");
    expect(() => minimumAfterSlippage(1n, 10_000n)).toThrow("INVALID_SLIPPAGE");
    expect(() => bestQuote([])).toThrow("NO_ROUTES");
  });
});
