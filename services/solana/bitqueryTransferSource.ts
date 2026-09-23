import { PublicKey } from "@solana/web3.js";
import type { DiscoveredTransferTransaction, MintTransferSource } from "./holderJournal";

interface BitqueryRow {
  Block?: { Slot?: string | number };
  Transaction?: { Signature?: string; Index?: string | number };
}

export class BitqueryTransferSource implements MintTransferSource {
  constructor(private readonly apiKey: string, private readonly endpoint = "https://streaming.bitquery.io/graphql") {
    if (!apiKey.trim()) throw new Error("BITQUERY_API_KEY_REQUIRED");
    if (!endpoint.startsWith("https://")) throw new Error("BITQUERY_ENDPOINT_HTTPS_REQUIRED");
  }

  async discover(mint: string, fromTime: number, throughTime: number): Promise<DiscoveredTransferTransaction[]> {
    new PublicKey(mint);
    if (!Number.isInteger(fromTime) || !Number.isInteger(throughTime) || throughTime <= fromTime) throw new Error("TRANSFER_WINDOW_INVALID");
    const rows: DiscoveredTransferTransaction[] = [];
    const pageSize = 500;
    // Bitquery's realtime Transfers cube has a short rolling retention window
    // and its offset pagination is not stable when many transfers share a slot
    if (throughTime - fromTime > 6 * 3_600) throw new Error("TRANSFER_SOURCE_REALTIME_GAP");
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
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ query, variables: { mint, since, before } }),
        signal: AbortSignal.timeout(30_000),
      });
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
