import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { recoverableFeeAmount, type FeeSettlementState } from "./feeSettlement";

const address = Keypair.generate().publicKey.toBase58();
const signed = (signature: string) => ({ signature, transactionBase64: "", blockhash: "block", lastValidBlockHeight: 1 });

function state(): FeeSettlementState {
  return {
    version: 1, projectMint: address, mint: address, creator: address,
    receipts: [
      { phase: "curve", state: "routed", collection: signed("old"), collectedRaw: "100" },
      { phase: "curve", state: "collected", collection: signed("uncommitted"), collectedRaw: "60" },
      { phase: "pumpswap", state: "expired", collection: signed("expired") },
    ],
  };
}

describe("fee recovery boundary", () => {
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
});
