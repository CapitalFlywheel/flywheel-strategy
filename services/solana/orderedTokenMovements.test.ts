import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAgreedFinalizedTransaction } from "./finalizedTransfers";
import { SolanaHoldingEngine, weightedRawSeconds } from "./holderAccounting";
import { orderedTokenMovements } from "./orderedTokenMovements";

const pubkey = () => Keypair.generate().publicKey.toBase58();
const mint = pubkey();
const alice = pubkey();
const pool = pubkey();
const aliceAta = pubkey();
const poolAta = pubkey();
const router = Keypair.generate().publicKey;
const token = TOKEN_2022_PROGRAM_ID;

function instruction(type: string, info: Record<string, unknown>, programId = token) {
  return { programId, parsed: { type, info } };
}

function row(accountIndex: number, owner: string, amount: bigint) {
  return { accountIndex, owner, mint, uiTokenAmount: { amount: amount.toString() } };
}

function parsed(args: {
  pre?: ReturnType<typeof row>[];
  post?: ReturnType<typeof row>[];
  outer?: ReturnType<typeof instruction>[];
  inner?: Array<{ index: number; instructions: ReturnType<typeof instruction>[] }>;
  accountKeys?: string[];
}) {
  return {
    slot: 10, blockTime: 7_200, version: 1,
    transaction: { signatures: ["signature"], message: {
      accountKeys: (args.accountKeys ?? [aliceAta, poolAta]).map((key) => ({
        pubkey: { toBase58: () => key }, source: "transaction",
      })),
      instructions: args.outer ?? [],
    } },
    meta: { err: null, preTokenBalances: args.pre ?? [], postTokenBalances: args.post ?? [], innerInstructions: args.inner ?? [] },
  } as unknown as ParsedTransactionWithMeta;
}

const trade = () => parsed({
  pre: [row(0, alice, 100n), row(1, pool, 100n)],
  post: [row(0, alice, 100n), row(1, pool, 100n)],
  outer: [instruction("route", {}, router)],
  inner: [{ index: 0, instructions: [
    instruction("transferChecked", { source: aliceAta, destination: poolAta, mint, tokenAmount: { amount: "100" } }),
    instruction("transferChecked", { source: poolAta, destination: aliceAta, mint, tokenAmount: { amount: "100" } }),
  ] }],
});

afterEach(() => vi.restoreAllMocks());

