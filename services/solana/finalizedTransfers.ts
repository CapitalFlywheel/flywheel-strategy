import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { requireMatchingValues } from "./rpcConsensus";

export interface FinalizedTokenTransaction {
  signature: string;
  slot: number;
  blockTime: number;
  blockhash: string;
  deltas: Array<{ account: string; owner: string; rawAmount: string }>;
}

export function tokenDeltas(transaction: ParsedTransactionWithMeta, mint: string) {
  if (!transaction.meta || transaction.meta.err) throw new Error("TOKEN_TRANSACTION_FAILED");
  const accounts = transaction.transaction.message.accountKeys.map((row) => row.pubkey.toBase58());
  const before = new Map<number, { owner: string; amount: bigint }>();
  const after = new Map<number, { owner: string; amount: bigint }>();
  for (const [rows, destination] of [
    [transaction.meta.preTokenBalances ?? [], before],
    [transaction.meta.postTokenBalances ?? [], after],
  ] as const) {
    for (const row of rows) {
      if (row.mint !== mint) continue;
      if (!row.owner || !accounts[row.accountIndex]) throw new Error("TOKEN_BALANCE_OWNER_MISSING");
      if (destination.has(row.accountIndex)) throw new Error("TOKEN_BALANCE_DUPLICATE");
      destination.set(row.accountIndex, { owner: new PublicKey(row.owner).toBase58(), amount: BigInt(row.uiTokenAmount.amount) });
    }
  }
  return [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b).map((index) => {
    const first = before.get(index);
    const last = after.get(index);
    if (first && last && first.owner !== last.owner) throw new Error("TOKEN_ACCOUNT_OWNER_CHANGED");
    return {
      account: accounts[index],
      owner: (last ?? first)!.owner,
      rawAmount: ((last?.amount ?? 0n) - (first?.amount ?? 0n)).toString(),
    };
  }).filter((row) => row.rawAmount !== "0");
}

export async function readAgreedFinalizedTransaction(
  rpcUrls: readonly [string, string], signature: string, mint: string,
): Promise<FinalizedTokenTransaction | undefined> {
  const snapshots = await Promise.all(rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const transaction = await connection.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!transaction) return undefined;
    if (transaction.blockTime === null) throw new Error("TOKEN_BLOCK_TIME_MISSING");
    const block = await connection.getBlock(transaction.slot, {
      commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0,
    });
    if (!block) throw new Error("TOKEN_BLOCK_MISSING");
    return {
      signature,
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      blockhash: block.blockhash,
      deltas: tokenDeltas(transaction, mint),
    };
  }));
  if (snapshots.some((row) => !row)) return undefined;
  return requireMatchingValues(snapshots as FinalizedTokenTransaction[], "FINALIZED_TRANSACTION_RPC_DISAGREEMENT");
}

export function tokenAccountDelta(transaction: FinalizedTokenTransaction, account: string) {
  return BigInt(transaction.deltas.find((row) => row.account === account)?.rawAmount ?? "0");
}
