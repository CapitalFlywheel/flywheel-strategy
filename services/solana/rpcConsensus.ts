import { Connection, type Commitment } from "@solana/web3.js";

export interface FinalizedConsensus {
  slot: number;
  blockhash: string;
  providers: number;
}

export async function finalizedConsensus(
  rpcUrls: readonly string[],
  commitment: Commitment = "finalized",
  maxSlotDrift = 24,
): Promise<FinalizedConsensus> {
  if (rpcUrls.length < 2) throw new Error("TWO_RPC_PROVIDERS_REQUIRED");
  const connections = rpcUrls.map((url) => new Connection(url, commitment));
  const slots = await Promise.all(connections.map((connection) => connection.getSlot(commitment)));
  const lowestSlot = Math.min(...slots);
  const highestSlot = Math.max(...slots);
  if (highestSlot - lowestSlot > maxSlotDrift) throw new Error("RPC_SLOT_DRIFT");

  const blockhashes = await Promise.all(connections.map(async (connection) => {
    const block = await connection.getBlock(lowestSlot, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
      transactionDetails: "none",
      rewards: false,
    });
    return block?.blockhash;
  }));
  if (!blockhashes[0] || blockhashes.some((hash) => hash !== blockhashes[0])) {
    throw new Error("RPC_BLOCK_DISAGREEMENT");
  }
  return { slot: lowestSlot, blockhash: blockhashes[0], providers: connections.length };
}

export function requireMatchingValues<T>(values: readonly T[], error = "RPC_STATE_DISAGREEMENT"): T {
  if (values.length < 2) throw new Error("TWO_RPC_VALUES_REQUIRED");
  const canonical = JSON.stringify(values[0]);
  if (values.some((value) => JSON.stringify(value) !== canonical)) throw new Error(error);
  return values[0];
}
