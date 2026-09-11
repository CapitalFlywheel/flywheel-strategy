import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress, type Address, type PublicClient } from "viem";
import { fetchAlchemyTransferEvents, updateTransferCache } from "./transferCache";

const token = getAddress("0x0000000000000000000000000000000000000011") as Address;
const alice = "0x00000000000000000000000000000000000000a1";
const bob = "0x00000000000000000000000000000000000000b2";
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function payload(transfers: unknown[], pageKey?: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { transfers, pageKey } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function transfer(id: string, block: number, amount: number) {
  return {
    blockNum: `0x${block.toString(16)}`,
    uniqueId: id,
    from: alice,
    to: bob,
    rawContract: { value: `0x${amount.toString(16)}`, address: token },
    metadata: { blockTimestamp: new Date(block * 1_000).toISOString() },
  };
}

describe("incremental Alchemy transfer cache", () => {
  it("reads every page and preserves raw token units", async () => {
    const requests: Record<string, unknown>[] = [];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const params = request.params[0] as Record<string, unknown>;
      requests.push(params);
      return params.pageKey
        ? payload([transfer("second", 101, 9)])
        : payload([transfer("first", 100, 7)], "next-page");
    };
    const events = await fetchAlchemyTransferEvents(
      "https://robinhood-mainnet.g.alchemy.com/v2/test", token, 100n, 101n, fakeFetch as typeof fetch
    );
    expect(events.map((event) => event.amount)).toEqual([7n, 9n]);
    expect(requests).toHaveLength(2);
    expect(requests[1].pageKey).toBe("next-page");
  });

  it("replaces a recent overlap instead of rereading the full launch history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pons-transfer-cache-"));
    created.push(directory);
    const cachePath = join(directory, "history.json");
    let round = 0;
    const fakeFetch = async () => {
      round += 1;
      return round === 1
        ? payload([transfer("old", 150, 5), transfer("replace-me", 190, 6)])
        : payload([transfer("replacement", 190, 7), transfer("new", 210, 8)]);
    };
    const base = {
      client: {} as PublicClient,
      rpcUrl: "https://robinhood-mainnet.g.alchemy.com/v2/test",
      token,
      launchBlock: 100n,
      cachePath,
      source: "alchemy" as const,
      overlapBlocks: 30n,
      fetchImplementation: fakeFetch as typeof fetch,
    };
    await updateTransferCache({ ...base, toBlock: 200n });
    const events = await updateTransferCache({ ...base, toBlock: 220n });
    expect(events.map((event) => [event.sourceId, event.amount])).toEqual([
      ["old", 5n], ["replacement", 7n], ["new", 8n],
    ]);
    const stored = JSON.parse(await readFile(cachePath, "utf8"));
    expect(stored.lastIndexedBlock).toBe("220");
    expect(stored.events).toHaveLength(3);
  });
});
