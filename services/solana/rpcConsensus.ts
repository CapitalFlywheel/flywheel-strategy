import { Connection, type Commitment } from "@solana/web3.js";

export interface FinalizedConsensus {
  slot: number;
  blockhash: string;
  providers: number;
}

export function assertIndependentRpcProviders(rpcUrls: readonly string[]) {
  if (rpcUrls.length < 2) throw new Error("TWO_RPC_PROVIDERS_REQUIRED");
  const parsed = rpcUrls.map((value) => new URL(value));
  if (parsed.some((url) => url.protocol !== "https:")) throw new Error("RPC_HTTPS_REQUIRED");
  if (new Set(parsed.map((url) => url.hostname)).size !== parsed.length) throw new Error("RPC_PROVIDERS_NOT_INDEPENDENT");
  return true;
}

export async function finalizedConsensus(
  rpcUrls: readonly string[],
  commitment: Commitment = "finalized",
  maxSlotDrift = 24,
): Promise<FinalizedConsensus> {
  assertIndependentRpcProviders(rpcUrls);
  const connections = rpcUrls.map((url) => new Connection(url, commitment));
  const slots = await Promise.all(connections.map((connection) => connection.getSlot(commitment)));
  const lowestSlot = Math.min(...slots);
  const highestSlot = Math.max(...slots);
  if (highestSlot - lowestSlot > maxSlotDrift) throw new Error("RPC_SLOT_DRIFT");

  for (let slot = lowestSlot; slot > lowestSlot - 64; slot -= 1) {
    const blockhashes = await Promise.all(connections.map(async (connection) => {
      const block = await connection.getBlock(slot, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
        transactionDetails: "none",
        rewards: false,
      });
      return block?.blockhash;
    }));
    if (blockhashes.every((hash) => !hash)) continue;
    if (!blockhashes[0] || blockhashes.some((hash) => hash !== blockhashes[0])) throw new Error("RPC_BLOCK_DISAGREEMENT");
    return { slot, blockhash: blockhashes[0], providers: connections.length };
  }
  throw new Error("RPC_FINALIZED_BLOCK_UNAVAILABLE");
}

export function requireMatchingValues<T>(values: readonly T[], error = "RPC_STATE_DISAGREEMENT"): T {
  if (values.length < 2) throw new Error("TWO_RPC_VALUES_REQUIRED");
  const serialize = (value: T) => JSON.stringify(value, (_key, field) => typeof field === "bigint" ? `bigint:${field}` : field);
  const canonical = serialize(values[0]);
  if (values.some((value) => serialize(value) !== canonical)) throw new Error(error);
  return values[0];
}
