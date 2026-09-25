import { Connection, Keypair, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAgreedFinalizedTransaction, tokenDeltas } from "./finalizedTransfers";
import { holderMovements } from "./holderJournal";

const mint = Keypair.generate().publicKey.toBase58();
const alice = Keypair.generate().publicKey.toBase58();
const bob = Keypair.generate().publicKey.toBase58();
const aliceAta = Keypair.generate().publicKey.toBase58();
const bobAta = Keypair.generate().publicKey.toBase58();
const rpcUrls = ["https://one.invalid", "https://two.invalid"] as const;
const attestedPosition = { signature: "tx", slot: 10, blockhash: "hash-10", blockTime: 100,
  transactionIndex: 2 };

afterEach(() => vi.restoreAllMocks());

function parsedEmptyTransaction(overrides: { signature?: string; slot?: number; blockTime?: number } = {}): ParsedTransactionWithMeta {
  return {
    slot: overrides.slot ?? 10, blockTime: overrides.blockTime ?? 100, version: 0,
    transaction: { signatures: [overrides.signature ?? "tx"],
      message: { accountKeys: [], instructions: [] } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
  } as unknown as ParsedTransactionWithMeta;
}

function parsed(before: bigint, after: bigint, bobBefore: bigint, bobAfter: bigint): ParsedTransactionWithMeta {
  const row = (accountIndex: number, owner: string, amount: bigint) => ({
    accountIndex, owner, mint, uiTokenAmount: { amount: amount.toString() },
  });
  return {
    transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => aliceAta } }, { pubkey: { toBase58: () => bobAta } }] } },
    meta: {
      err: null,
      preTokenBalances: [row(0, alice, before), row(1, bob, bobBefore)],
      postTokenBalances: [row(0, alice, after), row(1, bob, bobAfter)],
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe("finalized CAPITAL balance deltas", () => {
  it("derives a complete holder movement from token-account balances", () => {
    const deltas = tokenDeltas(parsed(100n, 60n, 0n, 40n), mint);
    expect(deltas).toEqual([
      { account: aliceAta, owner: alice, rawAmount: "-40" },
      { account: bobAta, owner: bob, rawAmount: "40" },
    ]);
    expect(holderMovements({ signature: "tx", slot: 10, blockTime: 100, blockhash: "block", deltas, transactionIndex: 2,
      movements: [{ instructionIndex: 0, from: alice, to: bob, rawAmount: "40" }] }, 2)).toEqual([
      { signature: "tx", slot: 10, transactionIndex: 2, instructionIndex: 0, timestamp: 100, from: alice, to: bob, rawAmount: 40n },
    ]);
  });

  it("fails closed if an account changes owner within a transaction", () => {
    const transaction = parsed(100n, 60n, 0n, 40n);
    transaction.meta!.postTokenBalances![0].owner = bob;
    expect(() => tokenDeltas(transaction, mint)).toThrow("TOKEN_ACCOUNT_OWNER_CHANGED");
  });

  it("rejects omitted token balance metadata instead of treating it as an empty movement", () => {
    const transaction = parsed(100n, 60n, 0n, 40n);
    transaction.meta!.postTokenBalances = null;
    expect(() => tokenDeltas(transaction, mint)).toThrow("TOKEN_BALANCES_MISSING");
  });

  it("preserves mint and burn conservation as an external source or sink", () => {
    const minted = holderMovements({ signature: "mint", slot: 1, blockTime: 1, blockhash: "b", transactionIndex: 0,
      deltas: [{ account: aliceAta, owner: alice, rawAmount: "100" }],
      movements: [{ instructionIndex: 0, to: alice, rawAmount: "100" }] }, 0);
    expect(minted[0]).toMatchObject({ from: undefined, to: alice, rawAmount: 100n });
    const burned = holderMovements({ signature: "burn", slot: 2, blockTime: 2, blockhash: "b", transactionIndex: 0,
      deltas: [{ account: aliceAta, owner: alice, rawAmount: "-25" }],
      movements: [{ instructionIndex: 0, from: alice, rawAmount: "25" }] }, 0);
    expect(burned[0]).toMatchObject({ from: alice, to: undefined, rawAmount: 25n });
  });

  it("never reconstructs holder events from transaction net deltas alone", () => {
    expect(() => holderMovements({ signature: "tx", slot: 10, blockTime: 100, blockhash: "b", transactionIndex: 0, deltas: [] }, 0))
      .toThrow("HOLDER_ORDERED_MOVEMENTS_REQUIRED");
  });

  it("rejects a movement placed at a vendor index other than its finalized block position", () => {
    expect(() => holderMovements({ signature: "tx", slot: 10, blockTime: 100, blockhash: "b",
      transactionIndex: 1, deltas: [], movements: [{ instructionIndex: 0, from: alice, to: bob, rawAmount: "1" }] }, 0))
      .toThrow("HOLDER_TRANSACTION_INDEX_MISMATCH");
  });
});

describe("independently attested finalized block position", () => {
  it("uses the full-block proof for both parsed RPC reads without a second accounts-mode getBlock", async () => {
    const parsedRead = vi.spyOn(Connection.prototype, "getParsedTransaction")
      .mockResolvedValue(parsedEmptyTransaction());
    const blockRead = vi.spyOn(Connection.prototype, "getBlock").mockRejectedValue(new Error("BLOCK_READ_FORBIDDEN"));
    await expect(readAgreedFinalizedTransaction(rpcUrls, "tx", mint, {
      includeOrderedMovements: true, agreedBlockPosition: attestedPosition,
    })).resolves.toMatchObject({ signature: "tx", slot: 10, blockhash: "hash-10", blockTime: 100,
      transactionIndex: 2, deltas: [], movements: [] });
    expect(parsedRead).toHaveBeenCalledTimes(2);
    expect(blockRead).not.toHaveBeenCalled();
  });

  it.each([
    ["signature", { signature: "other" }],
    ["slot", { slot: 11 }],
    ["block time", { blockTime: 101 }],
  ])("fails closed when one parsed RPC disagrees about the %s", async (_label, override) => {
    vi.spyOn(Connection.prototype, "getParsedTransaction")
      .mockResolvedValueOnce(parsedEmptyTransaction())
      .mockResolvedValueOnce(parsedEmptyTransaction(override));
    const blockRead = vi.spyOn(Connection.prototype, "getBlock").mockRejectedValue(new Error("BLOCK_READ_FORBIDDEN"));
    await expect(readAgreedFinalizedTransaction(rpcUrls, "tx", mint, {
      includeOrderedMovements: true, agreedBlockPosition: attestedPosition,
    })).rejects.toThrow("TOKEN_AGREED_BLOCK_POSITION_MISMATCH");
    expect(blockRead).not.toHaveBeenCalled();
  });

  it("never accepts attested position outside ordered-movement verification", async () => {
    const parsedRead = vi.spyOn(Connection.prototype, "getParsedTransaction");
    await expect(readAgreedFinalizedTransaction(rpcUrls, "tx", mint, {
      agreedBlockPosition: attestedPosition,
    })).rejects.toThrow("TOKEN_AGREED_BLOCK_POSITION_REQUIRES_ORDER");
    expect(parsedRead).not.toHaveBeenCalled();
  });
});
