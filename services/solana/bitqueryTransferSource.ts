import { PublicKey } from "@solana/web3.js";
import type { BitqueryBearerTokenSource } from "./bitqueryAuth";
import type { DiscoveredTransferTransaction, MintTransferSource } from "./holderJournal";

interface BitqueryRow {
  Block?: { Slot?: string | number };
  Transaction?: { Signature?: string; Index?: string | number };
}

interface BitqueryCoverageRow {
  Block?: { oldest?: string; newest?: string };
}

export class BitqueryTransferSource implements MintTransferSource {
  private readonly auth: BitqueryBearerTokenSource;

  constructor(apiKeyOrSource: string | BitqueryBearerTokenSource, private readonly endpoint = "https://streaming.bitquery.io/graphql") {
    if (typeof apiKeyOrSource === "string") {
      if (!apiKeyOrSource.trim()) throw new Error("BITQUERY_API_KEY_REQUIRED");
      this.auth = { getToken: async () => apiKeyOrSource };
    } else {
      this.auth = apiKeyOrSource;
    }
    if (!endpoint.startsWith("https://")) throw new Error("BITQUERY_ENDPOINT_HTTPS_REQUIRED");
  }

  private async post(body: string): Promise<Response> {
    const request = async () => {
      const token = await this.auth.getToken();
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error("BITQUERY_TRANSPORT_FAILED");
      }
      return response;
    };
    let response = await request();
    if (response.status === 401 && this.auth.invalidate) {
      this.auth.invalidate();
      response = await request();
    }
    return response;
  }

  async probeCoverage(fromTime: number, throughTime: number): Promise<{ oldest: number; newest: number }> {
    if (!Number.isInteger(fromTime) || !Number.isInteger(throughTime) || throughTime <= fromTime) throw new Error("TRANSFER_WINDOW_INVALID");
    // Bitquery's realtime Transfers cube has a short rolling retention window
    // and its offset pagination is not stable when many transfers share a slot
    if (throughTime - fromTime > 6 * 3_600) throw new Error("TRANSFER_SOURCE_REALTIME_GAP");
    // A realtime query outside its actual retention window can silently return
    // only the recent tail. Verify the source's global floor and tip first.
    const coverageQuery = `query TransferCoverage {
      Solana(dataset: realtime) {
        Transfers(limit: { count: 1 }) {
          Block { oldest: Time(minimum: Block_Time) newest: Time(maximum: Block_Time) }
        }
      }
    }`;
    const coverageResponse = await this.post(JSON.stringify({ query: coverageQuery }));
    if (!coverageResponse.ok) throw new Error(`BITQUERY_HTTP_${coverageResponse.status}`);
    const coverageResult = await coverageResponse.json() as { data?: { Solana?: { Transfers?: BitqueryCoverageRow[] } }; errors?: unknown[] };
    const coverage = coverageResult.data?.Solana?.Transfers?.[0]?.Block;
    const oldest = Date.parse(coverage?.oldest ?? "") / 1_000;
    const newest = Date.parse(coverage?.newest ?? "") / 1_000;
    if (coverageResult.errors?.length || !Number.isFinite(oldest) || !Number.isFinite(newest) || oldest <= 0 || newest < oldest) {
      throw new Error("BITQUERY_COVERAGE_INVALID");
    }
    if (oldest > fromTime) throw new Error("TRANSFER_SOURCE_HISTORY_UNAVAILABLE");
    if (newest < throughTime - 1) throw new Error("TRANSFER_SOURCE_TAIL_UNAVAILABLE");
    return { oldest, newest };
  }

  async discover(mint: string, fromTime: number, throughTime: number): Promise<DiscoveredTransferTransaction[]> {
    new PublicKey(mint);
    const rows: DiscoveredTransferTransaction[] = [];
    const pageSize = 500;
    await this.probeCoverage(fromTime, throughTime);
    const windows: Array<[number, number]> = [[fromTime, throughTime]];
    let queries = 0;
    while (windows.length) {
      if (++queries > 512) throw new Error("TRANSFER_SOURCE_QUERY_LIMIT");
      const [start, end] = windows.pop()!;
      const since = new Date(start * 1_000).toISOString();
      const before = new Date(end * 1_000).toISOString();
      const query = `query MintTransfers($mint: String!, $since: DateTime!, $before: DateTime!) {
        Solana(dataset: realtime) {
          Transfers(
            where: {
              Transfer: { Currency: { MintAddress: { is: $mint } } }
              Block: { Time: { since: $since, before: $before } }
              Transaction: { Result: { Success: true } }
            }
            orderBy: { ascending: Block_Slot }
            limit: { count: ${pageSize} }
          ) { Block { Slot } Transaction { Signature Index } }
        }
      }`;
      const response = await this.post(JSON.stringify({ query, variables: { mint, since, before } }));
      if (!response.ok) throw new Error(`BITQUERY_HTTP_${response.status}`);
      const result = await response.json() as { data?: { Solana?: { Transfers?: BitqueryRow[] } }; errors?: unknown[] };
      if (result.errors?.length || !Array.isArray(result.data?.Solana?.Transfers)) throw new Error("BITQUERY_RESPONSE_INVALID");
      const batch = result.data.Solana.Transfers;
      const parsed = batch.map((row) => {
        const slot = Number(row.Block?.Slot);
        const transactionIndex = Number(row.Transaction?.Index);
        const signature = row.Transaction?.Signature;
        if (!Number.isSafeInteger(slot) || slot <= 0 || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0 || !signature) {
          throw new Error("BITQUERY_TRANSFER_ROW_INVALID");
        }
        return { slot, transactionIndex, signature };
      });
      if (batch.length === pageSize) {
        if (end - start <= 1) throw new Error("BITQUERY_SINGLE_SECOND_OVERFLOW");
        const middle = start + Math.floor((end - start) / 2);
        windows.push([middle, end], [start, middle]);
      } else {
        rows.push(...parsed);
      }
    }
    return rows.sort((a, b) => a.slot - b.slot || a.transactionIndex - b.transactionIndex || a.signature.localeCompare(b.signature));
  }
}
