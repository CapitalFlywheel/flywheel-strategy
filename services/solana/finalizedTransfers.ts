import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { assertIndependentRpcProviders, requireMatchingValues } from "./rpcConsensus";
import { orderedTokenMovements, type OrderedTokenMovement } from "./orderedTokenMovements";
import { assertReadableTransactionVersion, MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
  readFinalizedBlockSignatures } from "./rpcTransactionVersion";

export interface FinalizedTokenTransaction {
  signature: string;
  slot: number;
  blockTime: number;
  blockhash: string;
  deltas: Array<{ account: string; owner: string; rawAmount: string }>;
  /** Present only when ordered holder reconstruction was explicitly requested. */
  movements?: OrderedTokenMovement[];
  /** Canonical position in the finalized block, independently agreed by two RPCs. */
  transactionIndex?: number;
}

/** Identity and canonical position already agreed from two complete finalized
 * blocks. Only the full-block scanner may supply this to the holder journal. */
export interface AgreedFinalizedBlockPosition {
  signature: string;
  slot: number;
  blockhash: string;
  blockTime: number;
  transactionIndex: number;
}

function assertAgreedBlockPosition(position: AgreedFinalizedBlockPosition, signature: string) {
  if (position.signature !== signature || !Number.isSafeInteger(position.slot) || position.slot <= 0
    || typeof position.blockhash !== "string" || !position.blockhash
    || !Number.isSafeInteger(position.blockTime) || position.blockTime <= 0
    || !Number.isSafeInteger(position.transactionIndex) || position.transactionIndex < 0) {
    throw new Error("TOKEN_AGREED_BLOCK_POSITION_INVALID");
  }
}

export function tokenDeltas(transaction: ParsedTransactionWithMeta, mint: string) {
  if (!transaction.meta || transaction.meta.err !== null) throw new Error("TOKEN_TRANSACTION_FAILED");
  if (!Array.isArray(transaction.meta.preTokenBalances)
    || !Array.isArray(transaction.meta.postTokenBalances)) throw new Error("TOKEN_BALANCES_MISSING");
  if (!Array.isArray(transaction.transaction.message.accountKeys)) throw new Error("TOKEN_ACCOUNT_KEYS_MISSING");
  const accounts = transaction.transaction.message.accountKeys.map((row) => row.pubkey.toBase58());
  const before = new Map<number, { owner: string; amount: bigint }>();
  const after = new Map<number, { owner: string; amount: bigint }>();
  for (const [rows, destination] of [
    [transaction.meta.preTokenBalances, before],
    [transaction.meta.postTokenBalances, after],
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

async function finalizedBlockLocation(connection: Connection, slot: number, signature: string,
  includeOrderedMovements: boolean) {
  if (!includeOrderedMovements) {
    const block = await connection.getBlock(slot, {
      commitment: "finalized", transactionDetails: "none", rewards: false,
      maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
    });
    if (!block) throw new Error("TOKEN_BLOCK_MISSING");
    return { blockhash: block.blockhash, blockTime: block.blockTime, position: -1 };
  }
  const block = await readFinalizedBlockSignatures(connection, slot);
  const signatures = block.signatures;
  const position = signatures.indexOf(signature);
  if (position < 0 || signatures.lastIndexOf(signature) !== position) {
    throw new Error("TOKEN_SIGNATURE_NOT_IN_FINALIZED_BLOCK");
  }
  return { blockhash: block.blockhash, blockTime: block.blockTime, position };
}

export async function readAgreedFinalizedTransaction(
  rpcUrls: readonly [string, string], signature: string, mint: string,
  options: { includeOrderedMovements?: boolean; agreedBlockPosition?: AgreedFinalizedBlockPosition } = {},
): Promise<FinalizedTokenTransaction | undefined> {
  assertIndependentRpcProviders(rpcUrls);
  if (options.agreedBlockPosition) {
    if (!options.includeOrderedMovements) throw new Error("TOKEN_AGREED_BLOCK_POSITION_REQUIRES_ORDER");
    assertAgreedBlockPosition(options.agreedBlockPosition, signature);
  }
  const snapshots = await Promise.all(rpcUrls.map(async (url) => {
    const connection = new Connection(url, "finalized");
    const transaction = await connection.getParsedTransaction(signature, {
      commitment: "finalized", maxSupportedTransactionVersion: MAX_SUPPORTED_SOLANA_TRANSACTION_VERSION,
    });
    if (!transaction) return undefined;
    assertReadableTransactionVersion(transaction.version);
    if (!Array.isArray(transaction.transaction?.message?.accountKeys)) throw new Error("TOKEN_ACCOUNT_KEYS_MISSING");
    if (transaction.version === 1 && transaction.transaction.message.accountKeys.some((row) => row.source === "lookupTable")) {
      throw new Error("TOKEN_V1_LOOKUP_TABLE_INVALID");
    }
    if (!Number.isSafeInteger(transaction.blockTime) || (transaction.blockTime ?? 0) <= 0) {
      throw new Error("TOKEN_BLOCK_TIME_MISSING");
    }
    if (options.agreedBlockPosition && (transaction.slot !== options.agreedBlockPosition.slot
      || transaction.blockTime !== options.agreedBlockPosition.blockTime
      || transaction.transaction?.signatures?.[0] !== signature)) {
      throw new Error("TOKEN_AGREED_BLOCK_POSITION_MISMATCH");
    }
    const block = options.agreedBlockPosition
      ? { blockhash: options.agreedBlockPosition.blockhash, blockTime: options.agreedBlockPosition.blockTime,
        position: options.agreedBlockPosition.transactionIndex }
      : await finalizedBlockLocation(connection, transaction.slot, signature, !!options.includeOrderedMovements);
    if (options.includeOrderedMovements && block.blockTime !== transaction.blockTime) {
      throw new Error("TOKEN_BLOCK_TIME_DISAGREEMENT");
    }
    return {
      signature,
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      blockhash: block.blockhash,
      deltas: tokenDeltas(transaction, mint),
      ...(options.includeOrderedMovements ? { movements: orderedTokenMovements(transaction, mint) } : {}),
      ...(options.includeOrderedMovements ? { transactionIndex: block.position } : {}),
    };
  }));
  if (snapshots.some((row) => !row)) return undefined;
  return requireMatchingValues(snapshots as FinalizedTokenTransaction[], "FINALIZED_TRANSACTION_RPC_DISAGREEMENT");
}

export function tokenAccountDelta(transaction: FinalizedTokenTransaction, account: string) {
  return BigInt(transaction.deltas.find((row) => row.account === account)?.rawAmount ?? "0");
}