describe("ordered finalized CAPITAL movements", () => {
  it("preserves a same-transaction sale and repurchase despite zero account deltas, resetting loyalty", () => {
    const movements = orderedTokenMovements(trade(), mint);
    expect(movements).toEqual([
      { instructionIndex: 0, from: alice, to: pool, rawAmount: "100" },
      { instructionIndex: 1, from: pool, to: alice, rawAmount: "100" },
    ]);
    const actual = new SolanaHoldingEngine(0, 10_800, [pool]);
    const incorrectNetOnly = new SolanaHoldingEngine(0, 10_800, [pool]);
    for (const engine of [actual, incorrectNetOnly]) engine.apply({ signature: "launch", slot: 1, instructionIndex: 0, timestamp: 0, to: alice, rawAmount: 100n });
    movements.forEach((movement) => actual.apply({
      ...movement, rawAmount: BigInt(movement.rawAmount), signature: "trade", slot: 10, timestamp: 7_200,
    }));
    const actualWeight = actual.finalize().get(alice);
    expect(actualWeight).toBe(weightedRawSeconds(100n, 0, 0, 7_200)
      + weightedRawSeconds(100n, 7_200, 7_200, 10_800));
    expect(actualWeight).toBeLessThan(incorrectNetOnly.finalize().get(alice)!);
  });

  it("keeps mint, transfer and burn in exact CPI order and reconciles final account balances", () => {
    const tx = parsed({
      pre: [row(0, alice, 0n), row(1, pool, 0n)], post: [row(0, alice, 35n), row(1, pool, 10n)],
      outer: [instruction("route", {}, router)],
      inner: [{ index: 0, instructions: [
        instruction("mintTo", { mint, account: aliceAta, amount: "60" }),
        instruction("transfer", { source: aliceAta, destination: poolAta, amount: "10" }),
        instruction("burn", { mint, account: aliceAta, amount: "15" }),
      ] }],
    });
    expect(orderedTokenMovements(tx, mint)).toEqual([
      { instructionIndex: 0, from: undefined, to: alice, rawAmount: "60" },
      { instructionIndex: 1, from: alice, to: pool, rawAmount: "10" },
      { instructionIndex: 2, from: alice, to: undefined, rawAmount: "15" },
    ]);
  });

  it("accepts an ATA initialized within the transaction and a zero-balance ATA close", () => {
    const created = parsed({
      pre: [], post: [row(0, alice, 10n)], accountKeys: [aliceAta],
      outer: [instruction("create", {}, router)],
      inner: [{ index: 0, instructions: [
        instruction("initializeAccount3", { account: aliceAta, mint, owner: alice }),
        instruction("mintToChecked", { account: aliceAta, mint, tokenAmount: { amount: "10" } }),
      ] }],
    });
    expect(orderedTokenMovements(created, mint)).toEqual([{ instructionIndex: 0, from: undefined, to: alice, rawAmount: "10" }]);
    const closed = parsed({ pre: [row(0, alice, 0n)], post: [], accountKeys: [aliceAta],
      outer: [instruction("closeAccount", { account: aliceAta })], });
    expect(orderedTokenMovements(closed, mint)).toEqual([]);
  });

  it("allows known non-balance mint setup but rejects unmodelled Token-2022 value operations", () => {
    const launched = parsed({
      pre: [], post: [row(0, alice, 10n)], accountKeys: [aliceAta],
      outer: [instruction("launch", {}, router)],
      inner: [{ index: 0, instructions: [
        instruction("initializeMintCloseAuthority", { mint }),
        instruction("initializeMetadataPointer", { mint }),
        instruction("initializeAccount3", { account: aliceAta, mint, owner: alice }),
        instruction("mintTo", { account: aliceAta, mint, amount: "10" }),
      ] }],
    });
    expect(orderedTokenMovements(launched, mint)).toEqual([
      { instructionIndex: 0, from: undefined, to: alice, rawAmount: "10" },
    ]);
    const unsupported = trade();
    (unsupported.meta!.innerInstructions![0].instructions[0] as { parsed: { type: string } }).parsed.type = "transferCheckedWithFee";
    expect(() => orderedTokenMovements(unsupported, mint)).toThrow("ORDERED_TOKEN_INSTRUCTION_UNSUPPORTED");
  });

  it("ignores a self-owned transfer without losing account-level reconciliation", () => {
    const secondAta = pubkey();
    const tx = parsed({ accountKeys: [aliceAta, secondAta],
      pre: [row(0, alice, 10n), row(1, alice, 0n)], post: [row(0, alice, 5n), row(1, alice, 5n)],
      outer: [instruction("transferChecked", { source: aliceAta, destination: secondAta, mint, amount: "5" })],
    });
    expect(orderedTokenMovements(tx, mint)).toEqual([{ instructionIndex: 0, from: alice, to: alice, rawAmount: "5" }]);
  });

  it("fails closed on missing CPI metadata, unparsed instructions, unknown accounts and aggregate mismatch", () => {
    const missing = trade();
    missing.meta!.innerInstructions = null;
    expect(() => orderedTokenMovements(missing, mint)).toThrow("ORDERED_TOKEN_METADATA_MISSING");

    const opaque = trade();
    opaque.meta!.innerInstructions![0].instructions[0] = { programId: token, accounts: [], data: "3" } as never;
    expect(() => orderedTokenMovements(opaque, mint)).toThrow("ORDERED_TOKEN_INSTRUCTION_UNPARSED");

    const unknown = trade();
    (unknown.meta!.innerInstructions![0].instructions[0] as { parsed: { info: Record<string, unknown> } }).parsed.info.destination = pubkey();
    expect(() => orderedTokenMovements(unknown, mint)).toThrow("ORDERED_TOKEN_ACCOUNT_UNKNOWN");

    const mismatch = trade();
    mismatch.meta!.postTokenBalances![0].uiTokenAmount.amount = "99";
    expect(() => orderedTokenMovements(mismatch, mint)).toThrow("ORDERED_TOKEN_DELTA_MISMATCH");
  });

  it("rejects nonzero account closes and ambiguous parent/child token movements", () => {
    const closed = parsed({ pre: [row(0, alice, 1n)], post: [], accountKeys: [aliceAta],
      outer: [instruction("closeAccount", { account: aliceAta })], });
    expect(() => orderedTokenMovements(closed, mint)).toThrow("ORDERED_TOKEN_ACCOUNT_CLOSE_NONZERO");

    const nested = parsed({
      pre: [row(0, alice, 100n), row(1, pool, 100n)], post: [row(0, alice, 100n), row(1, pool, 100n)],
      outer: [instruction("transferChecked", { source: aliceAta, destination: poolAta, mint, amount: "10" })],
      inner: [{ index: 0, instructions: [instruction("transferChecked", { source: poolAta, destination: aliceAta, mint, amount: "10" })] }],
    });
    expect(() => orderedTokenMovements(nested, mint)).toThrow("ORDERED_TOKEN_NESTED_ORDER_AMBIGUOUS");
  });

  it("requires two finalized providers to agree on the ordered execution, not merely net deltas", async () => {
    const getParsedTransaction = vi.spyOn(Connection.prototype, "getParsedTransaction").mockImplementation(async function (this: Connection) {
      const tx = trade();
      if (this.rpcEndpoint.includes("second")) tx.meta!.innerInstructions![0].instructions.reverse();
      return tx;
    });
    const getBlock = vi.spyOn(Connection.prototype, "getBlock").mockResolvedValue({
      blockhash: "block", blockTime: 7_200, previousBlockhash: "previous", parentSlot: 9,
      transactions: [{ version: 1, transaction: { accountKeys: [], signatures: ["signature"] } }],
    } as never);
    await expect(readAgreedFinalizedTransaction(
      ["https://first.example/rpc", "https://second.example/rpc"], "signature", mint,
      { includeOrderedMovements: true },
    )).rejects.toThrow();
    expect(getParsedTransaction).toHaveBeenCalledWith("signature", expect.objectContaining({ maxSupportedTransactionVersion: 1 }));
    expect(getBlock).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({
      transactionDetails: "accounts", maxSupportedTransactionVersion: 1,
    }));
  });

  it("fails closed if a v1 parsed transaction claims address-table-loaded keys", async () => {
    const invalid = trade();
    (invalid.transaction.message.accountKeys[0] as { source: string }).source = "lookupTable";
    vi.spyOn(Connection.prototype, "getParsedTransaction").mockResolvedValue(invalid);
    await expect(readAgreedFinalizedTransaction(
      ["https://first.example/rpc", "https://second.example/rpc"], "signature", mint,
      { includeOrderedMovements: true },
    )).rejects.toThrow("TOKEN_V1_LOOKUP_TABLE_INVALID");
  });

  it("rejects a vendor transaction index that differs from the two finalized block signature lists", async () => {
    vi.spyOn(Connection.prototype, "getParsedTransaction").mockResolvedValue(trade());
    vi.spyOn(Connection.prototype, "getBlock").mockImplementation(async function (this: Connection) {
      return { blockhash: "block", blockTime: 7_200, previousBlockhash: "previous", parentSlot: 9,
        transactions: (this.rpcEndpoint.includes("second") ? ["other", "signature"] : ["signature"])
          .map((signature) => ({ version: 1, transaction: { accountKeys: [], signatures: [signature] } })) } as never;
    });
    await expect(readAgreedFinalizedTransaction(
      ["https://first.example/rpc", "https://second.example/rpc"], "signature", mint,
      { includeOrderedMovements: true },
    )).rejects.toThrow("FINALIZED_TRANSACTION_RPC_DISAGREEMENT");
  });
});
