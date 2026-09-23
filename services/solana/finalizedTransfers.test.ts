import { Keypair, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { tokenDeltas } from "./finalizedTransfers";
import { holderMovements } from "./holderJournal";

const mint = Keypair.generate().publicKey.toBase58();
const alice = Keypair.generate().publicKey.toBase58();
const bob = Keypair.generate().publicKey.toBase58();
const aliceAta = Keypair.generate().publicKey.toBase58();
const bobAta = Keypair.generate().publicKey.toBase58();

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
    expect(holderMovements({ signature: "tx", slot: 10, blockTime: 100, blockhash: "block", deltas }, 2)).toEqual([
      { signature: "tx", slot: 10, transactionIndex: 2, instructionIndex: 0, timestamp: 100, from: alice, to: bob, rawAmount: 40n },
    ]);
  });

  it("fails closed if an account changes owner within a transaction", () => {
    const transaction = parsed(100n, 60n, 0n, 40n);
    transaction.meta!.postTokenBalances![0].owner = bob;
    expect(() => tokenDeltas(transaction, mint)).toThrow("TOKEN_ACCOUNT_OWNER_CHANGED");
  });

  it("preserves mint and burn conservation as an external source or sink", () => {
    const minted = holderMovements({ signature: "mint", slot: 1, blockTime: 1, blockhash: "b", deltas: [{ account: aliceAta, owner: alice, rawAmount: "100" }] }, 0);
    expect(minted[0]).toMatchObject({ from: undefined, to: alice, rawAmount: 100n });
    const burned = holderMovements({ signature: "burn", slot: 2, blockTime: 2, blockhash: "b", deltas: [{ account: aliceAta, owner: alice, rawAmount: "-25" }] }, 0);
    expect(burned[0]).toMatchObject({ from: alice, to: undefined, rawAmount: 25n });
  });
});
