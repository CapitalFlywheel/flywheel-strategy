import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BitqueryTransferSource } from "./bitqueryTransferSource";

const mint = Keypair.generate().publicKey.toBase58();
afterEach(() => vi.unstubAllGlobals());

function coverage(oldest: number, newest: number) {
  return new Response(JSON.stringify({ data: { Solana: { Transfers: [{ Block: {
    oldest: new Date(oldest * 1_000).toISOString(),
    newest: new Date(newest * 1_000).toISOString(),
  } }] } } }), { status: 200 });
}

describe("mint-wide transfer discovery", () => {
  it("finds distinct transactions and retains their on-chain order", async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      if (body.query.includes("TransferCoverage")) return coverage(50, 250);
      expect(body.variables.mint).toBe(mint);
      expect(body.query).toContain("MintAddress");
      return new Response(JSON.stringify({ data: { Solana: { Transfers: [
        { Block: { Slot: 12 }, Transaction: { Signature: "later", Index: 2 } },
        { Block: { Slot: 11 }, Transaction: { Signature: "earlier", Index: 1 } },
      ] } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rows = await new BitqueryTransferSource("test-key").discover(mint, 100, 200);
    expect(rows.map((row) => row.signature)).toEqual(["earlier", "later"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a silently truncated realtime history before querying a mint", async () => {
    const fetchMock = vi.fn(async () => coverage(101, 250));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new BitqueryTransferSource("test-key").discover(mint, 100, 200)).rejects.toThrow("TRANSFER_SOURCE_HISTORY_UNAVAILABLE");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses a realtime source whose tip has not reached the finalized target", async () => {
    const fetchMock = vi.fn(async () => coverage(50, 198));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new BitqueryTransferSource("test-key").discover(mint, 100, 200)).rejects.toThrow("TRANSFER_SOURCE_TAIL_UNAVAILABLE");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses missing retention evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { Solana: { Transfers: [] } } }), { status: 200 })));
    await expect(new BitqueryTransferSource("test-key").discover(mint, 100, 200)).rejects.toThrow("BITQUERY_COVERAGE_INVALID");
  });

  it("refuses an interval longer than the realtime retention safety window", async () => {
    await expect(new BitqueryTransferSource("test-key").discover(mint, 100, 100 + 6 * 3_600 + 1)).rejects.toThrow("TRANSFER_SOURCE_REALTIME_GAP");
  });

  it("fails closed on a malformed response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      return body.query.includes("TransferCoverage") ? coverage(50, 250)
        : new Response(JSON.stringify({ errors: [{ message: "denied" }] }), { status: 200 });
    }));
    await expect(new BitqueryTransferSource("test-key").discover(mint, 100, 200)).rejects.toThrow("BITQUERY_RESPONSE_INVALID");
  });
});
