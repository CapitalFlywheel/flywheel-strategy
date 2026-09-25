import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { classifyFeeTransactionProgress, markSameWalletRecovered, recoverableFeeAmount, type FeeSettlementState } from "./feeSettlement";

const address = Keypair.generate().publicKey.toBase58();
const signed = (signature: string) => ({ signature, transactionBase64: "", blockhash: "block", lastValidBlockHeight: 1 });

function state(): FeeSettlementState {
  return {
    version: 1, projectMint: address, mint: address, creator: address,
    receipts: [
      { phase: "curve", state: "routed", collection: signed("old"), collectedRaw: "100" },
      { phase: "curve", state: "collected", collection: signed("uncommitted"), collectedRaw: "60" },
    ],
  };
}

describe("fee recovery boundary", () => {
  it("never treats absent RPC history after expiry as proof that funds were not sent", () => {
    expect(() => classifyFeeTransactionProgress([
      { status: null, height: 140 }, { status: null, height: 141 },
    ], 100)).toThrow("FEE_TRANSACTION_STATUS_UNRESOLVED");
    expect(classifyFeeTransactionProgress([
      { status: null, height: 100 }, { status: null, height: 99 },
    ], 100)).toBe("rebroadcast");
    expect(classifyFeeTransactionProgress([
      { status: { err: null }, height: 140 }, { status: null, height: 141 },
    ], 100)).toBe("waiting");
  });

  it("includes only collected and still-unrouted receipts", () => {
    expect(recoverableFeeAmount(state())).toBe(60n);
  });

  it("rejects recovery while a collection or route may still land", () => {
    const unsettled = state();
    unsettled.receipts.push({ phase: "curve", state: "collecting", collection: signed("pending") });
    expect(() => recoverableFeeAmount(unsettled)).toThrow("FEE_TRANSACTION_UNRESOLVED");
    unsettled.receipts.at(-1)!.state = "routing";
    expect(() => recoverableFeeAmount(unsettled)).toThrow("FEE_TRANSACTION_UNRESOLVED");
  });

  it("marks only uncommitted receipts accessible in the same creator/recovery wallet", () => {
    const ledger = state();
    expect(markSameWalletRecovered(ledger)).toBe(60n);
    expect(ledger.receipts.map((row) => row.state)).toEqual(["routed", "recovered"]);
    expect(() => markSameWalletRecovered(ledger)).toThrow("NO_UNCOMMITTED_FEES");
  });

  it("stops on a legacy expired receipt because missing RPC history cannot prove nonexecution", () => {
    const ledger = state();
    ledger.receipts.push({ phase: "pumpswap", state: "expired", collection: signed("unknown") });
    expect(() => recoverableFeeAmount(ledger)).toThrow("FEE_LEGACY_EXPIRED_UNRESOLVED");
  });
});
