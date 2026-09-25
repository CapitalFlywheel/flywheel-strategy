import type { Connection } from "@solana/web3.js";

/**
 * Solana v1 transactions are present on mainnet. Reads must request them so a
 * finalized block containing v1 does not fail with RPC -32015. This constant
 * is for RPC decoding only; it does not change the transaction format we send.
 */
export const MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION = 1;

export function assertReadableTransactionVersion(version: unknown): asserts version is "legacy" | 0 | 1 {
  // RPC returns the explicit version when maxSupportedTransactionVersion is set.
  // Unknown or omitted versions cannot safely advance a financial cursor.
  if (version !== "legacy" && version !== 0 && version !== 1) {
    throw new Error("SOLANA_TRANSACTION_VERSION_UNSUPPORTED");
  }
}

/** Canonical signature order from a finalized block, including v1 transactions. */
export async function readFinalizedBlockSignatures(connection: Connection, slot: number) {
  // Connection.getBlockSignatures() currently omits the version option and
  // therefore fails on a block containing v1 transactions. Accounts mode is
  // smaller than full mode while preserving the exact transaction order.
  const block = await connection.getBlock(slot, {
    commitment: "finalized", transactionDetails: "accounts", rewards: false,
    maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
  });
  if (!block || !block.blockhash || !Number.isSafeInteger(block.blockTime)
    || (block.blockTime ?? 0) <= 0 || !Array.isArray(block.transactions)) {
    throw new Error("SOLANA_FINALIZED_BLOCK_INVALID");
  }
  const signatures = block.transactions.map((row) => {
    assertReadableTransactionVersion(row.version);
    // web3.js 1.99.0 chooses its broad getBlock overload for accounts mode,
    // though the wire response does include these fields; validate the shape.
    const transaction = row.transaction as unknown as { accountKeys?: unknown; signatures?: unknown };
    if (!Array.isArray(transaction?.accountKeys)
      || !Array.isArray(transaction?.signatures) || typeof transaction.signatures[0] !== "string"
      || !transaction.signatures[0]) {
      throw new Error("SOLANA_FINALIZED_BLOCK_TRANSACTION_INVALID");
    }
    return transaction.signatures[0] as string;
  });
  if (new Set(signatures).size !== signatures.length) throw new Error("SOLANA_FINALIZED_BLOCK_DUPLICATE_SIGNATURE");
  return { blockhash: block.blockhash, blockTime: block.blockTime!, signatures };
}
