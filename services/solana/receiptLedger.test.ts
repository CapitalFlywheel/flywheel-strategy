import { describe, expect, it } from "vitest";
import { ReceiptLedger } from "./receiptLedger";

describe("finalized creator-fee ledger", () => {
  it("records a receipt once and preserves 60/40 totals", () => {
    const ledger = new ReceiptLedger();
    const receipt = { signature: "sig", instructionIndex: 1, slot: 9, blockhash: "hash", phase: "pump-curve" as const, creator: "creator", rawMstrx: 10_001n };
    ledger.record(receipt);
    ledger.record(receipt);
    expect(ledger.totals()).toEqual({ receivedRawMstrx: 10_001n, holderRawMstrx: 6_000n, reserveRawMstrx: 4_001n });
  });

  it("rejects conflicting replay data", () => {
    const ledger = new ReceiptLedger();
    ledger.record({ signature: "sig", instructionIndex: 0, slot: 1, blockhash: "a", phase: "pumpswap", creator: "c", rawMstrx: 5n });
    expect(() => ledger.record({ signature: "sig", instructionIndex: 0, slot: 1, blockhash: "b", phase: "pumpswap", creator: "c", rawMstrx: 5n })).toThrow("RECEIPT_CONFLICT");
  });
});
